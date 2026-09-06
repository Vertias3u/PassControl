// What the /verify PAGE shows about a deadline.
//
// The API carries `expiresAt` and `retired`, and a JSON field nobody renders is
// a fact nobody reads. The state this file exists for is the superseded key: it
// is genuinely still valid, so the badge says "Valid" — and a page that says
// only that, in green, about a key its operator has already replaced tells a
// true story misleadingly. Assert on the DOM, not on the SDK result. Same
// lesson as the receipt page, where a forged receipt rendered "Signature
// matches ✓" against a green rail while the whole suite stayed green.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PassportCard } from "@/app/verify/[passportId]/PassportCard";
import type { PublicPassportView } from "@/lib/verify/passport";

const base: PublicPassportView = {
  passportId: "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyc28",
  displayId: "Zm9vYmFy…YmFyc28",
  status: "active",
  issuedAt: "2026-07-01T09:30:00.000Z",
  expiresAt: null,
  retired: null,
  owner: null,
};

const render = (view: Partial<PublicPassportView>) =>
  renderToStaticMarkup(<PassportCard passport={{ ...base, ...view }} />);

describe("the deadline on the page", () => {
  it("says a passport never expires when it never expires", () => {
    const html = render({ expiresAt: null });
    expect(html).toContain('data-passport-status="active"');
    expect(html).toMatch(/never expires/i);
  });

  it("shows the expiry date of a live passport", () => {
    expect(render({ expiresAt: "2027-03-04T00:00:00.000Z" })).toMatch(/4 March 2027/);
  });

  it("renders an expired passport as expired, not valid", () => {
    const html = render({ status: "expired", expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(html).toContain('data-passport-status="expired"');
    expect(html).toMatch(/expired/i);
    expect(html).not.toMatch(/This passport is valid/);
  });

  // THE ONE THAT MATTERS. Still valid, so the badge is right — but the page has
  // to say the key has been replaced, or "Valid" reads as "this is the agent's
  // key" when it is the one being retired.
  it("says a superseded key has been replaced, beside the valid badge", () => {
    const html = render({ status: "active", retired: { notValidAfter: "2027-03-04T00:00:00.000Z" } });
    expect(html).toContain('data-passport-retired="true"');
    expect(html).toMatch(/replaced|rotated|superseded/i);
    expect(html).toMatch(/4 March 2027/);
  });

  it("says nothing about rotation for an ordinary current key", () => {
    const html = render({ retired: null });
    expect(html).not.toContain('data-passport-retired="true"');
    expect(html).not.toMatch(/replaced|superseded/i);
  });

  // Rotation always stamps a deadline, so this is unreachable through the
  // product — which is why it must not render as reassuring.
  it("does not invent a date for a retired key with no readable deadline", () => {
    const html = render({ status: "expired", retired: { notValidAfter: null } });
    expect(html).toContain('data-passport-retired="true"');
    expect(html).toMatch(/not recorded/i);
  });
});
