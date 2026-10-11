import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { retryOnDeadlock } from "./db-deadlock-retry";

/**
 * 0082 (F1): `create_direct_agent` can set a periodic spend limit in the same
 * transaction that creates the agent and its reveal-once key.
 *
 * Proved against the dev stack's real Postgres, inside ONE transaction that is
 * always rolled back with 0082 applied inside it, so the owner's local database
 * is never migrated by this file. SKIPS only when the database is unreachable.
 *
 * The security half matters more than the feature half: a NEW signature of a
 * SECURITY DEFINER function gets EXECUTE for PUBLIC by default, and this one
 * inserts an agent for any `p_user_id` it is handed. So the old signature must
 * be gone (no ambiguous overloads) and the new one callable by service_role only.
 * Privileges are asked with has_function_privilege, never `set role` (which
 * crashes the local image on a denied function call).
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const MIGRATION = readFileSync(
  new URL("../db/migrations/0082_direct_agent_period_limit.sql", import.meta.url),
  "utf8"
);

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
  return retryOnDeadlock(() => psqlOnce(sql));
}
const live = psql("select 1 from public.agents limit 1;").ok;

const NEW_SIG =
  "public.create_direct_agent(uuid, text, jsonb, bigint, integer, text, text, text, timestamptz, text, integer)";
const OLD_SIG = "public.create_direct_agent(uuid, text, jsonb, bigint, integer, text, text, text, timestamptz)";

// 0025 already narrowed the default EXECUTE on new public functions, so on this
// database the migration's own revoke is redundant and a test of the result
// alone could not tell whether 0082 revokes anything. `stock` restores Supabase's
// stock defaults (new functions executable by PUBLIC, anon and authenticated)
// inside the same rolled-back transaction, so the grant result is 0082's alone.
const STOCK_DEFAULTS =
  "alter default privileges in schema public grant execute on functions to public, anon, authenticated;\n";

function inMigrated(body: string, { stock = false } = {}) {
  return psql(
    // Dropping the new signature first makes every run a FRESH creation, as on a
    // database before 0082, even where 0082 is already applied (the local one).
    `begin;\nset local client_min_messages = warning;\n${stock ? STOCK_DEFAULTS : ""}` +
      `drop function if exists ${NEW_SIG};\n${MIGRATION}\n` +
      `create temp table t_user on commit drop as select user_id from public.agents where user_id is not null order by created_at limit 1;\n` +
      `${body}\nrollback;\n`
  );
}

// Two statements: within ONE statement the outer scan of `agents` runs on a
// snapshot taken before the function's own insert, so a join there sees nothing.
function call(extra: string, show = "coalesce(a.budget_period, 'none') || ':' || coalesce(a.budget_period_cents::text, 'null')") {
  return (
    `create temp table t_new on commit drop as select * from public.create_direct_agent(\n` +
    `    p_user_id => (select user_id from t_user), p_name => 'f1-db-test', p_scopes => '[]'::jsonb,\n` +
    `    p_budget_tokens => null, p_budget_cents => null, p_key_name => 'k',\n` +
    `    p_key_hash => '${"H".repeat(43)}', p_key_suffix => 'suffix00'${extra}\n` +
    `  );\n` +
    `select ${show} from public.agents a join t_new r on a.id = r.agent_id;`
  );
}

describe.skipIf(!live)("0082 create_direct_agent period limit, on a real Postgres", () => {
  it("creates the agent with the period limit it is given", () => {
    const r = inMigrated(call(", p_budget_period => 'day', p_budget_period_cents => 2000"));
    expect(r).toMatchObject({ ok: true });
    expect(r.out).toBe("day:2000");
  });

  it("still answers the old call shape, with no limit, so a deploy running older code keeps working", () => {
    const r = inMigrated(call(", p_expires_at => null"));
    expect(r).toMatchObject({ ok: true });
    expect(r.out).toBe("none:null");
  });

  it("refuses half a limit, as the table does", () => {
    const r = inMigrated(call(", p_budget_period => 'day'"));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/agents_budget_period_pair/);
  });

  it("leaves exactly one signature: the old one is dropped, not overloaded", () => {
    const r = inMigrated(
      `select count(*) from pg_proc where proname = 'create_direct_agent' and pronamespace = 'public'::regnamespace;\n` +
        `select to_regprocedure('${OLD_SIG}') is null;`
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.out.split("\n")).toEqual(["1", "t"]);
  });

  it("is callable by service_role only", () => {
    const r = inMigrated(
      ["anon", "authenticated", "public", "service_role"]
        .map((role) =>
          role === "public"
            ? `select 'public=' || exists (select 1 from pg_proc p, aclexplode(p.proacl) x where p.oid = '${NEW_SIG}'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE');`
            : `select '${role}=' || has_function_privilege('${role}', '${NEW_SIG}', 'execute');`
        )
        .join("\n"),
      { stock: true }
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.out.split("\n")).toEqual(["anon=false", "authenticated=false", "public=false", "service_role=true"]);
  });
});
