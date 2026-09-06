import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ getMock: vi.fn(), setMock: vi.fn() }));

vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));
vi.mock("@/lib/state/redis", () => ({
  getCachedOwner: (...a: unknown[]) => h.getMock(...a),
  setCachedOwner: (...a: unknown[]) => h.setMock(...a),
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
