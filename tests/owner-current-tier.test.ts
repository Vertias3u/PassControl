import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ getMock: vi.fn(), setMock: vi.fn(), fenceMock: vi.fn() }));

vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));
vi.mock("@/lib/state/redis", () => ({
  getCachedOwner: (...a: unknown[]) => h.getMock(...a),
  setCachedOwner: (...a: unknown[]) => h.setMock(...a),
  // Mocked EXPLICITLY. Omitted, it is undefined, `readCurrentOwner` catches the
  // throw and carries on with a null fence — so every assertion here would still
  // pass while the mechanism was never exercised. That silence is precisely how
  // the first version of this fence shipped broken.
  readOwnerFence: (...a: unknown[]) => h.fenceMock(...a),
}));

import { readCurrentOwner } from "@/lib/owner/current";

function db(row: Record<string, unknown> | null) {
  const b: any = {
    select: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => b } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getMock.mockResolvedValue(null);
});

// The quiet one. This function carries its own allowlist of tier strings, and a
// tier it does not recognise is silently rewritten to `unverified` — which ALSO
// nulls verified_at on the next line. Add a tier to the database and forget this
// list and nothing errors anywhere: the dashboard reads the row directly and
// says verified, the signed receipt goes out saying unverified, and the two
// disagree permanently with nothing to notice it.
describe("the tiers a receipt is allowed to carry", () => {
  it.each(["domain", "github", "idv"])("carries a proven %s tier through", async (tier) => {
    const claim = await readCurrentOwner(
      db({ kind: tier, subject: "octocat", tier, verified_at: "2026-09-01T00:00:00.000Z" }),
      "u1"
    );
    expect(claim).toMatchObject({ tier, vat: "2026-09-01T00:00:00.000Z" });
  });

  it("still refuses a tier the database should never have produced", async () => {
    const claim = await readCurrentOwner(
      db({ kind: "domain", subject: "acme.com", tier: "platinum", verified_at: "2026-09-01T00:00:00.000Z" }),
      "u1"
    );
    // Unrecognised means unproven, and an unproven tier has no verification date
    // — or the date itself reads as evidence.
    expect(claim).toMatchObject({ tier: "unverified", vat: null });
  });

  it("gives an unverified claim no verification date", async () => {
    const claim = await readCurrentOwner(
      db({ kind: "self_attested", subject: "Acme", tier: "unverified", verified_at: null }),
      "u1"
    );
    expect(claim).toMatchObject({ tier: "unverified", vat: null });
  });

  // Held deliberately: the company line is asserted, not proven, and a signed
  // artifact handed to third parties is the wrong place to debut it. Adding it
  // is its own decision, made the way the policy-revision claim was — additive,
  // optional, with the receipt version unchanged.
  it("does not put the asserted company line into a signed receipt", async () => {
    const claim = await readCurrentOwner(
      db({
        kind: "domain",
        subject: "acme.com",
        tier: "domain",
        verified_at: "2026-09-01T00:00:00.000Z",
        company_id: "IE6388047V",
        company_name: "ACME LIMITED",
      }),
      "u1"
    );
    expect(JSON.stringify(claim)).not.toContain("IE6388047V");
    expect(JSON.stringify(claim)).not.toContain("ACME LIMITED");
  });
});


/**
 * T4-01. The owner claim is copied into `own` and SIGNED, so a claim
 * republished after the operator withdrew it does not merely serve stale data —
 * it becomes a cryptographically valid assertion that outlives the cache entry
 * that produced it, while `/verify` reads live Postgres and disagrees.
 *
 * The one-line assertion is the important one: it fails the moment the fence
 * stops being threaded, which is the exact way the first fence in this codebase
 * shipped broken and green.
 */
describe("the fence the owner fill quotes", () => {
  it("is read before the row, and reaches the fill", async () => {
    h.getMock.mockResolvedValue(null);
    h.fenceMock.mockResolvedValue("owner-fence-1");
    const order: string[] = [];
    h.fenceMock.mockImplementation(async () => {
      order.push("fence");
      return "owner-fence-1";
    });
    const client = db({ kind: "domain", subject: "x.example", tier: "domain", verified_at: null });
    const inner = (client as any).from;
    (client as any).from = (...a: unknown[]) => {
      order.push("select");
      return inner(...a);
    };

    await readCurrentOwner(client as never, "u1");

    expect(order[0]).toBe("fence");
    // Fourth argument. Not a fresh read, not a default.
    expect(h.setMock).toHaveBeenCalledWith("u1", expect.any(String), expect.any(Number), "owner-fence-1");
  });

  it("does not read the fence on a cache hit", async () => {
    h.getMock.mockResolvedValue(JSON.stringify({ kind: "domain", subject: "x.example", tier: "domain" }));
    h.fenceMock.mockResolvedValue(null);

    await readCurrentOwner(db(null) as never, "u1");

    expect(h.fenceMock).not.toHaveBeenCalled();
  });
});
