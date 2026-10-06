// Live, 2026-10-04: sign-up was flipped to open while PASSCONTROL_INVITE_SOURCE
// stayed "database", and the form showed no submit button at all. It waited
// for a personal invitation token that open sign-up never sends. The wait
// belongs to invite mode only.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The tests resolve React 18, which lacks these hooks; the app runs React 19.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useActionState: (action: unknown, initial: unknown) => [initial, action, false],
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: false }),
}));
vi.mock("@/app/actions/auth", () => ({ signup: vi.fn() }));

const { SignupForm } = await import("@/components/auth/SignupForm");

const submit = /<button type="submit"[^>]*>[\s\S]*?Create account/;

describe("the sign-up submit button", () => {
  it("shows in open mode even when database invitations are configured", () => {
    expect(renderToStaticMarkup(<SignupForm mode="open" inviteSource="database" />)).toMatch(submit);
  });

  it("shows in open mode with shared codes", () => {
    expect(renderToStaticMarkup(<SignupForm mode="open" inviteSource="shared" />)).toMatch(submit);
  });

});
