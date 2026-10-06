import { describe, expect, it } from "vitest";
import { curated, source } from "./support/curated-source";

// Self-host is one developer on localhost (owner, 2026-10-05). The auth surface
// built for a public sign-up page — a bot check, a "send the link again" flow,
// a confirm page for custom email templates — has nobody to serve there. These
// assertions read each file the way scripts/curate-public.sh publishes it.

const FORMS = [
  "components/auth/LoginForm.tsx",
  "components/auth/SignupForm.tsx",
  "components/auth/ForgotPasswordForm.tsx",
] as const;

describe("self-host auth surface", () => {
  it("renders no bot check, and its site key is always off", () => {
    for (const path of FORMS) {
      const form = curated(path);
      expect(form, path).not.toContain("TurnstileWidget");
      expect(form, path).not.toContain("turnstileSiteKey");
    }
    // The server side (token forwarding, a named failure) is untouched and
    // still tested; with the key fixed off, the CSP never admits Cloudflare.
    expect(curated("lib/auth/turnstile-config.ts")).toMatch(
      /export function turnstileSiteKey\(\): string \| null \{\s*return null;\s*\}/u
    );
  });

  it("offers no resend-confirmation flow and no custom-template confirm route", () => {
    expect(curated("components/auth/LoginForm.tsx")).not.toContain("Send the link again");
    expect(curated("app/actions/auth.ts")).not.toContain("export async function resendConfirmation");
    const middleware = curated("middleware.ts");
    const publicPaths = middleware.slice(
      middleware.indexOf("const PUBLIC_PATHS"),
      middleware.indexOf("];", middleware.indexOf("const PUBLIC_PATHS"))
    );
    expect(publicPaths).toContain('"/login"');
    expect(publicPaths).toContain('"/auth/callback"');
    expect(publicPaths).not.toContain('"/auth/confirm"');
  });

  it("tells a signed-out visitor that sign-up is off on a local install", () => {
    expect(curated("components/auth/LoginForm.tsx")).toContain("Sign-up is off on this local install.");
  });
});

describe("the local stack defaults sign-up off, and keeps a mode someone chose", () => {
  const script = source("scripts/dev-stack.sh");
  const preserve = script.slice(script.indexOf('if [[ -f "$ENVF" ]]'), script.indexOf('cat > "$ENVF"'));
  const heredoc = script.slice(script.indexOf('cat > "$ENVF"'), script.indexOf("\nEOF"));

  it("writes closed unless the previous file said otherwise", () => {
    expect(preserve).toContain(
      `PASSCONTROL_SIGNUP_MODE=$(grep '^PASSCONTROL_SIGNUP_MODE=' "$ENVF" | cut -d= -f2- || true)`
    );
    expect(heredoc).toContain("PASSCONTROL_SIGNUP_MODE=${PASSCONTROL_SIGNUP_MODE:-closed}");
  });
});
