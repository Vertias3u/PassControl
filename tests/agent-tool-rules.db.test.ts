import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0085: an agent's tool rules (subscription mode, Phase 2), on a real Postgres.
 *
 * `agents.tool_rules` is a column of its own, not a key under `policy`: the policy
 * parser refuses the WHOLE policy on any key it does not know, so an older gateway
 * would refuse every model call of an agent with tool rules in its policy. Like
 * `service_rules` (0074) it is shaped here (an object, bounded in size), written only
 * by a validating server action (no column UPDATE for a browser session), and
 * re-validated by whoever reads it (cli/tool-rules.mjs).
 *
 * Every test runs inside begin … rollback; the database is never changed.
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const MIGRATION_URL = new URL("../db/migrations/0084_client_reported_calls.sql", import.meta.url);
const MIGRATION = existsSync(MIGRATION_URL) ? readFileSync(MIGRATION_URL, "utf8") : "select 'missing 0084' :: int;";

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

const MIGRATION_0085 = (() => {
  const url = new URL("../db/migrations/0085_agent_tool_rules.sql", import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : "select 'missing 0085' :: int;";
})();

function inMigrated(body: string) {
  return psql(
    `begin;\nset local client_min_messages = warning;\n` +
      `lock table public.agents in access exclusive mode nowait;\n` +
      `alter table public.agents drop column if exists tool_rules;\n${MIGRATION_0085}\n` +
      `create temp table t_agent on commit drop as select id from public.agents order by created_at limit 1;\n` +
      `${body}\nrollback;\n`
  );
}
const set = (value: string) => `update public.agents set tool_rules = ${value} where id = (select id from t_agent);`;

describe.skipIf(!live)("0085 agent tool rules (real Postgres)", () => {
  it("adds a nullable column, null on every existing agent", () => {
    const r = inMigrated("select count(*) filter (where tool_rules is not null) from public.agents;");
    expect(r).toMatchObject({ ok: true, out: "0" });
  });

  it("stores an object", () => {
    const r = inMigrated(`${set(`'{"rules":[{"tool":"Bash","command":"git push*","effect":"ask_owner"}]}'::jsonb`)}\nselect tool_rules->'rules'->0->>'effect' from public.agents where id = (select id from t_agent);`);
    expect(r).toMatchObject({ ok: true, out: "ask_owner" });
  });

  it.each([["a list", `'[]'::jsonb`], ["a string", `'"deny"'::jsonb`]])("refuses %s", (_why, value) => {
    const r = inMigrated(set(value));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/agents_tool_rules_object/);
  });

  it("refuses a document past the size bound", () => {
    const r = inMigrated(set(`jsonb_build_object('rules', (select jsonb_agg(md5(i::text) || repeat('x', 300)) from generate_series(1, 2000) i))`));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/agents_tool_rules_size/);
  });

  it("is never written by a browser session; the server reads and writes it", () => {
    const r = inMigrated(
      ["anon", "authenticated", "service_role"]
        .map((role) => `select '${role}=' || has_column_privilege('${role}', 'public.agents', 'tool_rules', 'UPDATE') || '/' || has_column_privilege('${role}', 'public.agents', 'tool_rules', 'SELECT');`)
        .join("\n")
    );
    expect(r).toMatchObject({ ok: true });
    // anon's SELECT is the table-level grant every agents column has (policy and
    // service_rules too); RLS gives it no rows. What 0085 must not add is an UPDATE.
    expect(r.out.split("\n")).toEqual(["anon=false/true", "authenticated=false/true", "service_role=true/true"]);
  });
});
