import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Per-account object limits (0076), proved against a real Postgres.
 *
 * Two harnesses, both leaving nothing behind:
 *
 *  - Behaviour runs on the dev stack's database inside ONE transaction that is
 *    always rolled back, with 0076 applied INSIDE that transaction. The owner's
 *    local database is never migrated by this file.
 *  - Concurrency needs two sessions that really commit, so it runs in a scratch
 *    database created here, given stand-in tables with the columns the trigger
 *    reads, and dropped at the end.
 *
 * SKIPS only when the database is unreachable.
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const DB = process.env.LIMITS_DB ?? "postgres";
const MIGRATION = readFileSync(
  new URL("../db/migrations/0076_account_object_limits.sql", import.meta.url),
  "utf8"
);

function psql(sql: string, db = DB): string {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tA"],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}

function tryPsql(sql: string, db = DB): { ok: boolean; out: string } {
  try {
    return { ok: true, out: psql(sql, db) };
  } catch (error) {
    const e = error as { stderr?: Buffer | string; stdout?: Buffer | string };
    return { ok: false, out: String(e.stderr ?? "") + String(e.stdout ?? "") };
  }
}

function live(): boolean {
  try {
    psql("select 1 from public.agents limit 1;");
    return true;
  } catch {
    return false;
  }
}

const up = live();
const when = up ? it : it.skip;

/** One rolled-back transaction: 0076, a fresh account, limits, then `body`. */
function scenario(uid: string, limits: string, body: string): { ok: boolean; out: string } {
  return tryPsql(`
    begin;
    ${MIGRATION}
    insert into auth.users (id, email) values ('${uid}', '${uid}@limits.test');
    insert into public.users (id, email) values ('${uid}', '${uid}@limits.test');
    update public.account_object_limits set ${limits} where scope = 'default';
    ${body}
    rollback;
  `);
}

const agent = (uid: string, name = "a") =>
  `insert into public.agents (user_id, name) values ('${uid}', '${name}');`;
const agentWithId = (uid: string, id: string) =>
  `insert into public.agents (id, user_id, name) values ('${id}', '${uid}', 'a');`;
const hash = `substr(md5(random()::text) || md5(random()::text), 1, 43)`;
const agentKey = (uid: string, agentId: string, extra = "") =>
  `insert into public.agent_access_keys (user_id, agent_id, name, key_hash, key_suffix${extra ? ", expires_at" : ""})
   values ('${uid}', '${agentId}', 'k', ${hash}, 'abcdefgh'${extra ? `, ${extra}` : ""});`;
const credential = (uid: string, label: string) =>
  `insert into public.provider_credentials (user_id, provider, label, vault_secret_id)
   values ('${uid}', 'openai', '${label}', gen_random_uuid());`;
const apiKey = (uid: string, expires = "null") =>
  `insert into public.api_keys (user_id, name, key_prefix, key_hash, scope, expires_at)
   values ('${uid}', 'k', 'pc_test', md5(random()::text), 'write', ${expires});`;

describe("account object limits (0076)", () => {
  when("unset limits change nothing: twenty agents go in", () => {
    const uid = randomUUID();
    const result = scenario(uid, "max_agents = null", `${Array.from({ length: 20 }, () => agent(uid)).join("\n")}
      select 'agents=' || count(*) from public.agents where user_id = '${uid}';`);
    expect(result.ok).toBe(true);
    expect(result.out).toContain("agents=20");
  });

  when("refuses the agent past the live cap, naming the kind and the limit", () => {
    const uid = randomUUID();
    const result = scenario(uid, "max_agents = 2", `${agent(uid)}${agent(uid)}${agent(uid)}`);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("account_limit_reached:agents:live:2");
  });

  when("revoked agents do not count toward the live cap", () => {
    const uid = randomUUID();
    const result = scenario(uid, "max_agents = 2", `${agent(uid)}${agent(uid)}
      update public.agents set status = 'revoked' where user_id = '${uid}';
      ${agent(uid)}${agent(uid)}
      select 'live=' || count(*) from public.agents where user_id = '${uid}' and status <> 'revoked';`);
    expect(result.ok).toBe(true);
    expect(result.out).toContain("live=2");
  });

  when("bringing a revoked agent back is refused once it would pass the cap", () => {
    const uid = randomUUID();
    const result = scenario(uid, "max_agents = 1", `${agent(uid, "old")}
      update public.agents set status = 'revoked' where user_id = '${uid}';
      ${agent(uid, "new")}
      update public.agents set status = 'active' where user_id = '${uid}' and name = 'old';`);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("account_limit_reached:agents:live:1");
  });

  when("the daily cap counts revoked creations, so create-revoke churn is bounded", () => {
    const uid = randomUUID();
    const churn = Array.from({ length: 3 }, () =>
      `${agent(uid)} update public.agents set status = 'revoked' where user_id = '${uid}';`
    ).join("\n");
    const result = scenario(uid, "max_agents = 1, max_creations_per_day = 3", `${churn}${agent(uid)}`);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("account_limit_reached:agents:daily:3");
  });

  when("agent keys are capped per agent, and expired or revoked keys do not count", () => {
    const uid = randomUUID();
    const a1 = randomUUID();
    const a2 = randomUUID();
    const ok = scenario(uid, "max_keys_per_agent = 1", `${agentWithId(uid, a1)}${agentWithId(uid, a2)}
      ${agentKey(uid, a1, "now() - interval '1 minute'")}
      ${agentKey(uid, a1)}
      update public.agent_access_keys set revoked_at = now() where agent_id = '${a1}';
      ${agentKey(uid, a1)}
      ${agentKey(uid, a2)}
      select 'keys=' || count(*) from public.agent_access_keys where user_id = '${uid}';`);
    expect(ok.ok).toBe(true);
    // One expired, one revoked, one live on a1; one live on a2.
    expect(ok.out).toContain("keys=4");

    const refused = scenario(uid, "max_keys_per_agent = 1", `${agentWithId(uid, a1)}
      ${agentKey(uid, a1)}${agentKey(uid, a1)}`);
    expect(refused.ok).toBe(false);
    expect(refused.out).toContain("account_limit_reached:agent_keys:live:1");
  });

  when("provider credentials are capped per account", () => {
    const uid = randomUUID();
    const result = scenario(uid, "max_credentials = 2",
      `${credential(uid, "one")}${credential(uid, "two")}${credential(uid, "three")}`);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("account_limit_reached:credentials:live:2");
  });

  when("control-API keys: expired ones (old CLI logins) do not count", () => {
    const uid = randomUUID();
    const ok = scenario(uid, "max_api_keys = 1",
      `${apiKey(uid, "now() - interval '1 day'")}${apiKey(uid, "now() - interval '1 hour'")}${apiKey(uid)}
       select 'ok';`);
    expect(ok.ok).toBe(true);

    const refused = scenario(uid, "max_api_keys = 1", `${apiKey(uid)}${apiKey(uid)}`);
    expect(refused.ok).toBe(false);
    expect(refused.out).toContain("account_limit_reached:api_keys:live:1");
  });

  when("a per-account override beats the default, column by column", () => {
    const uid = randomUUID();
    const result = scenario(uid, "max_agents = 1, max_credentials = 1", `
      insert into public.account_object_limits (scope, max_agents) values ('${uid}', 3);
      ${agent(uid)}${agent(uid)}${agent(uid)}
      ${credential(uid, "one")}
      select 'agents=' || count(*) from public.agents where user_id = '${uid}';
      ${credential(uid, "two")}`);
    // Three agents under the override; the credential cap still comes from the default.
    expect(result.ok).toBe(false);
    expect(result.out).toContain("agents=3");
    expect(result.out).toContain("account_limit_reached:credentials:live:1");
  });

  when("the limits table is invisible to browser sessions", () => {
    const result = tryPsql(`
      begin;
      ${MIGRATION}
      select 'anon=' || has_table_privilege('anon', 'public.account_object_limits', 'select')
        || ' auth=' || has_table_privilege('authenticated', 'public.account_object_limits', 'select')
        || ' rls=' || relrowsecurity
        from pg_class where oid = 'public.account_object_limits'::regclass;
      rollback;`);
    expect(result.ok).toBe(true);
    expect(result.out).toContain("anon=false auth=false rls=true");
  });
});

/** Two sessions racing for the last slot must not both get it. */
describe("account object limits under concurrency (0076)", () => {
  const SCRATCH = `pc_limits_scratch_${process.pid}`;

  when("two sessions inserting the last allowed agent: exactly one wins", async () => {
    psql(`drop database if exists ${SCRATCH};`);
    psql(`create database ${SCRATCH};`);
    try {
      // Stand-ins with exactly the columns the trigger reads. Roles anon,
      // authenticated and service_role are cluster-wide on this server.
      psql(`
        create type public.agent_status as enum ('active', 'suspended', 'revoked');
        create table public.agents (id uuid primary key default gen_random_uuid(), user_id uuid,
          name text, status public.agent_status not null default 'active', created_at timestamptz not null default now());
        create table public.agent_access_keys (id uuid primary key default gen_random_uuid(), user_id uuid, agent_id uuid,
          revoked_at timestamptz, expires_at timestamptz, created_at timestamptz not null default now());
        create table public.provider_credentials (id uuid primary key default gen_random_uuid(), user_id uuid,
          created_at timestamptz not null default now());
        create table public.api_keys (id uuid primary key default gen_random_uuid(), user_id uuid,
          revoked_at timestamptz, expires_at timestamptz, created_at timestamptz not null default now());
        ${MIGRATION}
        update public.account_object_limits set max_agents = 1 where scope = 'default';
      `, SCRATCH);

      const uid = randomUUID();
      const racer = () =>
        new Promise<number>((resolve) => {
          const child = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", SCRATCH, "-v", "ON_ERROR_STOP=1"]);
          child.stdin.end(`begin; insert into public.agents (user_id, name) values ('${uid}', 'race'); select pg_sleep(1.5); commit;`);
          child.on("close", (code) => resolve(code ?? 1));
        });
      const codes = await Promise.all([racer(), racer()]);

      const count = psql(`select count(*) from public.agents where user_id = '${uid}';`, SCRATCH);
      expect(count).toBe("1");
      expect(codes.filter((code) => code === 0)).toHaveLength(1);
    } finally {
      psql(`drop database if exists ${SCRATCH} with (force);`);
    }
  }, 30_000);
});
