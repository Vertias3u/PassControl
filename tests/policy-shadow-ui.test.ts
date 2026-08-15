// The dashboard write path and the panel for shadow mode.
//
// Shadow mode is diagnostics — the proxy hook is wrapped so it cannot fail a
// call, and a malformed draft is inert there. That posture is what makes the
// WRITE path the risky half of the feature, not the read path, and it is where
// these tests concentrate.
//
// What they exist to catch, in order of what it would cost:
//
//  1. PROMOTION OF A MALFORMED DRAFT. `policy_shadow` is reachable by SQL, and a
//     malformed value copied into `policy` is read by the gateway as
//     `policy:malformed` — which denies EVERY call for that agent. That is the
//     only path from a diagnostics feature to an outage.
//  2. An empty draft saved as `{}`. `parsePolicy({})` is well-formed and permits
//     everything, so `{}` leaves shadow mode ON, recording "allow" forever,
//     while the operator believes they turned it off. Inverted from fallbacks,
//     where `[]` is the value that means off.
//  3. Counts presented as calls, or as a census. They are attempts (one call
//     that failed over writes two rows carrying the same verdict) and a floor
//     (writeLog is best-effort).
//  4. A malformed draft rendered as a strict one. It records "would block" on
//     every attempt — by the numbers alone, identical to a draft that works.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  shadowRevision,
  stampShadowVerdict,
  summariseShadowDivergence,
  toShadowState,
} from "@/lib/policy-shadow";
import { validatePolicy } from "@/lib/validate";
import { policyIsWellFormed, POLICY_DAYS } from "@/lib/scope";
import { summariseChange } from "@/lib/audit-history";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const actions = read("app/dashboard/agents/[id]/shadow-actions.ts");
const ui = read("components/PolicyShadowPanel.tsx");

const fn = (name: string) => {
  const at = actions.indexOf(`export async function ${name}`);
  expect(at, `${name} is missing`).toBeGreaterThan(-1);
  const rest = actions.slice(at);
  const next = rest.indexOf("\nexport async function ", 1);
  return next === -1 ? rest : rest.slice(0, next);
};

const NAMES = ["saveAgentPolicyShadow", "promoteAgentPolicyShadow"];

describe("the server actions", () => {
  it("runs on the server", () => {
    expect(actions.startsWith('"use server"')).toBe(true);
  });

  it.each(NAMES)("exports %s", (name) => {
    expect(actions).toMatch(new RegExp(`export async function ${name}`));
  });

  // The tenant boundary. An action taking a userId would let the caller choose
  // whose policy to rewrite — and policy is what decides calls.
  it.each(NAMES)("derives the acting user from the session, never from an argument", (name) => {
    const body = fn(name);
    const signature = body.slice(0, body.indexOf(")"));
    expect(signature).not.toMatch(/userId/);
    expect(body).toMatch(/await actingUser\(\)/);
    expect(body).toMatch(/"error" in acting/);
  });

  /**
   * A server action is addressable over HTTP by its id, so the redirect in
   * page.tsx protects the PAGE, not these. The read-only decision trace on the
   * same page requires step-up; the control that changes what the gateway
   * actually does must not require less.
   */
  it("gates the shared session helper on MFA step-up", () => {
    const helper = actions.slice(actions.indexOf("async function actingUser"));
    const body = helper.slice(0, helper.indexOf("\n}\n"));
    expect(body).toMatch(/mfaAuthorizedUser/);
    expect(body).not.toMatch(/needsMfaStepUp/);
  });

  // Migration 0020 grants `authenticated` no UPDATE on either column, so the
  // service-role client is required — which means the tenant filter is the only
  // thing standing between a caller and another tenant's agent.
  it.each(NAMES)("%s filters the write by user_id as well as agent id", (name) => {
    const body = fn(name);
    expect(body).toMatch(/serviceClient\(\)/);
    expect(body).toMatch(/\.eq\("user_id", acting\.userId\)/);
    expect(body).toMatch(/\.eq\("id", agentId\)/);
  });

  it.each(NAMES)("%s purges the policy cache so the change is not sat on", (name) => {
    expect(fn(name)).toMatch(/purgeAgentPolicy/);
  });

  it.each(NAMES)("%s records an audit row", (name) => {
    const body = fn(name);
    expect(body).toMatch(/recordAdminAction/);
    expect(body).toMatch(/"agent\.update"/);
    expect(body).toMatch(/via: "dashboard"/);
  });

  // ── 1. The outage path ────────────────────────────────────────────────────
  //
  // Confirmed load-bearing by mutation: deleting the validatePolicy call from
  // promoteAgentPolicyShadow turns this red.
  it("re-validates the draft at the moment it becomes the thing that decides", () => {
    const body = fn("promoteAgentPolicyShadow");
    expect(body).toMatch(/validatePolicy\(draft\)/);
    // Order matters: the check must precede the update, not follow it.
    expect(body.indexOf("validatePolicy(draft)")).toBeLessThan(body.indexOf(".update("));
  });

  it("promotes in one write, and does not leave the draft pending", () => {
    const body = fn("promoteAgentPolicyShadow");
    expect(body).toMatch(/\.update\(\{ policy: draft, policy_shadow: null \}\)/);
    // One .update call, so there is never a moment where the draft is live and
    // also still pending, or cleared without having been promoted.
    expect(body.match(/\.update\(/g) ?? []).toHaveLength(1);
  });

  it("refuses to promote when there is no draft", () => {
    expect(fn("promoteAgentPolicyShadow")).toMatch(/draft === null/);
  });

  // The live policy is READ before the write so the audit row can answer "what
  // was enforcement before this". Without it the one row that explains why
  // calls started being denied says only that something changed.
  it("records what the live policy was before promotion", () => {
    const body = fn("promoteAgentPolicyShadow");
    expect(body).toMatch(/select\("policy, policy_shadow"\)/);
    expect(body).toMatch(/from: JSON\.stringify\(row\.policy/);
  });

  it("validates a draft before saving it, even though nothing acts on it", () => {
    expect(fn("saveAgentPolicyShadow")).toMatch(/validatePolicy\(normaliseDraft\(draft\)\)/);
  });
});

// ── 2. Empty means off, and off is null ─────────────────────────────────────
describe("an empty draft is null, never {}", () => {
  it("is well-formed as {} — which is exactly why {} must not be saved", () => {
    // The trap, stated as a test: {} passes validation and permits everything.
    expect(policyIsWellFormed({})).toBe(true);
    expect(validatePolicy({})).toEqual({});
  });

  it("normalises an empty object to null on the server", () => {
    const body = actions.slice(actions.indexOf("function normaliseDraft"));
    expect(body).toMatch(/Object\.keys/);
    expect(body).toMatch(/\.length === 0 \? null/);
  });

  it("normalises in the form too, so the button can say what it will do", () => {
    expect(ui).toMatch(/Object\.keys\(policy\)\.length === 0 \? null/);
    expect(ui).toMatch(/turns shadow mode off/i);
  });

  it("treats null as shadow mode off", () => {
    expect(toShadowState(null, []).draft).toBeNull();
    expect(toShadowState(null, []).wellFormed).toBe(true);
  });
});

// ── 3. The counts ───────────────────────────────────────────────────────────
describe("summariseShadowDivergence", () => {
  const row = (would: string | null, status: string) => ({
    policy_shadow_would: would,
    status,
  });

  it("counts a draft that would block what the live policy let past", () => {
    const d = summariseShadowDivergence([row("deny:policy", "ok")]);
    expect(d).toMatchObject({ considered: 1, wouldBlock: 1, wouldAllow: 0, agreed: 0 });
  });

  it("counts a draft that would allow what the live policy blocked", () => {
    const d = summariseShadowDivergence([row("allow", "blocked_policy")]);
    expect(d).toMatchObject({ considered: 1, wouldBlock: 0, wouldAllow: 1, agreed: 0 });
  });

  it.each([
    ["allow", "ok"],
    ["deny:policy", "blocked_policy"],
  ])("counts %s against %s as agreement", (would, status) => {
    expect(summariseShadowDivergence([row(would, status)])).toMatchObject({ agreed: 1 });
  });

  /**
   * The live policy is what stopped an attempt if and only if the status says
   * `blocked_policy`. Every other blocked status means the attempt got PAST the
   * policy step and was stopped by something else — so a draft that denies it is
   * still a real divergence at the step the draft governs.
   */
  it.each(["blocked_budget", "upstream_error", "provider_exhausted"])(
    "treats %s as having passed the live policy step",
    (status) => {
      expect(summariseShadowDivergence([row("deny:policy", status)])).toMatchObject({
        wouldBlock: 1,
        agreed: 0,
      });
    }
  );

  it("excludes rows with no verdict, and says the sample was partial", () => {
    const d = summariseShadowDivergence([row(null, "ok"), row("allow", "ok")]);
    expect(d.considered).toBe(1);
    expect(d.partial).toBe(true);
  });

  it("does not claim a partial sample when every row was measured", () => {
    expect(summariseShadowDivergence([row("allow", "ok")]).partial).toBe(false);
  });

  it.each([null, undefined, "nope", 7, [null], [{}], ["x"]])(
    "survives junk (%s) rather than taking the page down",
    (input) => {
      expect(() => summariseShadowDivergence(input)).not.toThrow();
      expect(summariseShadowDivergence(input).considered).toBe(0);
    }
  );

  it("ignores a verdict string it does not recognise", () => {
    expect(summariseShadowDivergence([row("deny:budget", "ok")]).considered).toBe(0);
  });

  /**
   * The 2× that would otherwise be silent: the proxy computes the shadow verdict
   * ONCE per call and stamps it on every attempt row, so a call that failed over
   * contributes 2. That is correct for a per-attempt count and wrong for a
   * per-call one, which is why every label says attempts.
   */
  /**
   * The counts name a specific draft, and agent_logs cannot tell one draft's
   * verdicts from another's — the column records the verdict, not what produced
   * it. Without a cutoff the intended workflow breaks on its SECOND iteration:
   * save a strict draft, run traffic, soften it, and the soft draft wears the
   * strict one's blocks. That is not misleading-but-true; it is false about the
   * thing it names.
   */
  it("excludes attempts measured against an earlier draft", () => {
    const rows = [
      { policy_shadow_would: "deny:policy", status: "ok", created_at: "2026-08-07T09:00:00Z" },
      { policy_shadow_would: "allow", status: "ok", created_at: "2026-08-07T11:00:00Z" },
    ];
    const d = summariseShadowDivergence(rows, "2026-08-07T10:00:00Z");
    expect(d.considered).toBe(1);
    expect(d.wouldBlock).toBe(0); // the old draft's block does not carry over
    expect(d.agreed).toBe(1);
    expect(d.partial).toBe(true);
  });

  it("counts an attempt recorded at the moment the draft was saved", () => {
    const rows = [
      { policy_shadow_would: "allow", status: "ok", created_at: "2026-08-07T10:00:00Z" },
    ];
    expect(summariseShadowDivergence(rows, "2026-08-07T10:00:00Z").considered).toBe(1);
  });

  it("drops a row it cannot date rather than assuming it is recent", () => {
    const rows = [{ policy_shadow_would: "deny:policy", status: "ok", created_at: null }];
    expect(summariseShadowDivergence(rows, "2026-08-07T10:00:00Z").considered).toBe(0);
  });

  it("counts everything when there is no cutoff to apply", () => {
    const rows = [
      { policy_shadow_would: "deny:policy", status: "ok", created_at: "2020-01-01T00:00:00Z" },
    ];
    for (const since of [null, undefined, "", "not-a-date"]) {
      expect(summariseShadowDivergence(rows, since).considered, String(since)).toBe(1);
    }
  });

  it("counts a failed-over call once per attempt", () => {
    const d = summariseShadowDivergence([
      row("deny:policy", "upstream_error"), // first provider
      row("deny:policy", "ok"), // the fallback that worked
    ]);
    expect(d.considered).toBe(2);
    expect(d.wouldBlock).toBe(2);
  });
});

describe("the panel", () => {
  it("is rendered on the agent page", () => {
    expect(read("app/dashboard/agents/[id]/page.tsx")).toMatch(/<PolicyShadowPanel/);
  });

  // ── 4. A broken draft is not a strict draft ───────────────────────────────
  it("announces a malformed draft and suppresses the counts while it holds", () => {
    expect(ui).toMatch(/data-state="malformed"/);
    expect(ui).toMatch(/not a policy the gateway can read/i);
    // The malformed branch is the FIRST arm of the chain that ends in <Counts>,
    // so <Counts> is unreachable while a draft is unreadable. Asserted by order
    // rather than by matching one exact JSX shape, which would fail on a
    // reformat that changed nothing about the behaviour.
    const malformed = ui.indexOf('data-state="malformed"');
    const counts = ui.indexOf("<Counts shadow");
    expect(malformed).toBeGreaterThan(-1);
    expect(counts).toBeGreaterThan(malformed);
    expect(ui).toMatch(/active && !shadow\.wellFormed \?/);
  });

  it("does not offer to promote a draft the gateway cannot read", () => {
    const promote = ui.slice(ui.indexOf("Promote to live policy") - 400);
    expect(promote.slice(0, 400)).toMatch(/shadow\.wellFormed/);
  });

  it("says the counts are attempts, not calls", () => {
    expect(ui).toMatch(/attempts/);
    expect(ui).toMatch(/failed over.*recorded once per provider/is);
  });

  it("says the counts are a floor", () => {
    expect(ui).toMatch(/floor/i);
    expect(ui).toMatch(/best-effort/i);
  });

  it("states that the draft decides nothing", () => {
    expect(ui).toMatch(/decides nothing/i);
  });

  it("states what promoting does to live traffic, and that shadow mode ends", () => {
    const copy = ui.slice(ui.indexOf("Promoting makes this exact draft"));
    expect(copy).toMatch(/decides calls/);
    expect(copy).toMatch(/ends shadow mode/);
  });

  // Retyping the rule is the thing promotion exists to prevent. The copy has to
  // say so, or an operator has no reason to use the button over the editor.
  it("says it is the tested draft itself that is promoted", () => {
    expect(ui).toMatch(/never a retyped copy/i);
  });

  // Same rule as validateFallbacks importing MAX_FALLBACKS: a form offering a
  // day the parser rejects lets an operator save a window read as malformed.
  it("offers exactly the days the parser accepts, imported rather than typed", () => {
    expect(ui).toMatch(/POLICY_DAYS/);
    expect(ui).not.toMatch(/"sun".*"mon".*"tue"/);
    expect(POLICY_DAYS).toHaveLength(7);
  });

  it("distinguishes off from running", () => {
    expect(ui).toMatch(/data-state=\{active \?/);
    expect(ui).toMatch(/data-state="no-observations"/);
  });

  // The assumption the whole panel rests on: the numbers describe the draft
  // shown above them. That holds because each verdict is stamped with the
  // revision of the draft that produced it, so the panel names the revision.
  it("says which draft the numbers are about", () => {
    expect(ui).toMatch(/data-state="dated"/);
    expect(ui).toMatch(/Measured against this draft/);
    expect(ui).toMatch(/shadow\.revision/);
  });

  /**
   * This assertion used to be about a MISSING save timestamp, and its copy said
   * the numbers "may not be about the draft above". That is no longer true —
   * attribution is by revision now, not by clock — so the warning was re-pointed
   * at the failure that is still real: a verdict carrying no revision, or one
   * from a different draft, cannot be counted and must not be silently dropped.
   */
  it("warns when recorded attempts could not be attributed to this draft", () => {
    expect(ui).toMatch(/data-state="unattributed"/);
    expect(ui).toMatch(/not counted above/i);
    expect(ui).toMatch(/divergence\.partial \?/);
    // And says why, rather than letting an operator read the gap as agreement.
    expect(ui).toMatch(/not because\s*\n?\s*they agreed/i);
  });

  // Finding 12: the button must send the revision the page rendered, or
  // "promote what I reviewed" degrades to "promote whatever is there now".
  it("binds Promote to the revision the numbers were measured under", () => {
    expect(ui).toMatch(/promoteAgentPolicyShadow\(agentId, shadow\.revision/);
  });
});

// ── Which draft a verdict belongs to ────────────────────────────────────────
//
// A timestamp cutoff is not proof of authorship. A streaming request that read
// draft A can stay open across a save and insert A's verdict AFTER draft B's
// cutoff; a cache miss that began before the purge can hand A's document to a
// call that finishes later still. Both land inside the window and are counted
// as B's evidence. The fix is to stamp the verdict with a revision of the draft
// that produced it and count only the stamps that match.
describe("verdicts are attributed by revision, not by when they landed", () => {
  const CURRENT = { deny: [{ provider: "openai", models: ["*"] }] };
  const OTHER = { deny: [{ provider: "groq", models: ["*"] }] };

  it("does not count a verdict from a different draft that landed inside the window", () => {
    const rows = [
      {
        // Draft OTHER's verdict, inserted after CURRENT was saved because the
        // request that computed it was still streaming.
        policy_shadow_would: stampShadowVerdict("deny:policy", shadowRevision(OTHER)),
        status: "ok",
        created_at: "2026-08-07T11:00:00Z",
      },
    ];
    const state = toShadowState(CURRENT, rows, "2026-08-07T10:00:00Z");
    expect(state.divergence.considered).toBe(0);
    expect(state.divergence.partial).toBe(true);
  });

  it("counts a verdict stamped with this draft's revision", () => {
    const rows = [
      {
        policy_shadow_would: stampShadowVerdict("deny:policy", shadowRevision(CURRENT)),
        status: "ok",
        created_at: "2026-08-07T11:00:00Z",
      },
    ];
    const state = toShadowState(CURRENT, rows, "2026-08-07T10:00:00Z");
    expect(state.divergence).toMatchObject({ considered: 1, wouldBlock: 1, partial: false });
  });

  // A row written before verdicts carried a revision cannot be attributed to
  // anything. Counting it is the finding, so it is excluded and the sample says
  // it is partial.
  it("does not count a verdict that carries no revision at all", () => {
    const rows = [
      { policy_shadow_would: "deny:policy", status: "ok", created_at: "2026-08-07T11:00:00Z" },
    ];
    const state = toShadowState(CURRENT, rows, "2026-08-07T10:00:00Z");
    expect(state.divergence.considered).toBe(0);
    expect(state.divergence.partial).toBe(true);
  });

  it("exposes the revision so the panel can bind promotion to it", () => {
    expect(toShadowState(CURRENT, []).revision).toBe(shadowRevision(CURRENT));
    expect(toShadowState(null, []).revision).toBeNull();
  });

  // Key order is not part of a policy: `agents.policy_shadow` is jsonb, which
  // does not preserve it. A revision that changed with key order would report a
  // conflict on a draft nobody edited.
  it("is stable across key order and distinct across content", () => {
    expect(shadowRevision({ deny: [], max_requests_per_hour: 5 })).toBe(
      shadowRevision({ max_requests_per_hour: 5, deny: [] })
    );
    expect(shadowRevision({ max_requests_per_hour: 5 })).not.toBe(
      shadowRevision({ max_requests_per_hour: 6 })
    );
  });

  // It runs on the credential path, inside the shadow evaluation. A throw there
  // is a 500 on a proxied call; a null degrades to "unstamped", which is
  // already handled.
  it("never throws, whatever it is handed", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, undefined, NaN, () => {}, Symbol("x")]) {
      expect(() => shadowRevision(value)).not.toThrow();
    }
  });
});

describe("toShadowState carries the cutoff", () => {
  const rows = [
    {
      policy_shadow_would: stampShadowVerdict("deny:policy", shadowRevision({ deny: [] })),
      status: "ok",
      created_at: "2026-08-07T09:00:00Z",
    },
  ];

  it("reports when the current draft began", () => {
    const state = toShadowState({ deny: [] }, rows, "2026-08-07T08:00:00Z");
    expect(state.since).toBe("2026-08-07T08:00:00Z");
    expect(state.divergence.considered).toBe(1);
  });

  it.each([null, "", "not-a-date"])("reports %s as undatable", (since) => {
    const state = toShadowState({ deny: [] }, rows, since as never);
    expect(state.since).toBeNull();
  });

  it("defaults to undated rather than silently claiming a cutoff", () => {
    expect(toShadowState({ deny: [] }, rows).since).toBeNull();
  });
});

// ── The Amendments panel has to be able to read these rows ──────────────────
describe("capability history renders the new rows", () => {
  const row = (fields: string, from: unknown, to: unknown, extra = {}) => ({
    id: "a1",
    action: "agent.update",
    created_at: "2026-08-07T10:00:00Z",
    metadata: {
      fields,
      via: "dashboard",
      from: JSON.stringify(from),
      to: JSON.stringify(to),
      ...extra,
    },
  });

  it("reads a draft being turned on as changing nothing about enforcement", () => {
    const change = summariseChange(row("policy_shadow", null, { deny: [] }));
    expect(change?.summary).toMatch(/Shadow mode turned on/);
    expect(change?.summary).toMatch(/Nothing about enforcement changed/);
    expect(change?.recorded).toBe(true);
  });

  it("reads a cleared draft as shadow mode off", () => {
    expect(summariseChange(row("policy_shadow", { deny: [] }, null))?.summary).toMatch(
      /Shadow mode turned off/
    );
  });

  it("distinguishes a promotion from a plain policy write", () => {
    const promoted = summariseChange(
      row("policy", null, { max_requests_per_hour: 10 }, { promoted: true })
    );
    expect(promoted?.summary).toMatch(/promoted/i);
    const direct = summariseChange(row("policy", null, { max_requests_per_hour: 10 }));
    expect(direct?.summary).toMatch(/^Policy changed\.$/);
  });

  /**
   * `recorded: false` renders copy claiming the row predates the from/to
   * record. For a row these writers created that is a false statement about the
   * audit trail — on the one panel whose only job is being trustworthy about
   * the past.
   */
  it("never claims a row it just wrote predates the record", () => {
    for (const fields of ["policy", "policy_shadow"]) {
      expect(summariseChange(row(fields, null, { deny: [] }))?.recorded, fields).toBe(true);
    }
  });

  it("describes the shape of the change without re-implementing the grammar", () => {
    const change = summariseChange(
      row("policy", { deny: [{ provider: "openai", models: ["*"] }] }, { max_requests_per_hour: 5 })
    );
    expect(change?.detail).toContain("deny rules: 1 → 0");
    expect(change?.detail).toContain("hourly cap: none → 5");
  });

  it("does not report 'no change' for a rewrite that kept the counts", () => {
    const change = summariseChange(
      row(
        "policy",
        { deny: [{ provider: "openai", models: ["gpt-4"] }] },
        { deny: [{ provider: "openai", models: ["gpt-5"] }] }
      )
    );
    expect(change?.detail?.length).toBeGreaterThan(0);
  });

  it("admits when a previous value was not recorded", () => {
    const change = summariseChange({
      id: "a1",
      action: "agent.update",
      created_at: "2026-08-07T10:00:00Z",
      metadata: { fields: "policy", via: "dashboard" },
    });
    expect(change?.recorded).toBe(false);
    expect(change?.summary).toMatch(/not recorded/);
  });
});
