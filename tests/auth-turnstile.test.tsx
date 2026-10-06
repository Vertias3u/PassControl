// Cloudflare Turnstile in front of Supabase Auth (open-signup step 2).
//
// The design rule these tests pin: SUPABASE IS THE ONLY ENFORCER. The app
// forwards the widget's token as `captchaToken` when the form carries one and
// otherwise changes nothing. It never refuses a tokenless submit on its own,
// because then a Turnstile outage, a CSP mistake or an ad-blocker would lock
// every operator out, and undoing that would take an env change plus a
// redeploy. With Supabase deciding, rollback is one dashboard toggle, and the
// code can ship BEFORE captcha is enabled, which is the order it must ship in.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  recordLoginFailure: vi.fn(),
  authEmailRedirect: vi.fn(),
}));

// The test environment resolves the root React 18, which has neither hook; the
// app runs on Next's bundled React 19. A first render needs only the initial
// state, so these stand in faithfully for what renderToStaticMarkup can show.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useActionState: (action: unknown, initial: unknown) => [initial, action, false],
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: false }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.9" })),
  cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })),
}));
vi.mock("@/lib/supabase/server", () => ({
  userClient: vi.fn(async () => ({
    auth: {
      signUp: mocks.signUp,
      signInWithPassword: mocks.signInWithPassword,
      resetPasswordForEmail: mocks.resetPasswordForEmail,
    },
  })),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/lib/observability", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/auth/emailRedirect", () => ({ authEmailRedirect: mocks.authEmailRedirect }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: vi.fn(async () => ({ success: true, remaining: 29 })) }));
vi.mock("@/lib/auth/lockout", () => ({
  isLockedOut: vi.fn(async () => false),
  recordLoginFailure: mocks.recordLoginFailure,
  clearLoginFailures: vi.fn(),
}));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn(), maskEmail: (email: string) => email }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/mfa", () => ({ needsMfaStepUp: vi.fn(async () => false) }));

const { login, signup, requestPasswordReset } = await import("@/app/actions/auth");
const { buildContentSecurityPolicy } = await import("@/lib/csp");
const { needsTurnstile, TURNSTILE_ORIGIN, TURNSTILE_RESPONSE_FIELD } = await import(
  "@/lib/auth/turnstile-config"
);
const { LoginForm } = await import("@/components/auth/LoginForm");
const { SignupForm } = await import("@/components/auth/SignupForm");
const { ForgotPasswordForm } = await import("@/components/auth/ForgotPasswordForm");

const CAPTCHA_FAILED = { code: "captcha_failed", message: "captcha protection: request disallowed" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const credentials = { email: "op@example.test", password: "Correct-Horse-Battery-Staple-42!" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("PASSCONTROL_SIGNUP_MODE", "open");
  mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  mocks.signUp.mockResolvedValue({ data: { user: { id: "u1", identities: [{}] }, session: null }, error: null });
  mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  mocks.authEmailRedirect.mockReturnValue("https://passcontrol.example/login/reset");
});

describe("the widget's token reaches Supabase, and nothing else changes", () => {
  it("login forwards the token as captchaToken", async () => {
    await login(undefined, form({ ...credentials, [TURNSTILE_RESPONSE_FIELD]: "tok-login" }));
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      ...credentials,
      options: { captchaToken: "tok-login" },
    });
  });

  it("signup forwards the token as captchaToken", async () => {
    await signup(undefined, form({ ...credentials, [TURNSTILE_RESPONSE_FIELD]: "tok-signup" }));
    expect(mocks.signUp).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ captchaToken: "tok-signup" }) })
    );
  });

  it("password reset forwards the token beside its redirect", async () => {
    await requestPasswordReset(
      undefined,
      form({ email: credentials.email, [TURNSTILE_RESPONSE_FIELD]: "tok-reset" })
    );
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(credentials.email, {
      redirectTo: "https://passcontrol.example/login/reset",
      captchaToken: "tok-reset",
    });
  });

  it("a form with no token calls Supabase exactly as before: the app never refuses on its own", async () => {
    await login(undefined, form(credentials));
    expect(mocks.signInWithPassword).toHaveBeenCalledWith(credentials);

    await requestPasswordReset(undefined, form({ email: credentials.email }));
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(credentials.email, {
      redirectTo: "https://passcontrol.example/login/reset",
    });
  });
});

describe("a failed human check is named, and is not a wrong password", () => {
  it("login: no lockout strike, and a message that says what to do", async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: CAPTCHA_FAILED });
    const result = await login(undefined, form({ ...credentials, [TURNSTILE_RESPONSE_FIELD]: "spent" }));
    // A strike here would let a broken widget lock a real operator out of
    // their own account.
    expect(mocks.recordLoginFailure).not.toHaveBeenCalled();
    expect(result?.error).toMatch(/human check/i);
  });

  it("login: a real wrong password still counts", async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: { code: "invalid_credentials", message: "x" } });
    await login(undefined, form({ ...credentials, [TURNSTILE_RESPONSE_FIELD]: "tok" }));
    expect(mocks.recordLoginFailure).toHaveBeenCalledWith(credentials.email);
  });

  it("signup: says the human check failed, not that the account could not be created", async () => {
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: CAPTCHA_FAILED });
    const result = await signup(undefined, form({ ...credentials, [TURNSTILE_RESPONSE_FIELD]: "spent" }));
    expect(result?.error).toMatch(/human check/i);
  });

  it("password reset: says so instead of the generic success", async () => {
    // Safe to be specific: a captcha failure does not depend on whether the
    // account exists, so it is no enumeration oracle. The generic success
    // here would hide a broken widget behind "a link is on its way".
    mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: CAPTCHA_FAILED });
    const result = await requestPasswordReset(
      undefined,
      form({ email: credentials.email, [TURNSTILE_RESPONSE_FIELD]: "spent" })
    );
    expect(result?.error).toMatch(/human check/i);
    expect(result?.success).toBeUndefined();
  });
});

describe("one switch decides both the widget and the policy", () => {
  it("is off without a site key, on every path", () => {
    for (const path of ["/login", "/signup", "/login/forgot", "/dashboard"]) {
      expect(needsTurnstile(path)).toBe(false);
    }
  });

  // Core has no bot check (localhost only, owner 2026-10-05): a site key in the
  // environment changes nothing, so the policy never admits Cloudflare either.
  it("stays off in Core even with a site key", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
    for (const path of ["/login", "/signup", "/login/forgot"]) {
      expect(needsTurnstile(path)).toBe(false);
    }
  });

  it("the policy admits Cloudflare's script and frame only when asked", () => {
    const off = buildContentSecurityPolicy({ nonce: "n", isProduction: true });
    expect(off).not.toContain(TURNSTILE_ORIGIN);

    const on = buildContentSecurityPolicy({ nonce: "n", isProduction: true, allowTurnstile: true });
    const directive = (name: string) =>
      on.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toContain(TURNSTILE_ORIGIN);
    // There is no frame-src otherwise, so the iframe would fall back to
    // default-src 'self' and the widget would silently never appear.
    expect(directive("frame-src")).toBe(`frame-src ${TURNSTILE_ORIGIN}`);
    // Nothing else widens.
    expect(directive("connect-src")).not.toContain(TURNSTILE_ORIGIN);
  });
});

describe("the forms render the widget exactly when it is configured", () => {
  const forms = {
    login: () => <LoginForm signupMode="open" />,
    signup: () => <SignupForm mode="open" inviteSource="shared" />,
    forgot: () => <ForgotPasswordForm />,
  };

  for (const [name, render] of Object.entries(forms)) {
    it(`${name}: no widget without a site key`, () => {
      expect(renderToStaticMarkup(render())).not.toContain("data-turnstile");
    });

    it(`${name}: still no widget in Core with a site key`, () => {
      vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
      expect(renderToStaticMarkup(render())).not.toContain("data-turnstile");
    });
  }
});
