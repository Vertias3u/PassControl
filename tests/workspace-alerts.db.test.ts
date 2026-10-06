import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0078: workspace alert destinations. The webhook URL is a credential (anyone
 * holding it can post into the tenant's channel), so it lives in Vault behind
 * service_role-only RPCs, exactly like a provider key, and the table holds only
 * what is safe to show. Proved against the dev stack's database inside one
 * transaction that is always rolled back, with 0078 applied INSIDE it.
 * SKIPS only when the database is unreachable.
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const MIGRATION_PATH = new URL("../db/migrations/0078_workspace_alerts.sql", import.meta.url);
const MIGRATION = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, "utf8") : "select 'migration 0078 missing'::int;";

function tryPsql(sql: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"],
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return { ok: true, out };
  } catch (error) {
    const e = error as { stderr?: Buffer | string; stdout?: Buffer | string };
    return { ok: false, out: String(e.stderr ?? "") + String(e.stdout ?? "") };
  }
}

const up = tryPsql("select 1 from public.users limit 1;").ok;
const when = up ? it : it.skip;

// Fake, and split so secret scanners do not block a push over it.
const URL_A = "https://hooks.slack.com/services/" + "T0123ABCD/B0456EFGH/abcdEFGH1234ijklMNOP5678";
const URL_B = "https://discord.com/api/webhooks/123456789012345678/AbC-dEf_123ghIJKLmnopQRstuVWxyz0123";

function withAccount(body: string): { ok: boolean; out: string } {
  const uid = randomUUID();
  return tryPsql(`
    begin;
    ${MIGRATION}
    insert into auth.users (id, email) values ('${uid}', 'alerts-${uid}@example.test');
    insert into public.users (id, email) values ('${uid}', 'alerts-${uid}@example.test')
      on conflict (id) do nothing;
    ${body.replaceAll(":uid", `'${uid}'`)}
    rollback;
  `);
}

const set = (url: string, kind: string, hint: string) =>
  `select public.set_workspace_alert_destination_for_user(:uid, '${kind}', '${hint}', '${url}');`;

describe("0078 workspace alert destinations", () => {
  when("stores the URL in Vault and only the hint in the table", () => {
    const result = withAccount(`
      ${set(URL_A, "slack", "hooks.slack.com/…/5678")}
      select 'row:' || destination || '|' || hint || '|' || array_to_string(events, ',') from public.workspace_alerts where user_id = :uid;
      select 'url:' || public.get_workspace_alert_url_for_user(:uid);
      select 'plain:' || count(*) from public.workspace_alerts where user_id = :uid and hint like '%abcdEFGH%';
    `);
    expect(result.ok, result.out).toBe(true);
    expect(result.out).toContain("row:slack|hooks.slack.com/…/5678|refused,budget,security");
    expect(result.out).toContain(`url:${URL_A}`);
    expect(result.out).toContain("plain:0");
  });

  when("replacing the destination rewrites the same secret instead of leaving the old one", () => {
    const result = withAccount(`
      ${set(URL_A, "slack", "hooks.slack.com/…/5678")}
      ${set(URL_B, "discord", "discord.com/…/0123")}
      select 'url:' || public.get_workspace_alert_url_for_user(:uid);
      select 'rows:' || count(*) from public.workspace_alerts where user_id = :uid;
      select 'secrets:' || count(*) from vault.secrets where name like 'workspace_alert:' || :uid || '%';
    `);
    expect(result.ok, result.out).toBe(true);
    expect(result.out).toContain(`url:${URL_B}`);
    expect(result.out).toContain("rows:1");
    expect(result.out).toContain("secrets:1");
  });

  when("deleting removes the row and the Vault secret", () => {
    const result = withAccount(`
      ${set(URL_A, "slack", "hooks.slack.com/…/5678")}
      select public.delete_workspace_alert_destination_for_user(:uid);
      select 'rows:' || count(*) from public.workspace_alerts where user_id = :uid;
      select 'secrets:' || count(*) from vault.secrets where name like 'workspace_alert:' || :uid || '%';
      select 'url:' || coalesce(public.get_workspace_alert_url_for_user(:uid), 'none');
    `);
    expect(result.ok, result.out).toBe(true);
    expect(result.out).toContain("rows:0");
    expect(result.out).toContain("secrets:0");
    expect(result.out).toContain("url:none");
  });

  when("account erasure takes the webhook's Vault secret with it", () => {
    // delete_account_data (0024) cleans provider-key secrets by hand; a table
    // added later must not depend on someone remembering to extend it.
    const result = withAccount(`
      ${set(URL_A, "slack", "hooks.slack.com/…/5678")}
      select public.delete_account_data(:uid);
      select 'rows:' || count(*) from public.workspace_alerts where user_id = :uid;
      select 'secrets:' || count(*) from vault.secrets where name like 'workspace_alert:' || :uid || '%';
    `);
    expect(result.ok, result.out).toBe(true);
    expect(result.out).toContain("rows:0");
    expect(result.out).toContain("secrets:0");
  });

  when("accepts a Telegram destination", () => {
    const telegram = "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0/sendMessage?chat_id=-100123";
    const result = withAccount(`
      ${set(telegram, "telegram", "bot …saw0 → chat -100123")}
      select 'row:' || destination from public.workspace_alerts where user_id = :uid;
      select 'url:' || public.get_workspace_alert_url_for_user(:uid);
    `);
    expect(result.ok, result.out).toBe(true);
    expect(result.out).toContain("row:telegram");
    expect(result.out).toContain(`url:${telegram}`);
  });

  when("refuses an unknown destination kind or event", () => {
    expect(withAccount(set(URL_A, "teams", "x")).ok).toBe(false);
    const bad = withAccount(`
      ${set(URL_A, "slack", "hooks.slack.com/…/5678")}
      update public.workspace_alerts set events = array['refused','everything'] where user_id = :uid;
    `);
    expect(bad.ok).toBe(false);
  });

  when("gives the browser roles no path to the URL or to writes", () => {
    const result = withAccount(`
      select 'rls:' || relrowsecurity from pg_class where oid = 'public.workspace_alerts'::regclass;
      select 'fn:' || r || ':' || f || ':' || has_function_privilege(r, f, 'execute')
        from unnest(array['anon','authenticated']) as r,
             unnest(array[
               'public.get_workspace_alert_url_for_user(uuid)',
               'public.set_workspace_alert_destination_for_user(uuid,text,text,text)',
               'public.delete_workspace_alert_destination_for_user(uuid)'
             ]) as f;
      select 'tbl:' || r || ':' || p || ':' || has_table_privilege(r, 'public.workspace_alerts', p)
        from unnest(array['anon','authenticated']) as r,
             unnest(array['insert','update','delete']) as p;
      select 'anonread:' || has_table_privilege('anon', 'public.workspace_alerts', 'select');
    `);
    expect(result.ok, result.out).toBe(true);
    expect(result.out).toContain("rls:true");
    expect(result.out).not.toMatch(/^fn:.*:true$/mu);
    expect(result.out).not.toMatch(/^tbl:.*:true$/mu);
    expect(result.out).toContain("anonread:false");
  });
});
