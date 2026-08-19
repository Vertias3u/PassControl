// Recovery codes are the back door to the credential gate, so they get the same
// treatment the credentials themselves get.
//
// The chain this pins, in order, because no single link looks alarming alone:
//   1. /login/verify treats a non-6-digit entry as an EMERGENCY RESET and
//      unenrolls the TOTP factor. That is deliberate, not a bug: a recovery
//      code cannot raise Supabase's assurance level, so the only thing it can
//      usefully do is reset the factor for someone who lost their phone.
//   2. lib/mfa.ts passes any session for an account with NO verified factor,
//      which is correct: there is no step-up left to clear.
//   3. So whoever can put a row in `mfa_recovery_codes` — or can ask the app for
//      a valid code — can remove the factor and then walk through the strict
//      gate by the front door, minting credentials through the same service-role
//      path tests/credential-mint-server-only.test.ts pins.
//
// That defeats 0028 entirely, which is why it is pinned separately rather than
// folded in. `db/tests/rls_invariants.sql` holds the matching privilege half
// (0029); this file holds the application half.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "app/dashboard/mfa-actions.ts"), "utf8");

function functionBody(name: string): string {
  const start = source.search(new RegExp(`^(?:export )?async function ${name}\\b`, "m"));
  expect(start, `${name} not found in app/dashboard/mfa-actions.ts`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?async function \w/m);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe("MFA recovery codes are issued and consumed server-side", () => {
  it("never writes mfa_recovery_codes with the user-scoped client", () => {
    // 0029 revokes insert/update/delete from `authenticated`; a user-scoped write
    // here would be both broken and the bypass.
    expect(source).not.toMatch(/supabase\s*\n?\s*\.from\("mfa_recovery_codes"\)\s*\.(insert|update|delete)\(/);
    expect(source).not.toMatch(/supabase\.from\("mfa_recovery_codes"\)\.(insert|update|delete)\(/);
  });

  it("consumes a code through the service role, scoped by the verified user id", () => {
    const body = functionBody("submitLoginMfa");
    // consumeRecoveryCode UPDATEs used_at — the single-use mechanism.
    expect(body).toMatch(/consumeRecoveryCode\(\s*serviceClient\(\),\s*user\.id/);
    expect(body).not.toMatch(/consumeRecoveryCode\(\s*supabase\b/);
  });

  // Every action that can ADD or REMOVE a factor, or mint codes that redeem into
  // removing one. Enrolment is in the list because `enrollMfa` returns a NEW
  // factor's secret to the caller: passing challengeAndVerify afterwards proves
  // possession of a factor the caller just minted, never of the victim's, and
  // verifying it wipes the real recovery codes and returns ten fresh ones.
  const MUST_GATE = ["enrollMfa", "verifyMfaEnrollment", "regenerateRecoveryCodes", "unenrollMfa"];

  it.each(MUST_GATE)("%s is gated on the strict helper", (name) => {
    expect(functionBody(name)).toMatch(/mfaBlockedReason\(/);
  });

  it("routes the gate through the strict, fail-closed helper", () => {
    expect(functionBody("mfaBlockedReason")).toMatch(/mfaAuthorizedUser\(/);
    expect(source).not.toMatch(/needsMfaStepUp/);
  });

  it("returns the refusal instead of throwing, so the panel can render it", () => {
    // Every one of these is typed `… | { error: string }` and MfaManager.tsx
    // branches on `"error" in result`. A throw skips that branch entirely.
    expect(functionBody("mfaBlockedReason")).not.toMatch(/throw new Error/);
    for (const name of MUST_GATE) {
      expect(functionBody(name)).toMatch(/if \(blocked\) return \{ error: blocked \}/);
    }
  });

  it("gates BEFORE touching factor state, not after", () => {
    for (const name of MUST_GATE) {
      const body = functionBody(name);
      const gate = body.indexOf("mfaBlockedReason(");
      // `await` matters: regenerateRecoveryCodes' OWN name contains
      // generateRecoveryCodes(, which otherwise matches at offset 0 and makes
      // this assertion unfailable.
      const act = body.search(/mfa\.unenroll\(|mfa\.enroll\(|challengeAndVerify\(|await generateRecoveryCodes\(/);
      expect(gate, `${name} must consult the gate`).toBeGreaterThan(-1);
      expect(act, `${name} must touch factor state`).toBeGreaterThan(-1);
      expect(gate, `${name} must gate before it acts`).toBeLessThan(act);
    }
  });

  it("keeps the emergency reset reachable at aal1", () => {
    // The whole point of a recovery code is that the user CANNOT step up. Gating
    // submitLoginMfa would lock out exactly the person it exists for. After 0029
    // it can only match codes the server actually issued, which is what makes
    // leaving it ungated safe.
    expect(functionBody("submitLoginMfa")).not.toMatch(/mfaBlockedReason\(/);
  });

  it("still lets the Security panel read its own remaining count", () => {
    expect(functionBody("getMfaStatus")).toMatch(/\.from\("mfa_recovery_codes"\)\s*\n?\s*\.select\(/);
  });
});
