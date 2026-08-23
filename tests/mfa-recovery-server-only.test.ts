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
  it("never touches mfa_recovery_codes with the user-scoped client at all", () => {
    // 0029 revoked insert/update/delete from `authenticated`; 0031 revokes SELECT
    // too, so ANY user-scoped access to this table is now both broken and the
    // bypass. The ban is on the method-agnostic shape deliberately: the previous
    // version of this test banned only the three writes, which is why the read
    // survived a security pass. The service path reads `admin.` / `serviceClient()`.
    expect(source).not.toMatch(/\bsupabase\s*\n?\s*\.from\(\s*"mfa_recovery_codes"\s*\)/);
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

  // ── PC-MFA-RECOVERY-HASH-001 ────────────────────────────────────────────────
  // What used to be here asserted the opposite: "still lets the Security panel
  // read its own remaining count", matching `.from("mfa_recovery_codes").select(`
  // on the user-scoped client. It described the projection the app asks for
  // (`count`) and mistook it for the capability the database grants (`SELECT`,
  // every column, caller's choice via PostgREST). That is the whole bug, pinned
  // as an invariant. It is inverted here.
  it("counts remaining codes through the service role, not the browser's grant", () => {
    const body = functionBody("getMfaStatus");
    expect(body).toMatch(/serviceClient\(\)\s*\n?\s*\.from\("mfa_recovery_codes"\)/);
  });

  it("scopes the service-role count by the server-verified user id", () => {
    // service_role has rolbypassrls, so RLS is no longer the tenant boundary
    // here — this filter is. `user.id` comes from getUser() in the same request
    // and is never an argument the browser can supply.
    const body = functionBody("getMfaStatus");
    expect(body).toMatch(/\.eq\("user_id",\s*user\.id\)/);
    expect(source).not.toMatch(/export async function getMfaStatus\([^)]+\)/);
  });

  it("keeps the recovery table out of the account export's user-scoped reads", () => {
    // loadAccountExport(db, user, admin) renders `mfaRecoveryCodeCount` and was the
    // second reader of this table through the user client — revoking SELECT would
    // have 503'd the export endpoint. The count moves to `admin` for the same
    // reason getMfaStatus's did.
    const lifecycle = readFileSync(join(process.cwd(), "lib/account-lifecycle.ts"), "utf8");
    expect(lifecycle).not.toMatch(/\bdb\s*\n?\s*\.from\(\s*"mfa_recovery_codes"\s*\)/);
    // Matched on the exact receiver, not on "the word admin appears nearby" — the
    // loose version would have kept passing against a reverted `db.from(...)` with
    // `admin` mentioned in the comment above it.
    expect(lifecycle).toMatch(/\n\s*admin\.from\("mfa_recovery_codes"\)\.select\(/);
  });

  // ── Atomic replacement (the reliability half) ───────────────────────────────
  it("replaces a recovery-code set in one transaction, never DELETE-then-INSERT", () => {
    // Two round trips cannot be all-or-nothing. A failed INSERT after a committed
    // DELETE leaves the user with no backup codes at all; a failed DELETE after a
    // committed INSERT leaves the OLD codes valid while the operator believes they
    // were replaced (new hashes are random, so they do not collide the set away).
    for (const name of ["verifyMfaEnrollment", "regenerateRecoveryCodes"]) {
      const body = functionBody(name);
      expect(body, `${name} must not DELETE the set client-side`).not.toMatch(
        /\.from\("mfa_recovery_codes"\)\s*\n?\s*\.delete\(/
      );
      expect(body, `${name} must not INSERT the set client-side`).not.toMatch(
        /\.from\("mfa_recovery_codes"\)\s*\n?\s*\.insert\(/
      );
      expect(body, `${name} must replace through the atomic RPC`).toMatch(/replaceRecoveryCodes\(/);
    }
  });

  it("hands the plaintext codes back only after the replacement committed", () => {
    // Returning them first would show the user ten codes the database never stored.
    for (const name of ["verifyMfaEnrollment", "regenerateRecoveryCodes"]) {
      const body = functionBody(name);
      const stored = body.indexOf("replaceRecoveryCodes(");
      const returned = body.search(/return \{ recoveryCodes:/);
      expect(stored, `${name} must store`).toBeGreaterThan(-1);
      expect(returned, `${name} must return the codes`).toBeGreaterThan(-1);
      expect(stored, `${name} must store before it returns`).toBeLessThan(returned);
      expect(body, `${name} must bail out when the replacement fails`).toMatch(
        /if \(!(stored|replaced)\) return \{ error:/
      );
    }
  });

  it("clears rather than replaces on the two reset paths", () => {
    // Clearing is NOT replacing, and the distinction is load-bearing in both
    // directions. `replace_mfa_recovery_codes_for_user` rejects an empty array on
    // purpose, so that a caller bug can never wipe someone's backup codes while
    // looking like an issuance — which means routing these two through it would
    // fail at runtime. Equally, relaxing that guard so they COULD use it would
    // reopen the hole it exists to close. Pinned so a later tidy-up does neither.
    for (const name of ["submitLoginMfa", "unenrollMfa"]) {
      const body = functionBody(name);
      expect(body, `${name} clears the set outright`).toMatch(
        /serviceClient\(\)\.from\("mfa_recovery_codes"\)\.delete\(\)/
      );
      expect(body, `${name} must not go through the replacement RPC`).not.toMatch(/replaceRecoveryCodes\(/);
    }
  });

  it("routes the replacement through the service-role-only RPC", () => {
    const body = functionBody("replaceRecoveryCodes");
    expect(body).toMatch(/serviceClient\(\)\s*\n?\s*\.rpc\(\s*"replace_mfa_recovery_codes_for_user"/);
    expect(body).toMatch(/p_user_id/);
  });
});
