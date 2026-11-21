// 1.9.0, the runaway-agent package, part 2: per-session caps. Budgets are per agent, per
// day or per month; nothing said "this one job may spend at most $2, make 200 calls, or
// run 30 minutes". `session_caps` in an agent's policy does, for each session a client
// declares (Claude Code, Codex, the sidecar's run). These are the pure halves.
import { describe, expect, it } from "vitest";

import { agentPolicyForDisplay, policyIsWellFormed, sessionCaps } from "@/lib/scope";
import { sessionCapMessage, sessionLedgerJti } from "@/lib/runaway";
// @ts-expect-error — plain .mjs CLI module, no types
import { formatProxyError } from "../cli/config.mjs";

describe("the session_caps policy key", () => {
  it("is off when absent", () => {
    expect(sessionCaps(null)).toBeNull();
    expect(sessionCaps({})).toBeNull();
    expect(agentPolicyForDisplay(null)).toMatchObject({ sessionCaps: null });
  });

  it("reads any one, two or all three caps; an absent one is null", () => {
    expect(sessionCaps({ session_caps: { cents: 200 } })).toEqual({ cents: 200, calls: null, minutes: null });
    expect(sessionCaps({ session_caps: { calls: 50, minutes: 30 } })).toEqual({ cents: null, calls: 50, minutes: 30 });
    expect(sessionCaps({ session_caps: { cents: 1, calls: 1, minutes: 1 } })).toEqual({ cents: 1, calls: 1, minutes: 1 });
    expect(agentPolicyForDisplay({ session_caps: { calls: 50 } })).toMatchObject({ valid: true, sessionCaps: { calls: 50 } });
  });

  it("accepts the upper bounds", () => {
    expect(policyIsWellFormed({ session_caps: { cents: 10_000_000, calls: 1_000_000, minutes: 1440 } })).toBe(true);
  });

  it.each([
    ["an empty object", {}],
    ["an unknown field", { calls: 5, dollars: 2 }],
    ["zero cents", { cents: 0 }],
    ["zero calls", { calls: 0 }],
    ["zero minutes", { minutes: 0 }],
    ["more than a day of minutes", { minutes: 1441 }],
    ["too many calls", { calls: 1_000_001 }],
    ["too many cents", { cents: 10_000_001 }],
    ["a fraction", { calls: 2.5 }],
    ["a string", { minutes: "30" }],
    ["a null cap", { calls: null }],
    ["a bare number", 5],
  ])("refuses %s as a malformed policy, never as off", (_label, session_caps) => {
    expect(policyIsWellFormed({ session_caps })).toBe(false);
    expect(sessionCaps({ session_caps })).toBeNull();
  });
});

describe("the session's money ledger id", () => {
  it("is a fixed-shape digest of the declared session, so any declared id makes a valid ledger key", async () => {
    const a = await sessionLedgerJti("01JABC.def:ghi-1");
    expect(a).toMatch(/^ses_[0-9a-f]{40}$/);
    expect(await sessionLedgerJti("01JABC.def:ghi-1")).toBe(a);
    expect(await sessionLedgerJti("other")).not.toBe(a);
  });
});

describe("what a person reads", () => {
  const caps = { cents: 250, calls: 200, minutes: 30 };
  it.each([
    ["calls", /200 calls/],
    ["minutes", /30 minutes/],
    ["cents", /\$2\.50/],
    ["sessions", /new sessions this hour/],
  ] as const)("the %s refusal names the cap and the session, and says what is not affected", (reason, pattern) => {
    const message = sessionCapMessage(reason, "sess-1", caps);
    expect(message).toMatch(pattern);
    if (reason !== "sessions") expect(message).toContain("sess-1");
    expect(message).toMatch(/not affected/);
  });

  it("the CLI explains blocked_session_cap, for the money cap and the others", () => {
    for (const status of [402, 403]) {
      const out = formatProxyError(status, JSON.stringify({ error: "blocked_session_cap", message: "m" }));
      expect(out).toMatch(/session's caps/i);
      expect(out).toMatch(/Fix: start a new session/);
      expect(out).not.toMatch(/check the agent scope/);
    }
  });
});
