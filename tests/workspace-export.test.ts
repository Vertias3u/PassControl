import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@/lib/audit";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

// Seven columns across the 34 migrations would leak credential material if a
// column allowlist ever named one. Six distinct strings cover them, because
// `key_hash` is the column name on BOTH api_keys and agent_access_keys:
//
//   provider_credentials.vault_secret_id   api_keys.key_hash
//   agent_access_keys.key_hash             mfa_recovery_codes.code_hash
//   agent_owners.verification_token        beta_invites.token_hash
//   users.avatar_key
//
// `avatar_key` is the one that does not announce itself. It matches no
// *_hash / *_secret pattern and reads like display metadata, but it is a live
// capability token for /avatars/<key> — a working URL for anyone holding the
// file. The account export excludes it in prose only (lib/account-lifecycle.ts);
// here it is a test.
// `avatar_path` joins them here, which is stricter than the account export's
// list. That export needs it to report whether an avatar exists; this one has
// no reason to touch either avatar column, and the cheapest way to keep a
// capability token out of a file is to have no business reading its neighbour.
const FORBIDDEN_COLUMNS = [
  "vault_secret_id",
  "key_hash",
  "code_hash",
  "verification_token",
  "token_hash",
  "avatar_key",
  "avatar_path",
] as const;

// The inverse list matters just as much. These LOOK like secrets and are not,
// by this repository's own stated definition, and an export that drops them is
// an export an import cannot reconcile against a live workspace.
//   api_keys.key_prefix     — 0008_api_keys.sql:8, "short non-secret display prefix"
//   agent_access_keys.key_suffix — inside the authenticated column grant, 0023:75-76
//   agents.passport_pubkey  — a PUBLIC key; 0021:39-48 argues it at length
describe("workspace configuration export", () => {
  it("builds every table read from an explicit secret-free column allowlist", async () => {
    const workspace = await source("lib/workspace-export.ts");

    for (const table of ["agents", "provider_credentials", "agent_owners", "break_glass_grants"]) {
      expect(workspace).toContain(`table: "${table}"`);
    }

    for (const secret of FORBIDDEN_COLUMNS) {
      expect(
        workspace,
        `${secret} must never appear in a column allowlist`
      ).not.toMatch(new RegExp(`columns:[^\\n]*${secret}`));
    }
  });

  // The builder takes a `userId: string` rather than a Supabase `User`, because
  // the control-plane handler only ever has the former (`lib/control/handler.ts:17`)
  // and that surface runs on the service client, which bypasses RLS — so this
  // filter is not belt-and-braces there, it IS the tenant boundary.
  it("scopes every read to the acting user", async () => {
    const workspace = await source("lib/workspace-export.ts");
    expect(workspace).toContain('.eq("user_id", userId)');
    expect(workspace).not.toMatch(/select\([^\n]*avatar/);
  });

  it("versions the payload shape and derives the release version", async () => {
    const workspace = await source("lib/workspace-export.ts");

    expect(workspace).toContain("WORKSPACE_EXPORT_SCHEMA_VERSION");
    expect(workspace).toContain('"passcontrol-export"');

    // The advertised version renders from lib/version.ts. A bare x.y.z literal
    // here is the drift CLAUDE.md forbids — three surfaces had already reached
    // 0.2.0 / v0.2.x / v0.1.x by 0.4.0 doing exactly this.
    expect(workspace).toContain("RELEASE_VERSION");
    expect(workspace).not.toMatch(/["'`]\d+\.\d+\.\d+["'`]/);
  });

  // Imported, not grepped, and this distinction is the whole point of the test.
  // `buildAuditRecord` throws on an action outside AUDIT_ACTIONS and
  // `recordAdminAction` swallows the throw — so omitting these strings produces
  // no row, no error, and a Recovery panel that reads "never exported" forever.
  // A grep would pass on a commented-out entry; membership in the real constant
  // is the thing that decides whether a row gets written.
  it("registers the audit actions that make Last export true", () => {
    const actions: readonly string[] = AUDIT_ACTIONS;
    expect(actions).toContain("workspace.export");
    expect(actions).toContain("workspace.import");
  });

  it("names what it left out, so a reader of the file knows what it cannot restore", async () => {
    const workspace = await source("lib/workspace-export.ts");
    expect(workspace).toContain("exclusions");
    // The Vault guarantee has to survive contact with the file an operator
    // actually opens, not just the docs nobody reads until it is too late.
    expect(workspace.toLowerCase()).toContain("vault");
  });
});
