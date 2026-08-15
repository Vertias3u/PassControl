// Promotion, driven through the real server action rather than grepped for.
//
// tests/policy-shadow-ui.test.ts asserts that the guard is PRESENT in the
// source. That is worth having — it goes red the moment someone deletes the
// call — but it cannot answer the question that matters: when a malformed draft
// is planted by SQL and promotion is attempted, does `policy` survive?
//
// This file answers it by calling the action and asserting on what reached the
// database. A guard that is present but reached after the update, or that
// catches and continues, passes the grep and fails here.
//
// ── Why the malformed case is the one to spend a mock harness on ────────────
//
// `parsePolicy` rejects the whole document on any violation, so a malformed
// value in `policy` is read by the gateway as `policy:malformed` and DENIES
// EVERY CALL for that agent until someone notices. Shadow mode is otherwise
// incapable of affecting traffic — the proxy hook is wrapped so it cannot even
// throw. Promotion is the single place where a diagnostics feature touches
// enforcement, so it is the single place worth this much scaffolding.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── The agents row, and a record of every write attempted against it ─────────
let row: Record<string, unknown> = {};
const updates: Record<string, unknown>[] = [];
/** Every filter the write was narrowed by, so a compare-and-swap is provable. */
const updateFilters: [string, unknown][] = [];
let updateError: unknown = null;
/**
 * What the row's `policy_shadow` is at the moment of the WRITE, which is not
 * necessarily what it was at the moment of the read. Setting this simulates a
 * save landing in between — the case the compare-and-swap exists for.
 */
let shadowAtWrite: unknown = undefined;

const builder = () => {
  let writing = false;
  const b: any = {
    select: () => b,
    eq: (column: string, value: unknown) => {
      if (writing) updateFilters.push([column, value]);
      return b;
    },
    update: (patch: Record<string, unknown>) => {
      writing = true;
      updates.push(patch);
      return b;
    },
    maybeSingle: async () => {
      if (!writing) return { data: row, error: null };
      if (updateError) return { data: null, error: updateError };
      // Postgres decides `policy_shadow = <expected>` against the row as it is
      // NOW. Zero rows means the draft moved under the write.
      const expected = updateFilters.find(([column]) => column === "policy_shadow")?.[1];
      const current =
        shadowAtWrite === undefined
          ? (row as { policy_shadow?: unknown })?.policy_shadow
          : shadowAtWrite;
      const matched =
        expected === undefined || JSON.stringify(current ?? null) === expected;
      return { data: matched ? { id: "ag1" } : null, error: null };
    },
  };
  return b;
};

vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ from: () => builder() }) }));

// The session half. Both are overridable per test so the auth gates can be
// exercised on the real action rather than asserted about in the abstract.
let sessionUser: { id: string } | null = { id: "11111111-1111-1111-1111-111111111111" };
let stepUp = false;
vi.mock("@/lib/supabase/server", () => ({
  userClient: async () => ({ auth: { getUser: async () => ({ data: { user: sessionUser } }) } }),
}));
vi.mock("@/lib/mfa", () => ({
  mfaAuthorizedUser: async () =>
    !sessionUser
      ? { ok: false, reason: "unauthenticated" }
      : stepUp
        ? { ok: false, reason: "step_up_required" }
        : { ok: true, user: sessionUser },
}));

const purge = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/state/redis", () => ({ purgeAgentPolicy: (...a: unknown[]) => purge(...a) }));

const audit = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => audit(...a) }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  promoteAgentPolicyShadow,
  saveAgentPolicyShadow,
} from "@/app/dashboard/agents/[id]/shadow-actions";
import { shadowRevision } from "@/lib/policy-shadow";

const AGENT = "22222222-2222-2222-2222-222222222222";
const LIVE = { deny: [{ provider: "openai", models: ["gpt-3.5*"] }] };
/** A second valid draft, for the "another tab saved something else" case. */
const OTHER_DRAFT = { max_requests_per_hour: 7 };
/** What the page rendered for the draft currently in `row`. */
const reviewed = () => shadowRevision((row as { policy_shadow?: unknown }).policy_shadow) ?? "";

beforeEach(() => {
  updates.length = 0;
  updateFilters.length = 0;
  shadowAtWrite = undefined;
  updateError = null;
  sessionUser = { id: "11111111-1111-1111-1111-111111111111" };
  stepUp = false;
  purge.mockClear();
  audit.mockClear();
  row = { policy: LIVE, policy_shadow: null };
});

describe("promoting a malformed draft", () => {
  // Every one of these is well-formed JSON and rejected by parsePolicy, which is
  // exactly the population that reaches the column by SQL rather than the form.
  const malformed = [
    ["an unknown top-level key", { deny: [], allow: [] }],
    ["a deny rule with no models", { deny: [{ provider: "openai" }] }],
    ["a window that wraps midnight", { windows: [{ days: ["mon"], start: "22:00", end: "02:00", tz: "UTC" }] }],
    ["a non-UTC window", { windows: [{ days: ["mon"], start: "09:00", end: "17:00", tz: "CET" }] }],
    ["a zero hourly cap", { max_requests_per_hour: 0 }],
    ["a fractional hourly cap", { max_requests_per_hour: 1.5 }],
    ["a day name the parser rejects", { windows: [{ days: ["monday"], start: "09:00", end: "17:00", tz: "UTC" }] }],
  ] as const;

  it.each(malformed)("refuses %s, and leaves the live policy untouched", async (_label, draft) => {
    row = { policy: LIVE, policy_shadow: draft };

    const result = await promoteAgentPolicyShadow(AGENT, reviewed());

    expect(result.error).toMatch(/block every call/);
    expect(result.ok).toBeUndefined();
    // The assertion the grep cannot make: nothing was written at all.
    expect(updates).toHaveLength(0);
  });

  it("does not record an audit row for a promotion that did not happen", async () => {
    row = { policy: LIVE, policy_shadow: { deny: [], allow: [] } };
    await promoteAgentPolicyShadow(AGENT, reviewed());
    expect(audit).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });
});

describe("promoting a well-formed draft", () => {
  const DRAFT = { deny: [{ provider: "openai", models: ["*"] }], max_requests_per_hour: 100 };

  it("writes the draft into policy and clears the shadow in ONE update", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };

    const result = await promoteAgentPolicyShadow(AGENT, reviewed());

    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ policy: DRAFT, policy_shadow: null });
  });

  /**
   * The whole reason Promote exists. If the action rebuilt the document instead
   * of copying it, enforcement could differ from what the panel's numbers
   * describe — which is the failure the feature is meant to prevent.
   */
  it("promotes the draft object itself, not a reconstruction of it", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };
    await promoteAgentPolicyShadow(AGENT, reviewed());
    expect(updates[0]?.policy).toBe(DRAFT);
  });

  it("purges the policy cache, because enforcement just changed", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };
    await promoteAgentPolicyShadow(AGENT, reviewed());
    expect(purge).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", AGENT);
  });

  it("records what enforcement was before, not only what it became", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };
    await promoteAgentPolicyShadow(AGENT, reviewed());
    const entry = audit.mock.calls[0]?.[0] as {
      action: string;
      metadata: { fields: string; promoted: boolean; from: string; to: string };
    };
    expect(entry.action).toBe("agent.update");
    expect(entry.metadata.fields).toBe("policy");
    expect(entry.metadata.promoted).toBe(true);
    expect(JSON.parse(entry.metadata.from)).toEqual(LIVE);
    expect(JSON.parse(entry.metadata.to)).toEqual(DRAFT);
  });

  // ── Finding 12: promotion must ship the draft that was REVIEWED ───────────
  //
  // The panel's numbers describe one specific document. Promotion takes only an
  // agent id and re-reads whatever is current, so an operator who reviewed A
  // while another tab saved B ships B — and is told it succeeded. The revision
  // the page rendered is what binds the two together.
  it("refuses to promote when the draft changed since the page was rendered", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };

    const result = await promoteAgentPolicyShadow(AGENT, shadowRevision(OTHER_DRAFT)!);

    expect(result.ok).toBeUndefined();
    expect(result.error).toMatch(/changed/i);
    expect(updates).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it("promotes when the revision matches what was reviewed", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };

    const result = await promoteAgentPolicyShadow(AGENT, shadowRevision(DRAFT)!);

    expect(result.ok).toBe(true);
    expect(updates).toEqual([{ policy: DRAFT, policy_shadow: null }]);
  });

  // A caller that supplies nothing must not be treated as a caller that agrees
  // with everything. A server action is addressable over HTTP by its id.
  it.each(["", "not-a-revision", "0000000000000000"])(
    "refuses the expected revision %j",
    async (expected) => {
      row = { policy: LIVE, policy_shadow: DRAFT };
      const result = await promoteAgentPolicyShadow(AGENT, expected);
      expect(result.ok).toBeUndefined();
      expect(updates).toHaveLength(0);
    }
  );

  it("refuses a caller that supplies no revision at all", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };
    const result = await promoteAgentPolicyShadow(AGENT, undefined as unknown as string);
    expect(result.ok).toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  /**
   * The second half of finding 12. The revision check runs against the READ, so
   * a save landing between that read and the write would still install the old
   * draft and destroy the new one — both reported as success. The update carries
   * the observed draft as a filter, so Postgres matches zero rows instead.
   */
  it("writes nothing when the draft moves between the read and the write", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };
    shadowAtWrite = OTHER_DRAFT;

    const result = await promoteAgentPolicyShadow(AGENT, reviewed());

    expect(result.ok).toBeUndefined();
    expect(result.error).toMatch(/changed while it was being promoted/i);
    // The audit trail must not claim a promotion that did not land.
    expect(audit).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it("narrows the write by the exact draft it read", async () => {
    row = { policy: LIVE, policy_shadow: DRAFT };
    await promoteAgentPolicyShadow(AGENT, reviewed());
    expect(updateFilters).toContainEqual(["policy_shadow", JSON.stringify(DRAFT)]);
    expect(updateFilters).toContainEqual(["user_id", "11111111-1111-1111-1111-111111111111"]);
    expect(updateFilters).toContainEqual(["id", AGENT]);
  });

  it("refuses when there is no draft to promote", async () => {
    row = { policy: LIVE, policy_shadow: null };
    const result = await promoteAgentPolicyShadow(AGENT, "");
    expect(result.error).toMatch(/no draft policy/i);
    expect(updates).toHaveLength(0);
  });

  // A row that does not belong to this tenant comes back null from the filtered
  // read, and must not be reported as anything more specific than unavailable.
  it("refuses an agent the tenant does not own", async () => {
    row = null as never;
    const result = await promoteAgentPolicyShadow(AGENT, "");
    expect(result.error).toBe("This agent is unavailable.");
    expect(updates).toHaveLength(0);
  });
});

describe("the auth gates, on the real actions", () => {
  const drafted = { deny: [{ provider: "openai", models: ["*"] }] };

  it.each([
    ["promote", () => promoteAgentPolicyShadow(AGENT, shadowRevision(drafted)!)],
    ["save", () => saveAgentPolicyShadow(AGENT, drafted)],
  ])("%s refuses an unauthenticated caller before touching the database", async (_l, call) => {
    row = { policy: LIVE, policy_shadow: drafted };
    sessionUser = null;
    const result = await call();
    expect(result.error).toMatch(/sign in/i);
    expect(updates).toHaveLength(0);
  });

  /**
   * A server action is addressable over HTTP by its id, so the redirect on the
   * page protects the page and not this. The read-only decision trace on the
   * same page requires step-up; the control that changes what the gateway does
   * must not require less.
   */
  it.each([
    ["promote", () => promoteAgentPolicyShadow(AGENT, shadowRevision(drafted)!)],
    ["save", () => saveAgentPolicyShadow(AGENT, drafted)],
  ])("%s refuses a caller who has not cleared MFA step-up", async (_l, call) => {
    row = { policy: LIVE, policy_shadow: drafted };
    stepUp = true;
    const result = await call();
    expect(result.error).toMatch(/two-factor/i);
    expect(updates).toHaveLength(0);
  });

  it.each([
    ["promote", (id: string) => promoteAgentPolicyShadow(id, shadowRevision(drafted)!)],
    ["save", (id: string) => saveAgentPolicyShadow(id, drafted)],
  ])("%s refuses an agent id that is not a uuid", async (_l, call) => {
    const result = await call("not-a-uuid");
    expect(result.error).toBe("This agent is unavailable.");
    expect(updates).toHaveLength(0);
  });
});

describe("saving a draft", () => {
  it("stores a well-formed draft", async () => {
    const draft = { max_requests_per_hour: 25 };
    const result = await saveAgentPolicyShadow(AGENT, draft);
    expect(result.ok).toBe(true);
    expect(updates).toEqual([{ policy_shadow: draft }]);
  });

  /**
   * `{}` is WELL-FORMED and permits everything, so storing it would leave shadow
   * mode on — recording "allow" against every attempt forever — while the
   * operator believes they switched it off. Inverted from fallbacks, where `[]`
   * is the value that means off.
   */
  it.each([
    ["an empty object", {}],
    ["null", null],
    ["undefined", undefined],
  ])("stores %s as null, which is what turns shadow mode off", async (_l, draft) => {
    const result = await saveAgentPolicyShadow(AGENT, draft);
    expect(result.ok).toBe(true);
    expect(updates).toEqual([{ policy_shadow: null }]);
  });

  it("refuses a malformed draft at the form rather than storing an inert one", async () => {
    const result = await saveAgentPolicyShadow(AGENT, { deny: "everything" });
    expect(result.error).toMatch(/not valid/i);
    expect(updates).toHaveLength(0);
  });

  it("does not report success when the write failed", async () => {
    updateError = { code: "23514" };
    const result = await saveAgentPolicyShadow(AGENT, { max_requests_per_hour: 5 });
    expect(result.ok).toBeUndefined();
    expect(result.error).toBeTruthy();
    // The database code never reaches the operator.
    expect(result.error).not.toMatch(/23514/);
  });
});
