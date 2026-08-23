import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Mock the side-effecting machinery; assert it's invoked. (vi.hoisted so the
// fns exist before the hoisted vi.mock factories run.)
const { suspendAgent, unsuspendAgent, purgeAgentCaches, armTenantKill } = vi.hoisted(() => ({
  suspendAgent: vi.fn(async () => {}),
  unsuspendAgent: vi.fn(async () => {}),
  purgeAgentCaches: vi.fn(async () => {}),
  armTenantKill: vi.fn(async () => {}),
}));
vi.mock("@/lib/state/redis", () => ({ suspendAgent, unsuspendAgent, purgeAgentCaches }));
vi.mock("@/lib/state/killswitch", () => ({ armTenantKill }));

import {
  createAgent,
  updateAgent,
  setAgentSuspended,
  revokeAgent,
  setTenantKill,
  rotatePassport,
  setPassportExpiry,
  grantBreakGlass,
  MAX_ROTATION_GRACE_S,
} from "@/lib/fleet";
import { PROVIDERS } from "@/lib/providers";
import { validateAgentUpdate, LIMITS } from "@/lib/validate";

// Chainable Supabase mock that records insert/update payloads + eq() filters.
function makeDb(
  result: { data: unknown; error: unknown },
  selectResult: { data: unknown; error: unknown } = result
) {
  const calls = {
    from: [] as string[],
    insert: null as any,
    update: null as any,
    eq: [] as [string, unknown][],
    neq: [] as [string, unknown][],
  };
  const builder = () => {
    let mutation = false;
    const b: any = {
      insert: (p: any) => { mutation = true; calls.insert = p; return b; },
      update: (p: any) => { mutation = true; calls.update = p; return b; },
      select: () => b,
      eq: (c: string, v: unknown) => { calls.eq.push([c, v]); return b; },
      neq: (c: string, v: unknown) => { calls.neq.push([c, v]); return b; },
      single: async () => result,
      maybeSingle: async () => mutation ? result : selectResult,
      then: (res: any) => res(result),
    };
    return b;
  };
  return { db: { from: (t: string) => { calls.from.push(t); return builder(); } } as any, calls };
}

const validPubkey = randomBytes(32).toString("base64url"); // 32-byte Ed25519-shaped key
const validInput = { name: "bot", passportPubkey: validPubkey, scopes: [{ provider: "anthropic", models: ["claude-*"] }] };

beforeEach(() => vi.clearAllMocks());

describe("createAgent", () => {
  it("inserts scoped to userId and returns the new id", async () => {
    const { db, calls } = makeDb({ data: { id: "a1", created_at: "2026-08-14T10:00:00Z" }, error: null });
    const r = await createAgent(db, "u1", validInput);
    expect(r).toEqual({ ok: true, value: { id: "a1", name: "bot", createdAt: "2026-08-14T10:00:00Z" } });
    expect(calls.insert.user_id).toBe("u1"); // tenant binding
    expect(calls.insert.passport_pubkey).toBe(validPubkey);
    expect(calls.insert.budget_tokens).toBeNull();
    expect(calls.insert.budget_cents).toBeNull();
  });

  // The timestamp is the floor onboarding uses to decide which stored calls prove
  // THIS passport. Coercing a missing one to the string "undefined" would produce a
  // floor that compares against nothing, so an absent value has to be a hard failure.
  it("refuses rather than inventing a creation timestamp", async () => {
    const { db } = makeDb({ data: { id: "a1" }, error: null });
    expect(await createAgent(db, "u1", validInput)).toMatchObject({ ok: false, code: "query_failed" });
  });

  it("persists optional token and cost budgets on create", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    await createAgent(db, "u1", { ...validInput, budget_tokens: 1000, budget_cents: 500 });
    expect(calls.insert.budget_tokens).toBe(1000);
    expect(calls.insert.budget_cents).toBe(500);
  });

  it("rejects invalid input (422) without touching the DB", async () => {
    const { db, calls } = makeDb({ data: null, error: null });
    const r = await createAgent(db, "u1", { name: "", passportPubkey: "bad", scopes: [] });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(calls.insert).toBeNull();
  });

  it("maps a unique-violation to 409 agent_exists", async () => {
    const { db } = makeDb({ data: null, error: { code: "23505" } });
    expect(await createAgent(db, "u1", validInput)).toMatchObject({ ok: false, status: 409, code: "agent_exists" });
  });

  it("maps a 0035 current-or-retired namespace collision to the same safe conflict", async () => {
    const { db } = makeDb({ data: null, error: { code: "P0001", message: "passport_key_in_use" } });
    expect(await createAgent(db, "u1", validInput)).toMatchObject({ ok: false, status: 409, code: "agent_exists" });
  });
});

describe("validateAgentUpdate", () => {
  it("maps only provided fields to DB columns", () => {
    expect(validateAgentUpdate({ name: "new", budget_tokens: 1000 })).toEqual({
      name: "new",
      budget_tokens: 1000,
    });
  });
  it("accepts null budgets (= unlimited) and validates scopes", () => {
    const p = validateAgentUpdate({ budget_cents: null, scopes: [{ provider: "openai", models: ["gpt-4o"] }] });
    expect(p.budget_cents).toBeNull();
    expect(p.allowed_scopes).toEqual([{ provider: "openai", models: ["gpt-4o"] }]);
  });
  it("rejects bad budgets and unknown providers", () => {
    expect(() => validateAgentUpdate({ budget_tokens: -5 })).toThrow();
    expect(() => validateAgentUpdate({ budget_tokens: 1.5 })).toThrow();
    expect(() => validateAgentUpdate({ scopes: [{ provider: "evil", models: [] }] })).toThrow();
  });
  it("returns {} when nothing is provided", () => {
    expect(validateAgentUpdate({})).toEqual({});
  });
});

describe("updateAgent", () => {
  it("applies a tenant-scoped patch", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const r = await updateAgent(db, "u1", "a1", { name: "renamed", budget_tokens: 500, budget_cents: null });
    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(calls.update).toEqual({ name: "renamed", budget_tokens: 500, budget_cents: null });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["id", "a1"]);
  });
  it("400 on an empty patch (no DB write)", async () => {
    const { db, calls } = makeDb({ data: null, error: null });
    const r = await updateAgent(db, "u1", "a1", {});
    expect(r).toMatchObject({ ok: false, status: 400, code: "empty_update" });
    expect(calls.update).toBeNull();
  });
  it("422 on invalid input", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await updateAgent(db, "u1", "a1", { budget_tokens: -1 })).toMatchObject({ ok: false, status: 422 });
  });
  it("404 when not the caller's agent", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await updateAgent(db, "u1", "a1", { name: "x" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("setAgentSuspended", () => {
  it("does not mutate Postgres when the security-critical Redis suspend fails", async () => {
    suspendAgent.mockRejectedValueOnce(new Error("redis unavailable"));
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );

    await expect(setAgentSuspended(db, "u1", "a1", true)).rejects.toThrow("redis unavailable");
    expect(calls.update).toBeNull();
  });

  it("repairs a stale Redis suspend when Postgres is already active", async () => {
    const { db } = makeDb(
      { data: null, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );

    const r = await setAgentSuspended(db, "u1", "a1", false);

    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(unsuspendAgent).toHaveBeenCalledWith("a1");
  });

  it("suspends: scoped update + Redis suspend + cache purge", async () => {
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );
    const r = await setAgentSuspended(db, "u1", "a1", true);
    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(calls.update).toEqual({ status: "suspended" });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["id", "a1"]);
    expect(suspendAgent).toHaveBeenCalledWith("a1");
    expect(purgeAgentCaches).toHaveBeenCalledWith("a1", PROVIDERS);
    expect(unsuspendAgent).not.toHaveBeenCalled();
  });

  it("resumes only an explicitly suspended agent", async () => {
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "suspended" }, error: null }
    );
    await setAgentSuspended(db, "u1", "a1", false);
    expect(calls.update).toEqual({ status: "active" });
    expect(calls.eq).toContainEqual(["status", "suspended"]);
    expect(unsuspendAgent).toHaveBeenCalledWith("a1");
    expect(suspendAgent).not.toHaveBeenCalled();
  });

  it("404 when the agent isn't the caller's (no Redis effect)", async () => {
    const { db } = makeDb({ data: null, error: null });
    const r = await setAgentSuspended(db, "u1", "a1", true);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(suspendAgent).not.toHaveBeenCalled();
  });
});

describe("revokeAgent", () => {
  it("does not persist revocation when the security-critical Redis block fails", async () => {
    suspendAgent.mockRejectedValueOnce(new Error("redis unavailable"));
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );

    await expect(revokeAgent(db, "u1", "a1")).rejects.toThrow("redis unavailable");
    expect(calls.update).toBeNull();
  });

  it("sets status revoked + suspend + purge", async () => {
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );
    const r = await revokeAgent(db, "u1", "a1");
    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(calls.update).toEqual({ status: "revoked" });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["status", "active"]);
    expect(suspendAgent).toHaveBeenCalledWith("a1");
  });
  it("404 when not found", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await revokeAgent(db, "u1", "a1")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("setTenantKill", () => {
  it("arms only the tenant kill flag; it never overwrites individual suspension state", async () => {
    const { db, calls } = makeDb({ data: [{ id: "a1" }, { id: "a2" }], error: null });
    const r = await setTenantKill(db, "u1", true);
    expect(r).toEqual({ ok: true, value: { affected: 2 } });
    expect(armTenantKill).toHaveBeenCalledWith("u1", true);
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(suspendAgent).not.toHaveBeenCalled();
    expect(unsuspendAgent).not.toHaveBeenCalled();
    expect(purgeAgentCaches).not.toHaveBeenCalled();
  });

  it("disarms only the tenant kill flag; individual suspension markers remain untouched", async () => {
    const { db } = makeDb({ data: [{ id: "a1" }], error: null });
    await setTenantKill(db, "u1", false);
    expect(armTenantKill).toHaveBeenCalledWith("u1", false);
    expect(suspendAgent).not.toHaveBeenCalled();
    expect(unsuspendAgent).not.toHaveBeenCalled();
    expect(purgeAgentCaches).not.toHaveBeenCalled();
  });
});

// ── Passport rotation and expiry ────────────────────────────────────────────
//
// Rotation exists because retiring a compromised key used to cost the whole
// agent: revoke is terminal and takes the id, budgets, audit history and
// receipts with it. So the refusals below are not fussiness — each one is a way
// an operator could believe they had rotated when they had not, or could lock
// out an agent that was doing nothing wrong.
//
// The grace window is enforced at the door (lib/auth/passport.ts). What these
// pin is that the row is left in a state the door can read correctly.

const CURRENT_KEY = randomBytes(32).toString("base64url");
const NEW_KEY = randomBytes(32).toString("base64url");
const RETIRED_KEY = randomBytes(32).toString("base64url");

const activeAgent = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  status: "active",
  passport_pubkey: CURRENT_KEY,
  previous_passport_pubkey: null,
  previous_valid_until: null,
  ...over,
});

describe("rotatePassport", () => {
  it("installs the new key, retires the current one, and stamps a deadline", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null }, { data: activeAgent(), error: null });
    const before = Date.now();
    const r = await rotatePassport(db, "u1", "a1", NEW_KEY, 3600);

    expect(r.ok).toBe(true);
    expect(calls.update).toMatchObject({
      passport_pubkey: NEW_KEY,
      previous_passport_pubkey: CURRENT_KEY,
    });
    const until = Date.parse(calls.update.previous_valid_until);
    expect(until).toBeGreaterThanOrEqual(before + 3600_000);
    // Tenant-scoped, like every other mutation in this module.
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
  });

  /**
   * The update is conditioned on the key we actually read. Two rotations racing
   * would otherwise have the second overwrite a key it never saw — and the key
   * it recorded as "previous" would be one that had already been retired,
   * silently stranding the agent still using the real previous key.
   */
  it("only rotates the row it read, so a concurrent rotation cannot be clobbered", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null }, { data: activeAgent(), error: null });
    await rotatePassport(db, "u1", "a1", NEW_KEY, 60);
    expect(calls.eq).toContainEqual(["passport_pubkey", CURRENT_KEY]);
  });

  it("reports a lost race as a conflict rather than as success", async () => {
    const { db } = makeDb({ data: null, error: null }, { data: activeAgent(), error: null });
    const r = await rotatePassport(db, "u1", "a1", NEW_KEY, 60);
    expect(r).toMatchObject({ ok: false, code: "rotation_conflict" });
  });

  it("maps a global current-or-retired namespace conflict without exposing its owner", async () => {
    const { db } = makeDb(
      { data: null, error: { code: "P0001", message: "passport_key_in_use" } },
      { data: activeAgent(), error: null }
    );
    const r = await rotatePassport(db, "u1", "a1", NEW_KEY, 60);
    expect(r).toMatchObject({ ok: false, status: 409, code: "agent_exists" });
  });

  /**
   * Rotating to the key already in use would retire a key and reinstate it in
   * the same write — the operator believes the old key is dying, and nothing
   * has changed.
   */
  it("refuses to rotate a key to itself", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null }, { data: activeAgent(), error: null });
    const r = await rotatePassport(db, "u1", "a1", CURRENT_KEY, 60);
    expect(r).toMatchObject({ ok: false, code: "same_key" });
    expect(calls.update).toBeNull();
  });

  /**
   * There are only two key columns. A second rotation while the first window is
   * open would silently drop the FIRST retired key's remaining time, locking out
   * the agent still using it — exactly the failure the window exists to prevent.
   */
  it("refuses to rotate again while a grace window is still open", async () => {
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      {
        data: activeAgent({
          previous_passport_pubkey: RETIRED_KEY,
          previous_valid_until: new Date(Date.now() + 600_000).toISOString(),
        }),
        error: null,
      }
    );
    const r = await rotatePassport(db, "u1", "a1", NEW_KEY, 60);
    expect(r).toMatchObject({ ok: false, code: "rotation_in_progress" });
    expect(calls.update).toBeNull();
  });

  it("allows a rotation once the previous window has closed", async () => {
    const { db } = makeDb(
      { data: { id: "a1" }, error: null },
      {
        data: activeAgent({
          previous_passport_pubkey: RETIRED_KEY,
          previous_valid_until: new Date(Date.now() - 1000).toISOString(),
        }),
        error: null,
      }
    );
    expect((await rotatePassport(db, "u1", "a1", NEW_KEY, 60)).ok).toBe(true);
  });

  it.each([
    ["not a key", "hello"],
    ["empty", ""],
    ["too short", randomBytes(16).toString("base64url")],
  ])("refuses a new passport that is %s", async (_label, key) => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null }, { data: activeAgent(), error: null });
    const r = await rotatePassport(db, "u1", "a1", key, 60);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(calls.update).toBeNull();
  });

  it.each([-1, MAX_ROTATION_GRACE_S + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a grace period of %s",
    async (grace) => {
      const { db, calls } = makeDb({ data: { id: "a1" }, error: null }, { data: activeAgent(), error: null });
      const r = await rotatePassport(db, "u1", "a1", NEW_KEY, grace as number);
      expect(r).toMatchObject({ ok: false, status: 422 });
      expect(calls.update).toBeNull();
    }
  );

  // Zero is legitimate and means "the old key dies now" — the right choice when
  // rotating BECAUSE a key leaked, where any window is a window for the thief.
  it("allows a zero grace period", async () => {
    const { db } = makeDb({ data: { id: "a1" }, error: null }, { data: activeAgent(), error: null });
    expect((await rotatePassport(db, "u1", "a1", NEW_KEY, 0)).ok).toBe(true);
  });

  it.each(["suspended", "revoked"])("refuses to rotate a %s agent", async (status) => {
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: activeAgent({ status }), error: null }
    );
    const r = await rotatePassport(db, "u1", "a1", NEW_KEY, 60);
    expect(r).toMatchObject({ ok: false, code: "agent_not_active" });
    expect(calls.update).toBeNull();
  });

  it("refuses an agent the tenant does not own", async () => {
    const { db, calls } = makeDb({ data: null, error: null }, { data: null, error: null });
    const r = await rotatePassport(db, "u1", "a1", NEW_KEY, 60);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(calls.update).toBeNull();
  });

  /**
   * The key that gets STORED is trimmed. Every other surface has to report that
   * same value, or the control plane and the audit row assert a key that is not
   * on the row and cannot authenticate — a rotation record naming a key nobody
   * can ever present is worse than no record, because it reads as authoritative.
   */
  it("returns the stored, normalized key rather than the value as submitted", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null }, { data: activeAgent(), error: null });
    const r = await rotatePassport(db, "u1", "a1", `  ${NEW_KEY}\n`, 60);

    expect(r.ok).toBe(true);
    expect(calls.update.passport_pubkey).toBe(NEW_KEY);
    expect(r.ok && r.value.passportPubkey).toBe(NEW_KEY);
  });

  // Uniqueness is the database's job, not a read-then-write here, which would
  // race two rotations onto the same key.
  it("maps a unique violation to a registered-passport conflict", async () => {
    const { db } = makeDb(
      { data: null, error: { code: "23505" } },
      { data: activeAgent(), error: null }
    );
    const r = await rotatePassport(db, "u1", "a1", NEW_KEY, 60);
    expect(r).toMatchObject({ ok: false, code: "agent_exists" });
  });
});

/**
 * The normalization only matters if the callers USE it.
 *
 * This is the half a fleet-level test cannot reach: rotatePassport can return
 * the canonical key perfectly and both callers can still echo the raw request
 * value into their response and their audit metadata, which is exactly the bug
 * this pins. Asserted on the source because the alternative — standing up the
 * control-plane key auth and a Supabase session to drive each handler — would
 * pin the handler's plumbing rather than the one line that matters.
 */
describe("what the rotation callers report", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("the control API returns and audits the key fleet stored", () => {
    const route = read("app/api/control/v1/agents/[id]/rotate/route.ts");
    expect(route).toMatch(/to: r\.value\.passportPubkey/);
    expect(route).toMatch(/passport_pubkey: r\.value\.passportPubkey/);
  });

  it("the dashboard action audits the key fleet stored", () => {
    expect(read("app/dashboard/agents/[id]/passport-actions.ts")).toMatch(
      /to: result\.value\.passportPubkey/
    );
  });
});

/**
 * The bound that matters is on the UNION, and the union is what lands in a visa.
 *
 * `validateScopes` bounds a single document: 20 entries, 50 models each. It says
 * nothing about two documents being merged, and nothing at all stops either one
 * naming the SAME provider 20 times — so a row count is not a size. These pin
 * the thing an operator actually feels: a bearer token too large to send.
 */
describe("grantBreakGlass", () => {
  // Maximum-length patterns, distinct within and across every entry, so nothing
  // is deduplicated away and the arithmetic below is the real worst case.
  const maxModels = (tag: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${tag}-${i}-`.padEnd(LIMITS.modelPattern, "m"));

  /** LIMITS.scopes entries, all naming one provider — which validateScopes allows. */
  const oneProviderRepeated = (tag: string) =>
    Array.from({ length: LIMITS.scopes }, (_, row) => ({
      provider: "openai",
      models: maxModels(`${tag}${row}`, LIMITS.models),
    }));

  const goodGrant = { scopes: [{ provider: "anthropic", models: ["claude-*"] }], reason: "incident 412", ttlSeconds: 600 };

  const dbFor = (allowedScopes: unknown) =>
    makeDb(
      { data: { id: "g1" }, error: null },
      { data: { id: "a1", status: "active", allowed_scopes: allowedScopes }, error: null }
    );

  it("grants a normal elevation", async () => {
    const { db, calls } = dbFor([{ provider: "openai", models: ["gpt-4o-mini"] }]);
    const r = await grantBreakGlass(db, "u1", "a1", goodGrant);
    expect(r.ok).toBe(true);
    expect(calls.insert.user_id).toBe("u1"); // tenant binding
  });

  /**
   * The stored document and the reported document must be the same document.
   *
   * validateScopes trims providers and patterns and drops anything it was not
   * asked for, so what lands in break_glass_grants is not what was submitted. A
   * caller that records its own request value instead states an elevation that
   * was never granted — the same divergence as a rotation audit naming a key
   * that is not on the row, and it now reaches the capability history, which
   * renders these rows.
   */
  it("returns the normalized scopes it stored, not the document as submitted", async () => {
    const { db, calls } = dbFor([]);
    const r = await grantBreakGlass(db, "u1", "a1", {
      ...goodGrant,
      scopes: [{ provider: " anthropic ", models: ["  claude-*  "], note: "dropped" }],
    });

    expect(r.ok).toBe(true);
    const canonical = [{ provider: "anthropic", models: ["claude-*"] }];
    expect(calls.insert.scopes).toEqual(canonical);
    expect(r.ok && r.value.scopes).toEqual(canonical);
  });

  /**
   * 20 stored entries and 20 grant entries for ONE provider, 50 maximum-length
   * models each. Both documents pass validateScopes and the union still has 20
   * rows — but it carries 2,000 models and serializes to roughly 400 KB, which
   * is a visa that cannot be sent in an Authorization header. Counting rows
   * could never have caught this.
   */
  it("refuses a union that would mint a visa too large to send", async () => {
    const { db, calls } = dbFor(oneProviderRepeated("s"));
    const r = await grantBreakGlass(db, "u1", "a1", {
      ...goodGrant,
      scopes: oneProviderRepeated("g"),
    });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(calls.insert).toBeNull();
  });

  /**
   * Same refusal, but the operator is told which document is the problem. An
   * elevation refused mid-incident with "narrow it" is unactionable when it was
   * never the grant that was too big.
   */
  it("says so when the agent's own scope is what is already past the bound", async () => {
    const { db } = dbFor(oneProviderRepeated("s"));
    const r = await grantBreakGlass(db, "u1", "a1", goodGrant);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(r).toHaveProperty("message", expect.stringMatching(/own scope/i));
  });

  /**
   * The bound of last resort, reached with inputs that break NO count.
   *
   * 30 stored + 20 granted maximum-length patterns for one provider is exactly
   * LIMITS.models after merging — legal on every axis that can be counted — and
   * still serializes to about 10 KB, which is a visa this gateway would mint and
   * an Authorization header may refuse to carry. Without this case the byte
   * bound is never reached through the real entry point, because the model count
   * trips first on every larger input.
   */
  it("refuses a claim too large to carry even when every count is legal", async () => {
    const { db, calls } = dbFor([{ provider: "openai", models: maxModels("s", 30) }]);
    const r = await grantBreakGlass(db, "u1", "a1", {
      ...goodGrant,
      scopes: [{ provider: "openai", models: maxModels("g", 20) }],
    });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(r).toHaveProperty("message", expect.stringMatching(/bytes/i));
    expect(calls.insert).toBeNull();
  });

  it("refuses a union past the per-provider model limit", async () => {
    const { db, calls } = dbFor([
      { provider: "openai", models: maxModels("s", LIMITS.models) },
    ]);
    const r = await grantBreakGlass(db, "u1", "a1", {
      ...goodGrant,
      scopes: [{ provider: "openai", models: maxModels("g", 1) }],
    });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(calls.insert).toBeNull();
  });
});

describe("setPassportExpiry", () => {
  it("sets an expiry in the future", async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const r = await setPassportExpiry(db, "u1", "a1", at);
    expect(r.ok).toBe(true);
    expect(calls.update).toEqual({ expires_at: at });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
  });

  // null is how expiry is turned off, and the state every row starts in.
  it("clears an expiry with null", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    expect((await setPassportExpiry(db, "u1", "a1", null)).ok).toBe(true);
    expect(calls.update).toEqual({ expires_at: null });
  });

  /**
   * A past expiry locks the agent out on its next challenge. An operator who
   * meant that has suspend (reversible) and revoke (explicitly terminal); this
   * is the one control here that can take a fleet offline by typo.
   */
  it("refuses an expiry in the past rather than locking the agent out", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const past = new Date(Date.now() - 1000).toISOString();
    const r = await setPassportExpiry(db, "u1", "a1", past);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(r).toHaveProperty("message", expect.stringMatching(/suspend/i));
    expect(calls.update).toBeNull();
  });

  it.each(["yesterday", "", "2026-13-45"])("refuses an unparseable expiry (%s)", async (value) => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    expect(await setPassportExpiry(db, "u1", "a1", value)).toMatchObject({ ok: false, status: 422 });
    expect(calls.update).toBeNull();
  });

  it("refuses an agent the tenant does not own", async () => {
    const { db } = makeDb({ data: null, error: null });
    const at = new Date(Date.now() + 86_400_000).toISOString();
    expect(await setPassportExpiry(db, "u1", "a1", at)).toMatchObject({ ok: false, status: 404 });
  });
});
