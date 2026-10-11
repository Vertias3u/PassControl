import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0083: the kill switches' durable record, on a real Postgres.
 *
 * A tenant's master kill, its per-service kills and its per-session stops used to
 * live in Redis only, so losing Redis silently lifted every one of them (proved
 * live 2026-10-10). `kill_switch_records` holds one row per ARMED stop; the
 * gateway rebuilds Redis from it (lib/state/killswitch.ts).
 *
 * The table names which of a tenant's agents and sessions are stopped, so it is
 * locked like every tenant table: RLS on, a tenant reads only its own rows, and
 * NO write path but the service role (the dashboard and the control API write
 * through it after checking the owner in code). Stock Supabase grants every new
 * public table to anon and authenticated, and 0025 narrowed only FUNCTION
 * defaults, so the privilege test restores stock defaults inside its rolled-back
 * transaction: the result is 0083's own revoke, not something that happened to
 * be true already (the trap 0082's test fell into first).
 *
 * Every test runs inside begin … rollback; the local database is never changed.
 * Privileges are asked with has_table_privilege, never `set role`.
 *
 * Creating (or dropping) the table takes a SHARE ROW EXCLUSIVE lock on `users`
 * and `agents`, for its foreign keys, while the other *.db tests write those
 * tables in parallel: taken one at a time, that deadlocked them (seen
 * 2026-10-10). So each transaction takes both up front with NOWAIT and starts
 * over when either is busy. It never waits while holding one, so it is never
 * part of a deadlock cycle; the others only wait for its short transaction.
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const MIGRATION_URL = new URL("../db/migrations/0083_kill_switch_records.sql", import.meta.url);
const MIGRATION = existsSync(MIGRATION_URL) ? readFileSync(MIGRATION_URL, "utf8") : "select 'missing 0083' :: int;";

const LOCK_BUSY = /could not obtain lock|deadlock detected/;

function psqlOnce(sql: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"],
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return { ok: true, out };
  } catch (error) {
    const e = error as { stderr?: Buffer | string; stdout?: Buffer | string };
    return { ok: false, out: String(e.stderr ?? "") + String(e.stdout ?? "") };
  }
}
function psql(sql: string): { ok: boolean; out: string } {
  for (let attempt = 0; ; attempt++) {
    const result = psqlOnce(sql);
    if (result.ok || !LOCK_BUSY.test(result.out) || attempt >= 50) return result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + Math.floor(Math.random() * 150));
  }
}
const live = psql("select 1 from public.agents limit 1;").ok;

const STOCK_DEFAULTS =
  "alter default privileges in schema public grant all on tables to public, anon, authenticated;\n";

/** 0083 applied fresh (the table dropped first, as on a database before it), then `body`. */
function inMigrated(body: string, { stock = false } = {}) {
  return psql(
    `begin;\nset local client_min_messages = warning;\n` +
      `lock table public.users, public.agents in share row exclusive mode nowait;\n${stock ? STOCK_DEFAULTS : ""}` +
      `drop table if exists public.kill_switch_records;\n${MIGRATION}\n` +
      `create temp table t_agent on commit drop as select id as agent_id, user_id from public.agents where user_id is not null order by created_at limit 1;\n` +
      `${body}\nrollback;\n`
  );
}

const insert = (cols: string, values: string) =>
  `insert into public.kill_switch_records (user_id, ${cols}) select user_id, ${values} from t_agent;`;

describe.skipIf(!live)("0083 kill_switch_records, on a real Postgres", () => {
  it("holds one row per armed stop, of each kind", () => {
    const r = inMigrated(
      [
        insert("kind", "'tenant'"),
        insert("kind, service", "'service', 'github'"),
        insert("kind, agent_id, session_id", "'session', agent_id, 'claude-code:abc.1'"),
        "select string_agg(kind, ',' order by kind) from public.kill_switch_records;",
      ].join("\n")
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.out).toBe("service,session,tenant");
  });

  it("refuses a row whose fields do not fit its kind", () => {
    for (const bad of [
      insert("kind, service", "'tenant', 'github'"),
      insert("kind", "'service'"),
      insert("kind, service", "'service', 'Not A Service!'"),
      insert("kind, session_id", "'session', 'abc'"),
      insert("kind, agent_id, session_id", "'session', agent_id, 'bad session id'"),
      insert("kind", "'everything'"),
    ]) {
      const r = inMigrated(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.out).toMatch(/check constraint|violates/);
    }
  });

  it("records each stop once: arming twice is a unique violation the code treats as already armed", () => {
    for (const row of [
      insert("kind", "'tenant'"),
      insert("kind, service", "'service', 'github'"),
      insert("kind, agent_id, session_id", "'session', agent_id, 's1'"),
    ]) {
      const r = inMigrated(`${row}\n${row}`);
      expect(r.ok, row).toBe(false);
      expect(r.out).toMatch(/duplicate key value/);
    }
  });

  it("goes with its tenant, and a session stop goes with its agent", () => {
    // Both foreign keys cascade: an erased account or a deleted agent leaves no
    // stop behind that names it. Read from the catalog: deleting a real agent
    // here would run into every other table that holds one.
    const fk = inMigrated(
      "select confrelid::regclass::text || ':' || confdeltype::text from pg_constraint where conrelid = 'public.kill_switch_records'::regclass and contype = 'f' order by 1;"
    );
    expect(fk).toMatchObject({ ok: true });
    expect(fk.out.split("\n")).toEqual(["agents:c", "users:c"]);

  });

  it("indexes the lead column of each foreign key, so a cascade never scans the table", () => {
    const r = inMigrated(
      "select a.attname || '=' || exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]) " +
        "from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] " +
        "where c.conrelid = 'public.kill_switch_records'::regclass and c.contype = 'f' order by 1;"
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.out.split("\n")).toEqual(["agent_id=true", "user_id=true"]);
  });

  it("is readable by its tenant only, and writable by the service role only", () => {
    const privs = ["select", "insert", "update", "delete"];
    const roles = ["anon", "authenticated", "service_role"];
    const r = inMigrated(
      [
        ...roles.flatMap((role) =>
          privs.map((p) => `select '${role}.${p}=' || has_table_privilege('${role}', 'public.kill_switch_records', '${p}');`)
        ),
        "select 'public=' || exists (select 1 from pg_class c, aclexplode(c.relacl) x where c.oid = 'public.kill_switch_records'::regclass and x.grantee = 0);",
        "select 'rls=' || relrowsecurity from pg_class where oid = 'public.kill_switch_records'::regclass;",
        "select 'policies=' || string_agg(cmd || ':' || array_to_string(roles, '+') || ':' || coalesce(qual, ''), ' | ') from pg_policies where tablename = 'kill_switch_records';",
      ].join("\n"),
      { stock: true }
    );
    expect(r).toMatchObject({ ok: true });
    const out = r.out.split("\n");
    expect(out.slice(0, 12)).toEqual([
      "anon.select=false",
      "anon.insert=false",
      "anon.update=false",
      "anon.delete=false",
      "authenticated.select=true",
      "authenticated.insert=false",
      "authenticated.update=false",
      "authenticated.delete=false",
      "service_role.select=true",
      "service_role.insert=true",
      "service_role.update=false",
      "service_role.delete=true",
    ]);
    expect(out[12]).toBe("public=false");
    expect(out[13]).toBe("rls=true");
    expect(out[14]).toMatch(/^policies=SELECT:authenticated:\(user_id = \( SELECT auth\.uid\(\)/);
    expect(out[14]).not.toContain("|");
  });
});
