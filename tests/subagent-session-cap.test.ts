// C(b): the policy key `subagent_session_cap_cents` (owner, 2026-10-10). Read by the
// same parser as every other policy key, so the write-side validator and the gateway
// agree on it (policyIsWellFormed). The money side is tests/holds-subagent.redis.test.ts;
// the route side is in tests/proxy-endpoint.test.ts.
import { describe, expect, it } from "vitest";
import { agentPolicyForDisplay, policyIsWellFormed, subagentSessionCapCents } from "@/lib/scope";

describe("subagent_session_cap_cents", () => {
  it.each([0, 1, 500, 100_000])("accepts %s cents", (cents) => {
    expect(policyIsWellFormed({ subagent_session_cap_cents: cents })).toBe(true);
    expect(subagentSessionCapCents({ subagent_session_cap_cents: cents })).toBe(cents);
  });

  it.each([-1, 1.5, "500", null, Number.NaN, 10_000_001])("refuses %s as malformed policy", (cents) => {
    expect(policyIsWellFormed({ subagent_session_cap_cents: cents })).toBe(false);
  });

  it("is null when the key is absent or the policy is not one", () => {
    expect(subagentSessionCapCents({})).toBeNull();
    expect(subagentSessionCapCents(null)).toBeNull();
    expect(subagentSessionCapCents({ subagent_session_cap_cents: "x" })).toBeNull();
  });

  it("sits beside the other policy keys", () => {
    expect(policyIsWellFormed({ subagent_models: [{ provider: "anthropic", models: ["claude-haiku-*"] }], subagent_session_cap_cents: 200 })).toBe(true);
  });

  it("is shown to the owner", () => {
    expect(agentPolicyForDisplay({ subagent_session_cap_cents: 250 })).toMatchObject({ subagentSessionCapCents: 250 });
  });
});
