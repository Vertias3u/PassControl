import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ getMock: vi.fn(), setMock: vi.fn(), fenceMock: vi.fn() }));

vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));
vi.mock("@/lib/state/redis", () => ({
  getCachedAgentPolicy: (...a: unknown[]) => h.getMock(...a),
  setCachedAgentPolicy: (...a: unknown[]) => h.setMock(...a),
  // Mocked EXPLICITLY, and the omission would have been silent. Leaving it out
  // makes the import undefined, the call throws, policy.ts catches it and
  // carries on with a null fence — so every assertion below would still pass
  // while the mechanism under test was never exercised.
  readPolicyFence: (...a: unknown[]) => h.fenceMock(...a),
}));

import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";

const MISSING_COLUMN = { code: "42703", message: 'column agents.sender_constraint_mode does not exist' };

/**
 * Every column the newest rung asks for. 0055 added the budget-state pair; the
 * caps came with S3-04, on the same read for the same reason — one round trip
 * already happens on every call, so gating on the CURRENT cap rather than the
 * visa's minted snapshot costs nothing extra.
 */
const CURRENT_SCHEMA = [
  "policy",
  "policy_shadow",
  "sender_constraint_mode",
  "budget_epoch",
  "budget_state_established_at",
  "budget_tokens",
  "budget_cents",
];

/**
 * A database whose selects fail with 42703 until the caller asks for a column
 * list this schema actually has — which is exactly how PostgREST behaves, and
 * why lib/state/policy.ts narrows in deployment order rather than probing.
 */
function db(schema: { has: string[]; row: Record<string, unknown> }) {
  const selects: string[] = [];
  const b: any = {
    select: (cols: string) => {
      selects.push(cols);
      b._cols = cols.split(",").map((c) => c.trim());
      return b;
    },
    eq: () => b,
    maybeSingle: async () => {
      const missing = b._cols.filter((c: string) => !schema.has.includes(c));
      if (missing.length) return { data: null, error: MISSING_COLUMN };
      const data: Record<string, unknown> = {};
      for (const col of b._cols) data[col] = schema.row[col] ?? null;
      return { data, error: null };
    },
  };
  return { client: { from: () => b } as never, selects };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getMock.mockResolvedValue(null);
  h.fenceMock.mockResolvedValue(null);
});

describe("the pre-0049 schema, where the control is a boolean", () => {
  /**
   * 0046 shipped `require_sender_constrained_visa` and 0049 replaced it with the
   * three-state mode. The reader's fallback rung used to skip straight past the
   * boolean on the reasoning that nothing in the product could ever write it —
   * true of the product, not of the database. An operator could set that column
   * by hand, and it was the ONLY way to turn the control on between 0046 and
   * 0049; 0049's own backfill preserves `true` rows, which is an admission that
   * they exist. The cache decoder already honours a legacy `r: true` for exactly
   * this reason, so skipping it here made the two halves disagree: enforcing
   * while warm, bearer-only once the entry expired.
   */
  const LEGACY_SCHEMA = ["policy", "policy_shadow", "require_sender_constrained_visa"];

  it("keeps an explicitly enabled legacy constraint as required", async () => {
    const { client } = db({
      has: LEGACY_SCHEMA,
      row: { policy: "allow", policy_shadow: null, require_sender_constrained_visa: true },
    });
    const read = await readCurrentAgentPolicyAndShadow(client, "u1", "a1");

    // A code-before-migration window must not quietly retire an authentication
    // control the operator turned on.
    expect(read.senderConstraintMode).toBe("required");
  });

  it("reads an unset legacy constraint as off, without an extra round trip", async () => {
    const { client, selects } = db({
      has: LEGACY_SCHEMA,
      row: { policy: "allow", policy_shadow: null, require_sender_constrained_visa: false },
    });
    const read = await readCurrentAgentPolicyAndShadow(client, "u1", "a1");

    expect(read.senderConstraintMode).toBe("off");
    // Current schemas still pay one query; this rung is only reached after the
    // newer ones have already been refused by 42703.
    expect(selects.length).toBeLessThanOrEqual(3);
  });

  it("still falls through to policy-only on a schema older than 0046", async () => {
    const { client } = db({
      has: ["policy", "policy_shadow"],
      row: { policy: "allow", policy_shadow: null },
    });
    const read = await readCurrentAgentPolicyAndShadow(client, "u1", "a1");

    expect(read.policy).toBe("allow");
    expect(read.senderConstraintMode).toBe("off");
  });
});

describe("reading the sender-constraint mode", () => {
  it.each(["off", "observe", "required"])("carries a %s mode through", async (mode) => {
    const { client } = db({
      has: CURRENT_SCHEMA,
      row: { policy: null, policy_shadow: null, sender_constraint_mode: mode },
    });
    await expect(
      readCurrentAgentPolicyAndShadow(client, "u1", "a1", { cacheOnMiss: false })
    ).resolves.toMatchObject({ senderConstraintMode: mode });
  });

  // Drift resolves DOWN, never up. A mode this build does not understand must
  // not be read as enforcement (which would refuse every call) and must not be
  // read as null (which the proxy treats as an authentication failure). `off` is
  // the only answer that is both safe and honest about what we know.
  it("resolves an unrecognised mode to off", async () => {
    const { client } = db({
      has: CURRENT_SCHEMA,
      row: { policy: null, policy_shadow: null, sender_constraint_mode: "paranoid" },
    });
    await expect(
      readCurrentAgentPolicyAndShadow(client, "u1", "a1", { cacheOnMiss: false })
    ).resolves.toMatchObject({ senderConstraintMode: "off" });
  });

  it("costs exactly one round trip on a current schema", async () => {
    const { client, selects } = db({
      has: CURRENT_SCHEMA,
      row: { policy: { a: 1 }, policy_shadow: null, sender_constraint_mode: "observe" },
    });
    await readCurrentAgentPolicyAndShadow(client, "u1", "a1", { cacheOnMiss: false });
    expect(selects).toHaveLength(1);
  });

  // THE RUNG 0055 ADDED, and the reason it is a rung of its own rather than two
  // more columns on the one below.
  //
  // Folded into the pre-0049 rung, a deployment that had not applied 0055 would
  // fall straight past `sender_constraint_mode` as well — and a missing mode
  // column decodes as `off`, so a BUDGET migration would have silently turned
  // sender-proof enforcement off on every call until someone applied it. That is
  // the whole failure this ladder exists to prevent, arriving from a new
  // direction. The assertion that matters here is the mode, not the count.
  it("narrows to a pre-0055 schema WITHOUT dropping sender-proof enforcement", async () => {
    const { client, selects } = db({
      has: ["policy", "policy_shadow", "sender_constraint_mode"],
      row: { policy: { live: true }, policy_shadow: null, sender_constraint_mode: "required" },
    });
    const read = await readCurrentAgentPolicyAndShadow(client, "u1", "a1", { cacheOnMiss: false });

    expect(read.policy).toEqual({ live: true });
    // The one that would have silently become "off" if 0055 had shared a rung.
    expect(read.senderConstraintMode).toBe("required");
    // No budget columns means this database cannot record budget state, so
    // nothing is enforced and the gateway behaves exactly as it did before 0055.
    expect(read.budgetState).toEqual({ epoch: null, established: false });
    expect(selects).toHaveLength(2);
  });

  // The deployment-order ladder 0046 introduced, now two rungs longer. Code that
  // reaches production before 0049 must not turn a missing diagnostic column
  // into POLICY_UNREADABLE, because that would make a migration change
  // enforcement.
  it("narrows to the pre-0049 schema without losing the policy", async () => {
    const { client, selects } = db({
      has: ["policy", "policy_shadow"],
      row: { policy: { live: true }, policy_shadow: { draft: true } },
    });
    const read = await readCurrentAgentPolicyAndShadow(client, "u1", "a1", { cacheOnMiss: false });

    expect(read.policy).toEqual({ live: true });
    expect(read.shadow).toEqual({ draft: true });
    // No mode column AND no 0046 boolean means nothing was ever configured here.
    expect(read.senderConstraintMode).toBe("off");
    // Four, not three: a schema this old refuses the legacy-boolean rung too.
    // A real pre-0049 install HAS that column and still pays three.
    expect(selects).toHaveLength(4);
  });

  it("narrows all the way to a pre-0020 schema", async () => {
    const { client, selects } = db({ has: ["policy"], row: { policy: { live: true } } });
    const read = await readCurrentAgentPolicyAndShadow(client, "u1", "a1", { cacheOnMiss: false });

    expect(read.policy).toEqual({ live: true });
    expect(read.shadow).toBeNull();
    expect(read.senderConstraintMode).toBe("off");
    expect(selects).toHaveLength(5);
  });

  // An infrastructure fault is not a configuration. The proxy refuses passport
  // calls on null rather than guessing the mode off, so this distinction is the
  // difference between failing closed and silently dropping enforcement.
  it("reports an unreadable row as null, not as off", async () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: null, error: { code: "57014", message: "timeout" } }),
    };
    const read = await readCurrentAgentPolicyAndShadow(
      { from: () => b } as never,
      "u1",
      "a1",
      { cacheOnMiss: false }
    );
    expect(read.senderConstraintMode).toBeNull();
  });

  it("survives its own cache round trip", async () => {
    const { client } = db({
      has: CURRENT_SCHEMA,
      row: { policy: { a: 1 }, policy_shadow: null, sender_constraint_mode: "required" },
    });
    await readCurrentAgentPolicyAndShadow(client, "u1", "a1");

    const cached = h.setMock.mock.calls[0]![2] as string;
    h.getMock.mockResolvedValue(cached);
    await expect(
      readCurrentAgentPolicyAndShadow(client, "u1", "a1")
    ).resolves.toMatchObject({ senderConstraintMode: "required" });
  });

  // 0046's boolean, seen in a cache entry written by the previous deploy.
  // Nothing in the product could ever set that column, so `true` only exists on
  // a row somebody edited by hand — but decoding it as `off` would silently drop
  // enforcement for that agent for a cache TTL, which is the one direction this
  // must never fail in. Two lines to close.
  it("reads 0046's boolean cache shape without downgrading enforcement", async () => {
    h.getMock.mockResolvedValue(JSON.stringify({ p: { a: 1 }, s: null, r: true }));
    const { client } = db({ has: ["policy"], row: { policy: null } });
    await expect(
      readCurrentAgentPolicyAndShadow(client, "u1", "a1")
    ).resolves.toMatchObject({ senderConstraintMode: "required" });
  });

  it("reads 0046's false as off", async () => {
    h.getMock.mockResolvedValue(JSON.stringify({ p: { a: 1 }, s: null, r: false }));
    const { client } = db({ has: ["policy"], row: { policy: null } });
    await expect(
      readCurrentAgentPolicyAndShadow(client, "u1", "a1")
    ).resolves.toMatchObject({ senderConstraintMode: "off" });
  });

  // A cache entry written by the previous deploy has no mode in it. Decoding it
  // as `off` is right; decoding it as null would fail every passport call for a
  // cache TTL after a routine deploy.
  it("reads a pre-0049 cache entry as off", async () => {
    h.getMock.mockResolvedValue(JSON.stringify({ p: { a: 1 }, s: null }));
    const { client } = db({ has: ["policy"], row: { policy: null } });
    await expect(
      readCurrentAgentPolicyAndShadow(client, "u1", "a1")
    ).resolves.toMatchObject({ senderConstraintMode: "off" });
  });
});

/**
 * THE ONE-LINE TEST THAT WOULD HAVE CAUGHT THE LAST FENCE.
 *
 * The previous mechanism had a parameter for the reader's snapshot time, a long
 * comment explaining why it mattered, and no call site that passed it. Every
 * behavioural test still passed, because the argument's absence is invisible
 * from outside: the setter simply defaulted it to its own clock. An assertion on
 * what the call site actually hands over is cheap, and it is the assertion that
 * fails when the wiring comes apart.
 */
describe("the fence the policy fill quotes", () => {
  it("is the one read BEFORE the database, and it reaches the fill", async () => {
    h.fenceMock.mockResolvedValue("fence-token-abc");
    const { client } = db({ has: CURRENT_SCHEMA, row: { policy: {}, sender_constraint_mode: "required" } });

    await readCurrentAgentPolicyAndShadow(client, "u1", "a1");

    expect(h.fenceMock).toHaveBeenCalledWith("u1", "a1");
    // Fifth argument. Not a fresh read, not a default, not undefined — the value
    // observed before the snapshot this fill is about to publish.
    expect(h.setMock).toHaveBeenCalledWith("u1", "a1", expect.any(String), expect.any(Number), "fence-token-abc");
  });

  it("is read before the row, not after it", async () => {
    // Ordering is the whole property. A fence read after the authoritative read
    // agrees with any invalidation that landed during it, which is precisely the
    // fill that must be rejected.
    const order: string[] = [];
    h.fenceMock.mockImplementation(async () => {
      order.push("fence");
      return "f1";
    });
    const { client } = db({ has: CURRENT_SCHEMA, row: { policy: {}, sender_constraint_mode: "off" } });
    const builder = (client as unknown as { from: () => { select: (c: string) => unknown } }).from();
    const inner = builder.select.bind(builder);
    builder.select = (cols: string) => {
      order.push("select");
      return inner(cols);
    };

    await readCurrentAgentPolicyAndShadow(client, "u1", "a1");

    expect(order[0]).toBe("fence");
    expect(order).toContain("select");
  });

  it("does not read the fence at all on a cache hit", async () => {
    // The hot path must not pay for this. A hit answers from Redis and returns
    // before any of it.
    h.getMock.mockResolvedValue(JSON.stringify({ p: {}, s: null, r: "required" }));
    const { client } = db({ has: CURRENT_SCHEMA, row: { policy: {} } });

    const out = await readCurrentAgentPolicyAndShadow(client, "u1", "a1");

    expect(out.senderConstraintMode).toBe("required");
    expect(h.fenceMock).not.toHaveBeenCalled();
  });
});
