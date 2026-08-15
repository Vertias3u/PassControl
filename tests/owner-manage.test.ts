import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  updateMock: vi.fn(),
  purgeMock: vi.fn(),
  verifyDomainMock: vi.fn(),
}));

vi.mock("@/lib/state/redis", () => ({ purgeOwnerCache: (...a: unknown[]) => h.purgeMock(...a) }));
vi.mock("@/lib/owner/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/owner/domain")>();
  return { ...actual, verifyDomainControl: (...a: unknown[]) => h.verifyDomainMock(...a) };
});

import { OWNER_FAILURE_LIMIT, setOwner, verifyOwnerDomain } from "@/lib/owner/manage";

let selected: { data: unknown; error: unknown } = { data: null, error: null };
const eqCalls: [string, unknown][] = [];

function db() {
  const b: any = {
    select: () => b,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return b;
    },
    upsert: (row: unknown) => {
      h.upsertMock(row);
      return b;
    },
    update: (patch: unknown) => {
      h.updateMock(patch);
      return b;
    },
    maybeSingle: async () => selected,
  };
  return { from: () => b } as never;
}

const OWNER_ROW = {
  kind: "domain",
  subject: "acme.com",
  tier: "unverified",
  published: false,
  verification_token: "passcontrol-verify-tok",
  verified_at: null,
  last_checked_at: null,
  failure_count: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
  selected = { data: OWNER_ROW, error: null };
  h.purgeMock.mockResolvedValue(undefined);
});

describe("declaring an owner", () => {
  // The rule the whole ladder rests on. If a caller could write its own tier,
  // anyone could self-declare "domain-verified" and the label on the public page
  // would mean nothing.
  it("ignores a caller-supplied tier and verified_at entirely", async () => {
    await setOwner(db(), "u1", {
      kind: "self_attested",
      subject: "Definitely Real Bank",
      tier: "idv",
      verified_at: "2020-01-01T00:00:00.000Z",
      failure_count: -50,
    });

    expect(h.upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "unverified", verified_at: null, failure_count: 0 })
    );
  });

  // Claiming a domain and proving control of it are different acts.
  it("starts a domain claim unverified, with a token to publish", async () => {
    await setOwner(db(), "u1", { kind: "domain", subject: "acme.com" });

    const row = h.upsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.tier).toBe("unverified");
    expect(String(row.verification_token)).toMatch(/^passcontrol-verify-/);
  });

  it("issues no token for a self-attested claim", async () => {
    await setOwner(db(), "u1", { kind: "self_attested", subject: "Acme Ltd" });
    expect(h.upsertMock.mock.calls[0]![0]).toMatchObject({ verification_token: null });
  });

  it("defaults to unpublished", async () => {
    await setOwner(db(), "u1", { kind: "self_attested", subject: "Acme Ltd" });
    expect(h.upsertMock.mock.calls[0]![0]).toMatchObject({ published: false });
  });

  it("is scoped to the calling tenant", async () => {
    await setOwner(db(), "u1", { kind: "self_attested", subject: "Acme Ltd" });
    expect(h.upsertMock.mock.calls[0]![0]).toMatchObject({ user_id: "u1" });
  });

  it("refuses a domain it could never verify, at declaration time", async () => {
    const result = await setOwner(db(), "u1", { kind: "domain", subject: "https://acme.com/x" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("invalid_domain");
    expect(h.upsertMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown kind", { kind: "notarised", subject: "x" }],
    ["a missing subject", { kind: "self_attested", subject: "" }],
    ["an oversized subject", { kind: "self_attested", subject: "a".repeat(500) }],
  ])("rejects %s", async (_label, input) => {
    expect((await setOwner(db(), "u1", input)).ok).toBe(false);
  });

  it("drops the cached owner so the change is visible to receipts", async () => {
    await setOwner(db(), "u1", { kind: "self_attested", subject: "Acme Ltd" });
    expect(h.purgeMock).toHaveBeenCalledWith("u1");
  });
});

describe("verifying a domain claim", () => {
  it("promotes the tier and stamps the date on success", async () => {
    h.verifyDomainMock.mockResolvedValue({ ok: true });
    const now = new Date("2026-08-05T12:00:00.000Z");

    await verifyOwnerDomain(db(), "u1", { now: () => now });

    expect(h.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "domain",
        verified_at: now.toISOString(),
        failure_count: 0,
      })
    );
  });

  it("checks the subject on file, never one supplied by the caller", async () => {
    h.verifyDomainMock.mockResolvedValue({ ok: true });
    await verifyOwnerDomain(db(), "u1");

    expect(h.verifyDomainMock).toHaveBeenCalledWith(
      "acme.com",
      "passcontrol-verify-tok",
      expect.anything()
    );
  });

  // One failed check is a blip — a web server restarting, a CDN hiccup. Demoting
  // on the first failure would make the label flap for reasons that have nothing
  // to do with whether the owner still controls the domain.
  it("does not demote on a single failure", async () => {
    h.verifyDomainMock.mockResolvedValue({ ok: false, reason: "unreachable" });
    selected = { data: { ...OWNER_ROW, tier: "domain", failure_count: 0 }, error: null };

    await verifyOwnerDomain(db(), "u1");

    const patch = h.updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.failure_count).toBe(1);
    expect(patch).not.toHaveProperty("tier");
  });

  it("demotes after the failure limit but keeps the subject and the original date", async () => {
    h.verifyDomainMock.mockResolvedValue({ ok: false, reason: "token_mismatch" });
    selected = {
      data: {
        ...OWNER_ROW,
        tier: "domain",
        verified_at: "2026-07-01T00:00:00.000Z",
        failure_count: OWNER_FAILURE_LIMIT - 1,
      },
      error: null,
    };

    await verifyOwnerDomain(db(), "u1");

    const patch = h.updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.tier).toBe("unverified");
    // Degrade the label, never delete the binding: the page can still say when
    // it was last genuinely confirmed, which beats showing nothing.
    expect(patch).not.toHaveProperty("verified_at");
    expect(patch).not.toHaveProperty("subject");
  });

  it("refuses to verify a self-attested binding", async () => {
    selected = { data: { ...OWNER_ROW, kind: "self_attested" }, error: null };
    const result = await verifyOwnerDomain(db(), "u1");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("not_a_domain_owner");
    expect(h.verifyDomainMock).not.toHaveBeenCalled();
  });

  it("404s when no owner is bound", async () => {
    selected = { data: null, error: null };
    const result = await verifyOwnerDomain(db(), "u1");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(404);
  });

  it("never returns anything derived from the fetched document", async () => {
    h.verifyDomainMock.mockResolvedValue({ ok: false, reason: "token_mismatch" });
    const result = await verifyOwnerDomain(db(), "u1");

    // `reason` is a fixed enum, so the response cannot carry response bodies out
    // of a host the caller chose. See lib/owner/domain.ts.
    expect(result.ok && result.data.reason).toBe("token_mismatch");
    expect(JSON.stringify(result)).not.toContain("<");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The claim that was CHECKED must be the claim that gets STAMPED.
//
// verifyOwnerDomain reads the row, then awaits an HTTPS fetch of a host the
// owner chose — which the owner of that host controls the timing of, and can
// hold open indefinitely. Anything the tenant does in that window changes the
// row underneath the in-flight check. A write filtered only on `user_id` lands
// on whatever row is there when it returns, not the one that was proven.
//
// The naive db() above cannot see this: its maybeSingle() ignores filters
// entirely, so a conditional update and an unconditional one look identical to
// it. These tests use a fake that actually honours .eq(), and assert on the
// STORED ROW — the patch is still *sent* after the fix, it just must not match.
// ─────────────────────────────────────────────────────────────────────────────
function ledger(initial: Record<string, unknown> | null) {
  const store: { row: Record<string, unknown> | null; writeError: unknown } = {
    row: initial ? { ...initial } : null,
    writeError: null,
  };

  const from = () => {
    // Per-query, not per-table: readOwner's user_id filter must not be
    // attributed to the update that follows it.
    const filters: [string, unknown][] = [];
    let op: { kind: "select" } | { kind: "update"; patch: Record<string, unknown> } | { kind: "upsert"; row: Record<string, unknown> } =
      { kind: "select" };

    const matches = () =>
      store.row !== null && filters.every(([col, val]) => store.row![col] === val);

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      update: (patch: Record<string, unknown>) => {
        op = { kind: "update", patch };
        return b;
      },
      upsert: (row: Record<string, unknown>) => {
        op = { kind: "upsert", row };
        return b;
      },
      maybeSingle: async () => {
        if (op.kind === "upsert") {
          store.row = { ...op.row };
          return { data: { ...store.row }, error: null };
        }
        if (op.kind === "update") {
          if (store.writeError) return { data: null, error: store.writeError };
          if (!matches()) return { data: null, error: null }; // row moved
          store.row = { ...store.row, ...op.patch };
          return { data: { ...store.row }, error: null };
        }
        return { data: matches() ? { ...store.row } : null, error: null };
      },
    };
    return b;
  };

  return { db: { from } as never, store };
}

const BOUND_ROW = { user_id: "u1", ...OWNER_ROW, verification_token: "passcontrol-verify-A" };

/** Start a check and pause it at the outbound fetch, the way a slow host would. */
function heldCheck() {
  let release!: (value: { ok: boolean; reason?: string }) => void;
  let reached!: () => void;
  const atTheFetch = new Promise<void>((resolve) => {
    reached = resolve;
  });
  h.verifyDomainMock.mockImplementation(() => {
    reached();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  return { atTheFetch, release: (r: { ok: boolean; reason?: string }) => release(r) };
}

describe("a check in flight cannot stamp a claim it never checked", () => {
  // The exploit: hold acme.com's valid response open, re-point the binding at a
  // domain nobody has proved anything about, then let the response land.
  it("refuses to promote a claim that was replaced mid-check", async () => {
    const { db, store } = ledger(BOUND_ROW);
    const held = heldCheck();

    const inFlight = verifyOwnerDomain(db, "u1");
    await held.atTheFetch;

    // The window. A Server Action is addressable by id, so a disabled button in
    // the UI is not what stops this.
    expect((await setOwner(db, "u1", { kind: "domain", subject: "evil.example" })).ok).toBe(true);

    held.release({ ok: true });
    const result = await inFlight;

    expect(store.row).toMatchObject({ subject: "evil.example", tier: "unverified" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(409);
    expect(result.ok === false && result.code).toBe("owner_changed");
  });

  // The subtler half: the subject never changes, so a kind+subject filter would
  // still match. Re-declaring resets the proof and issues a new token, and that
  // reset is exactly what a stale success would undo.
  it("refuses to promote the same domain re-declared mid-check", async () => {
    const { db, store } = ledger({ ...BOUND_ROW, tier: "unverified" });
    const held = heldCheck();

    const inFlight = verifyOwnerDomain(db, "u1");
    await held.atTheFetch;

    await setOwner(db, "u1", { kind: "domain", subject: "acme.com" });
    const reissued = store.row!.verification_token;
    expect(reissued).not.toBe(BOUND_ROW.verification_token);

    held.release({ ok: true });
    const result = await inFlight;

    expect(store.row).toMatchObject({ tier: "unverified", verification_token: reissued });
    expect(result.ok === false && result.code).toBe("owner_changed");
  });

  // Failure is conditioned too: a stale failure must not spend one of the three
  // strikes belonging to a binding that was never checked.
  it("refuses to charge a failure to a claim that was replaced mid-check", async () => {
    const { db, store } = ledger({ ...BOUND_ROW, tier: "domain", failure_count: 2 });
    const held = heldCheck();

    const inFlight = verifyOwnerDomain(db, "u1");
    await held.atTheFetch;
    await setOwner(db, "u1", { kind: "domain", subject: "evil.example" });

    held.release({ ok: false, reason: "not_published" });
    const result = await inFlight;

    expect(store.row).toMatchObject({ failure_count: 0, tier: "unverified" });
    expect(result.ok === false && result.code).toBe("owner_changed");
  });

  it("still promotes the claim it actually checked", async () => {
    const { db, store } = ledger(BOUND_ROW);
    h.verifyDomainMock.mockResolvedValue({ ok: true });

    const result = await verifyOwnerDomain(db, "u1");

    expect(result.ok).toBe(true);
    expect(store.row).toMatchObject({
      subject: "acme.com",
      tier: "domain",
      verification_token: BOUND_ROW.verification_token,
    });
  });

  it("still counts a failure against the claim it actually checked", async () => {
    const { db, store } = ledger({ ...BOUND_ROW, tier: "domain", failure_count: 1 });
    h.verifyDomainMock.mockResolvedValue({ ok: false, reason: "unreachable" });

    const result = await verifyOwnerDomain(db, "u1");

    expect(result.ok).toBe(true);
    expect(store.row).toMatchObject({ tier: "domain", failure_count: 2 });
  });

  // A database that is down is not a row that moved. Reporting one as the other
  // would tell an operator their binding changed when nothing of the sort
  // happened, and would hide a real outage.
  it("reports a genuine write failure as a failure, not a conflict", async () => {
    h.verifyDomainMock.mockResolvedValue({ ok: true });
    const { db, store } = ledger(BOUND_ROW);
    store.writeError = { code: "57P01" };

    const result = await verifyOwnerDomain(db, "u1");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(500);
    expect(result.ok === false && result.code).toBe("write_failed");
  });
});

describe("a cache blip never fails a write that landed", () => {
  // The database write is durable; the cache purge is not. Throwing here would
  // return 500 for a mutation that actually succeeded, so the caller retries a
  // change already applied. The only real cost of a missed purge is a stale
  // owner claim on receipts until the 300s TTL expires.
  it("still reports success when purging the owner cache fails", async () => {
    h.purgeMock.mockRejectedValue(new Error("redis down"));

    const result = await setOwner(db(), "u1", { kind: "self_attested", subject: "Acme Ltd" });

    expect(result.ok).toBe(true);
    expect(h.upsertMock).toHaveBeenCalled();
  });

  it("still reports success on a verification whose cache purge fails", async () => {
    h.purgeMock.mockRejectedValue(new Error("redis down"));
    h.verifyDomainMock.mockResolvedValue({ ok: true });

    const result = await verifyOwnerDomain(db(), "u1");

    expect(result.ok).toBe(true);
    expect(h.updateMock).toHaveBeenCalledWith(expect.objectContaining({ tier: "domain" }));
  });
});
