// The MFA gate on a credential mint is only worth as much as the DATABASE
// privilege underneath it.
//
// `tests/credential-action-mfa.test.ts` already pins that every minting Server
// Action calls `requireCredentialMfa`. That test passed the whole time the bypass
// was live, because the gap was never in the gate — it was that the same write was
// independently reachable without it. `createApiKey` minted with the USER-SCOPED
// client, so the legitimate mint already travelled over PostgREST authenticated by
// the caller's own JWT; an attacker holding an aal1 session for an MFA-enrolled
// account replayed that request minus the Server Action wrapper. RLS accepted it,
// because RLS asks who owns the row, not whether this session cleared a second
// factor.
//
// So this file pins the OTHER half: the mint runs with the service role, and the
// tenant id it writes comes from the verified server-side user rather than from
// anything the caller supplied. `db/tests/rls_invariants.sql` pins the matching
// privilege revocations (0028) against a real Postgres; the two together are the
// boundary. Neither is sufficient alone — service-role code over a table that
// `authenticated` can still INSERT is exactly the state this replaced.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "app/dashboard/actions.ts"), "utf8");

/** Slice one function body out of the actions module, exported or not. */
function functionBody(name: string): string {
  const start = source.search(new RegExp(`^(?:export )?async function ${name}\\b`, "m"));
  expect(start, `${name} not found in app/dashboard/actions.ts`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?async function \w/m);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe("credential minting runs server-side, not as the dashboard user", () => {
  it("mints a pc_ control-plane key with the service role", () => {
    const body = functionBody("createApiKey");
    expect(body).toMatch(/serviceClient\(\)\s*\.from\("api_keys"\)\s*\.insert\(/);
    // The precise regression: a user-scoped insert here is the replayable request.
    expect(body).not.toMatch(/\bdb\s*\.from\("api_keys"\)\s*\.insert\(/);
  });

  it("registers a passport with the service role", () => {
    const body = functionBody("createAgentForUser");
    expect(body).toMatch(/fleet\.createAgent\(\s*serviceClient\(\)/);
    expect(body).not.toMatch(/fleet\.createAgent\(\s*db\b/);
  });

  it("keeps the mint behind the gate — service role WIDENS reach, so order matters", () => {
    // A service-role write bypasses RLS entirely, so the MFA gate stops being
    // defence-in-depth and becomes the only check. It must run first, and against
    // this same request's verified user.
    for (const name of ["createApiKey", "createAgentForUser"]) {
      const body = functionBody(name);
      const gate = body.indexOf("requireCredentialMfa(");
      const write = body.search(/serviceClient\(\)|fleet\.createAgent\(/);
      expect(gate, `${name} must call requireCredentialMfa`).toBeGreaterThan(-1);
      expect(write, `${name} must perform a service-role write`).toBeGreaterThan(-1);
      expect(gate, `${name} must gate BEFORE it writes`).toBeLessThan(write);
    }
  });

  it("never lets a caller choose the tenant a credential is minted for", () => {
    // The one way to turn a service-role mint into something worse than the bug it
    // replaced: accept a user id from input and hand it to a client that bypasses
    // RLS. Both sinks must write the id derived from requireUser()/getUser().
    expect(functionBody("createApiKey")).toMatch(/user_id:\s*user\.id/);
    expect(functionBody("createAgentForUser")).toMatch(/fleet\.createAgent\(\s*serviceClient\(\),\s*user\.id/);
    expect(source).not.toMatch(/input\.user_id|input\.userId/);
  });

  // 0030 drops store/rotate/set_active/delete_provider_key — the auth.uid()
  // variants that `authenticated` could execute straight over /rest/v1/rpc,
  // skipping the gate. They never crossed a tenant (every body constrained on
  // `user_id = v_uid`), which is why this was the mildest of the three findings:
  // an aal1 caller could add a key, overwrite a secret it cannot read, redirect
  // billing, or destroy a credential — sabotage, not theft.
  const PROVIDER_RPCS = [
    ["addProviderKeyForUser", "store_provider_key_for_user"],
    ["rotateProviderKey", "rotate_provider_key_for_user"],
    ["setActiveProviderKey", "set_active_provider_key_for_user"],
    ["deleteProviderKey", "delete_provider_key_for_user"],
  ] as const;

  it.each(PROVIDER_RPCS)("%s calls %s through the service role", (fn, rpc) => {
    const body = functionBody(fn);
    expect(body).toMatch(new RegExp(`serviceClient\\(\\)\\.rpc\\("${rpc}"`));
    // The tenant is an explicit argument now, so it must be the verified user.
    expect(body).toMatch(/p_user_id:\s*user\.id/);
  });

  it("retires every auth.uid()-derived provider-key RPC name", () => {
    // Calling one of these by its old name would now hit a dropped function, but
    // the point is the shape: a user-scoped .rpc() for a credential mutation is
    // the bypass, whatever it is named.
    for (const legacy of [
      "store_provider_key",
      "rotate_provider_key",
      "set_active_provider_key",
      "delete_provider_key",
    ]) {
      expect(source).not.toMatch(new RegExp(`\\.rpc\\("${legacy}"`));
    }
    expect(source).not.toMatch(/\bdb\.rpc\(/);
  });

  it("leaves the ungated stops on the user-scoped client", () => {
    // Every credential keeps at least one stop reachable without a step-up, and a
    // revoke is a column-scoped UPDATE that `authenticated` still holds (0012).
    // Moving it to the service role would be a quiet privilege upgrade for the
    // one path deliberately left ungated.
    const body = functionBody("revokeApiKey");
    expect(body).toMatch(/\bdb\s*\n?\s*\.from\("api_keys"\)/);
    expect(body).not.toMatch(/serviceClient\(\)/);
  });
});
