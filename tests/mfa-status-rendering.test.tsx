// The Security panel's recovery-code count, in the DOM rather than in the model.
//
// 0031 moved that count behind the service role, which introduced a state the
// panel never had before: the read can FAIL. The deliberate semantics are
// `recoveryRemaining: number | null`, where null means "not known", and the one
// thing null must never do is render like 0 — the panel flips to
// data-state="warning" and says "regenerate soon" at <= 2, and regenerating
// destroys a set of codes that is very probably still perfectly good. A
// transient count query must not be able to talk a user into that.
//
// Asserted on the markup, not on the props, because `npm test` passing has said
// nothing about what renders before: a receipt page once displayed "Signature
// matches ✓" against a FORGED receipt with the whole suite green.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/dashboard/mfa-actions", () => ({
  enrollMfa: async () => ({}), verifyMfaEnrollment: async () => ({}),
  unenrollMfa: async () => ({}), regenerateRecoveryCodes: async () => ({}),
}));

const { MfaManager } = await import("@/components/MfaManager");

const html = (r: number | null) =>
  renderToStaticMarkup(<MfaManager status={{ enrolled: true, recoveryRemaining: r }} />);

describe("MfaManager recovery count rendering", () => {
  it("renders a real count and warns when low", () => {
    expect(html(7)).toContain("7 recovery codes remaining");
    expect(html(7)).toContain('data-state="ready"');
    expect(html(1)).toContain("1 recovery code remaining");
    expect(html(1)).toContain('data-state="warning"');
  });

  it("renders null as unavailable — never as 0, never as a regenerate nudge", () => {
    const out = html(null);
    expect(out).toContain("Recovery code count is temporarily unavailable");
    expect(out).not.toContain("0 recovery code");
    expect(out).not.toContain("regenerate soon");
    expect(out).not.toContain('data-state="warning"');
  });

  it("a genuine zero still warns", () => {
    expect(html(0)).toContain("0 recovery codes remaining");
    expect(html(0)).toContain('data-state="warning"');
  });
});
