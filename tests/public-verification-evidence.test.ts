import { describe, it, expect } from "vitest";

import {
  PUBLIC_OWNER_FIELDS,
  buildPublicOwnerView,
  buildPublicPassportView,
} from "@/lib/verify/passport";

function row(overrides: Record<string, unknown> = {}) {
  return {
    passport_pubkey: "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    owner_kind: "github",
    owner_subject: "octocat",
    owner_tier: "github",
    owner_verified_at: "2026-09-01T00:00:00.000Z",
    owner_company_id: null,
    owner_company_source: null,
    owner_company_name: null,
    owner_company_active: null,
    owner_company_at: null,
    ...overrides,
  };
}

describe("a proven GitHub owner on the public page", () => {
  it("renders as its own tier, not as unverified", () => {
    expect(buildPublicOwnerView(row())).toMatchObject({
      kind: "github",
      subject: "octocat",
      tier: "github",
      verifiedAt: "2026-09-01T00:00:00.000Z",
    });
  });

  // Same discipline as normalizeStatus: drift resolves downward, never upward.
  // A tier this build does not understand rendering as "verified" would be a
  // false claim about somebody's identity on a page that exists to be quoted.
  it("still resolves an unknown tier downward", () => {
    expect(buildPublicOwnerView(row({ owner_tier: "platinum" }))).toMatchObject({
      tier: "unverified",
      verifiedAt: null,
    });
  });
});

describe("the asserted company line", () => {
  it("is a separate object, so no template can render it as the proof", () => {
    const view = buildPublicOwnerView(
      row({
        owner_company_id: "IE6388047V",
        owner_company_source: "vat",
        owner_company_name: "ACME LIMITED",
        owner_company_active: true,
        owner_company_at: "2026-09-01T00:00:00.000Z",
      })
    );

    expect(view?.company).toEqual({
      id: "IE6388047V",
      source: "vat",
      name: "ACME LIMITED",
      active: true,
      checkedAt: "2026-09-01T00:00:00.000Z",
    });
    // The proof is untouched by it. A register lookup is not evidence about this
    // tenant, so it must not appear anywhere the tier is derived from.
    expect(view).toMatchObject({ tier: "github", subject: "octocat" });
  });

  it("is null when the owner has asserted none", () => {
    expect(buildPublicOwnerView(row())?.company).toBeNull();
  });

  // A company line beside tier `unverified` is a legitimate state — somebody
  // named a real registered company and proved control of nothing. Suppressing
  // it would hide a checkable fact; promoting it would be a lie. It renders,
  // and the tier beside it still says nothing was proven.
  it("survives an unverified owner without changing the tier", () => {
    const view = buildPublicOwnerView(
      row({
        owner_kind: "self_attested",
        owner_tier: "unverified",
        owner_verified_at: null,
        owner_company_id: "IE6388047V",
        owner_company_source: "vat",
        owner_company_name: "ACME LIMITED",
        owner_company_active: true,
        owner_company_at: "2026-09-01T00:00:00.000Z",
      })
    );
    expect(view).toMatchObject({ tier: "unverified", verifiedAt: null });
    expect(view?.company).toMatchObject({ id: "IE6388047V" });
  });

  it("drops a company line with no identifier, however much else is present", () => {
    expect(
      buildPublicOwnerView(
        row({ owner_company_id: null, owner_company_name: "ACME LIMITED", owner_company_active: true })
      )?.company
    ).toBeNull();
  });

  it("refuses a register this build does not know", () => {
    expect(
      buildPublicOwnerView(row({ owner_company_id: "XX1", owner_company_source: "companies-house" }))
        ?.company
    ).toBeNull();
  });

  // Missing is not the same as false. `active: null` means the column was never
  // written, and rendering that as "not active" would publish a claim about
  // somebody's company that no register ever made.
  it("treats an unwritten active flag as not active rather than inventing one", () => {
    const view = buildPublicOwnerView(
      row({ owner_company_id: "IE6388047V", owner_company_source: "vat", owner_company_active: null })
    );
    expect(view?.company).toMatchObject({ active: false });
  });

  it("names the company field in the pinned public field list", () => {
    expect([...PUBLIC_OWNER_FIELDS]).toContain("company");
  });

  it("builds the whole view by naming fields, never by spreading the row", () => {
    const view = buildPublicPassportView(row({ user_id: "leak-me", policy: "leak-me" }));
    expect(JSON.stringify(view)).not.toContain("leak-me");
  });
});
