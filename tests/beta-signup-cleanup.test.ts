import { beforeEach, describe, expect, it, vi } from "vitest";

const INVITE_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => {
  const signOut = vi.fn(async () => ({ error: null }));
  const signUp = vi.fn();
  const rpc = vi.fn();
  const deleteUser = vi.fn();
  const captureError = vi.fn(async () => undefined);
  return { signOut, signUp, rpc, deleteUser, captureError };
});

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.9" })),
  cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })),
}));
vi.mock("@/lib/supabase/server", () => ({
  userClient: vi.fn(async () => ({ auth: { signUp: mocks.signUp, signOut: mocks.signOut } })),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: vi.fn(() => ({ rpc: mocks.rpc, auth: { admin: { deleteUser: mocks.deleteUser } } })),
}));
vi.mock("@/lib/observability", () => ({ captureError: mocks.captureError }));
vi.mock("@/lib/auth/emailRedirect", () => ({ authEmailRedirect: vi.fn(() => undefined) }));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 29 })),
}));
vi.mock("@/lib/auth/lockout", () => ({
  isLockedOut: vi.fn(async () => false),
  recordLoginFailure: vi.fn(),
  clearLoginFailures: vi.fn(),
}));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn(), maskEmail: (email: string) => email }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/mfa", () => ({ needsMfaStepUp: vi.fn(async () => false) }));

import { signup } from "@/app/actions/auth";

function signupForm() {
  const form = new FormData();
  form.set("email", "invitee@example.test");
  form.set("password", "Correct-Horse-Battery-Staple-42!");
  form.set("invite_token", "A".repeat(43));
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PASSCONTROL_SIGNUP_MODE", "invite");
  vi.stubEnv("PASSCONTROL_INVITE_SOURCE", "database");
  mocks.signUp.mockResolvedValue({
    data: {
      user: { id: "22222222-2222-4222-8222-222222222222", identities: [{ id: "identity-1" }] },
      session: null,
    },
    error: null,
  });
  mocks.rpc.mockImplementation(async (name: string) => name === "claim_beta_invite"
    ? { data: [{ invite_id: INVITE_ID }], error: null }
    : { data: true, error: null });
  mocks.deleteUser.mockResolvedValue({ error: null });
  mocks.signOut.mockResolvedValue({ error: null });
});

describe("database invitation signup cleanup", () => {
  it("clears the browser session even when redemption and admin deletion both fail", async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === "claim_beta_invite"
      ? { data: [{ invite_id: INVITE_ID }], error: null }
      : { data: false, error: { message: "redeem unavailable" } });
    mocks.deleteUser.mockResolvedValue({ error: { message: "delete unavailable" } });

    await expect(signup(undefined, signupForm())).resolves.toEqual({
      error: "Invitation setup did not finish. Ask for a new invitation before retrying.",
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: "invite_redeem_cleanup_failed" })
    );
  });

  it("preserves a successful pending-confirmation signup session state", async () => {
    await expect(signup(undefined, signupForm())).resolves.toEqual({
      success: "Check your email to confirm the account, then return here to sign in.",
    });
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
