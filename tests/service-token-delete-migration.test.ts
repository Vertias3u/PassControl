// 0075: the only token for a service can be deleted.
//
// 0030's delete refuses the credential the gateway is using ("active"), and
// says why: promoting another row would silently change which upstream account
// is billed. For the ONLY token of a service there is no other row to promote,
// so that reason does not apply, and the refusal left an operator unable to
// remove a GitHub token from Vault at all. 0075 lifts the refusal for exactly
// that case and no other: a service (`svc:`) token with no sibling. An LLM
// provider key, and a service token that still has a sibling, are refused as
// before.
//
// Text assertions over the migration, the pattern tests/provider-key-active-
// migration.test.ts uses; the behaviour is also exercised against the local
// database when the migration is applied (see the any-API plan, §11).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(process.cwd(), "db/migrations/0075_delete_last_service_token.sql"), "utf8");
const body = migration.replace(/--[^\n]*/g, "");

describe("0075 delete the last service token", () => {
  it("redefines the one delete function, keeping its signature", () => {
    expect(body).toMatch(
      /create or replace function public\.delete_provider_key_for_user\(\s*p_user_id\s+uuid,\s*p_credential_id\s+uuid\s*\)/i
    );
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = ''/i);
  });

  it("still scopes the row to the tenant it names", () => {
    expect(body).toMatch(/where id = p_credential_id and user_id = p_user_id/i);
  });

  it("lifts the active refusal only for a service token with no sibling", () => {
    expect(body).toMatch(/like 'svc:%'/i);
    expect(body).toMatch(/not exists[\s\S]{0,300}provider = v_provider[\s\S]{0,120}id <> p_credential_id/i);
    expect(body).toMatch(/raise exception 'active_credential'/i);
  });

  it("locks the row it decides about, so a concurrent switch cannot race the check", () => {
    expect(body).toMatch(/from public\.provider_credentials[\s\S]{0,200}for update/i);
  });

  it("still removes the Vault secret with the row", () => {
    expect(body).toMatch(/delete from vault\.secrets where id = v_secret/i);
  });

  it("stays service-role only", () => {
    expect(body).toMatch(/revoke all on function public\.delete_provider_key_for_user\(uuid, uuid\)\s*from public, anon, authenticated/i);
    expect(body).toMatch(/grant execute on function public\.delete_provider_key_for_user\(uuid, uuid\)\s*to service_role/i);
  });

  it("does not cite private documents (the public mirror curates migrations)", () => {
    expect(migration).not.toMatch(/DECISIONS\.md|TEAMSHARE\.md/);
  });
});
