import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("account lifecycle", () => {
  it("exports tenant data through explicit secret-free column allowlists", async () => {
    const lifecycle = await source("lib/account-lifecycle.ts");
    for (const table of [
      "agents",
      "agent_logs",
      "provider_credentials",
      "api_keys",
      "admin_audit",
      "agent_owners",
      "break_glass_grants",
      "agent_access_keys",
    ]) {
      expect(lifecycle).toContain(`table: \"${table}\"`);
    }
    for (const secret of ["key_hash", "vault_secret_id", "code_hash", "verification_token"]) {
      expect(lifecycle).not.toMatch(new RegExp(`columns:[^\\n]*${secret}`));
    }
    expect(lifecycle).toContain('.eq("user_id", user.id)');
    expect(lifecycle).toContain("ACCOUNT_EXPORT_SCHEMA_VERSION");
    expect(lifecycle).toContain('select("id,application_id,expires_at,sent_at,claimed_at,redeemed_at,revoked_at,created_at")');
    expect(lifecycle).not.toMatch(/select\([^\n]*token_hash/);
  });

  it("requires the strict MFA gate before exporting or deleting", async () => {
    const [exportRoute, action] = await Promise.all([
      source("app/api/account/export/route.ts"),
      source("app/dashboard/settings/account-actions.ts"),
    ]);
    expect(exportRoute).toContain("mfaAuthorizedUser(db)");
    expect(action).toContain("mfaAuthorizedUser(db)");
    expect(exportRoute).not.toContain("needsMfaStepUp");
    expect(action).not.toContain("needsMfaStepUp");
  });

  it("arms revocation before erasure and removes Auth only after database cleanup", async () => {
    const action = await source("app/dashboard/settings/account-actions.ts");
    const kill = action.indexOf("armTenantKill(user.id, true)");
    const database = action.indexOf('rpc("delete_account_data"');
    const auth = action.indexOf("auth.admin.deleteUser(user.id)");
    const redis = action.lastIndexOf("purgeAccountRuntimeState");
    expect(kill).toBeGreaterThan(-1);
    expect(database).toBeGreaterThan(kill);
    expect(auth).toBeGreaterThan(database);
    expect(redis).toBeGreaterThan(auth);
    expect(action).toContain("DELETE MY ACCOUNT");
  });

  it("captures runtime cleanup ids inside the locked erasure transaction", async () => {
    const [action, migration] = await Promise.all([
      source("app/dashboard/settings/account-actions.ts"),
      source("db/migrations/0024_account_lifecycle.sql"),
    ]);
    const kill = action.indexOf("armTenantKill(user.id, true)");
    const database = action.indexOf('rpc("delete_account_data"');
    expect(kill).toBeGreaterThan(-1);
    expect(database).toBeGreaterThan(kill);
    expect(action).not.toContain('db.from("agents").select("id")');
    expect(action).not.toContain('db.from("api_keys").select("id")');
    expect(action).toContain("parseDeletionInventory");
    expect(migration).toMatch(/returns jsonb/i);
    expect(migration).toMatch(/array_agg\(a\.id\)[\s\S]*from public\.agents/i);
    expect(migration).toMatch(/array_agg\(k\.id\)[\s\S]*from public\.api_keys/i);
    expect(migration).toMatch(/jsonb_build_object[\s\S]*agent_ids[\s\S]*control_api_key_ids/i);
  });

  it("keeps the destructive database function off the client API", async () => {
    const migration = await source("db/migrations/0024_account_lifecycle.sql");
    expect(migration).toMatch(/function public\.delete_account_data\(p_user_id uuid\)/i);
    expect(migration).toMatch(/revoke all on function public\.delete_account_data\(uuid\) from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.delete_account_data\(uuid\) to service_role/i);
  });

  it("uses the profile cascade for immutable logs, then removes orphaned keys and Vault secrets", async () => {
    const migration = await source("db/migrations/0024_account_lifecycle.sql");
    const logs = migration.search(/agent_logs[\s\S]*on delete cascade/i);
    const profile = migration.search(/delete from public\.users/i);
    const keys = migration.search(/delete from public\.agent_access_keys/i);
    const vault = migration.search(/delete from vault\.secrets/i);
    expect(logs).toBeGreaterThan(-1);
    expect(profile).toBeGreaterThan(logs);
    expect(keys).toBeGreaterThan(profile);
    expect(vault).toBeGreaterThan(keys);
    expect(migration).toMatch(/provider_credentials[\s\S]*user_id = p_user_id/i);
    expect(migration).not.toMatch(/delete from public\.agent_logs/i);
  });

  it("makes export available before a two-step destructive confirmation", async () => {
    const [settings, component] = await Promise.all([
      source("app/dashboard/settings/page.tsx"),
      source("components/AccountLifecycle.tsx"),
    ]);
    expect(settings).toContain("<AccountLifecycle");
    expect(settings).toContain('href="#account-data"');
    expect(component).toContain('href="/api/account/export"');
    expect(component).toContain("DELETE MY ACCOUNT");
    expect(component).toContain("This cannot be undone");
  });
});
