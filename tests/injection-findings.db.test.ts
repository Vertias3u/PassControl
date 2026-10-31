import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0089: what the injection guard found, on a real Postgres (plans/injection-guard.md).
 *
 * What these tests hold:
 *   * every row is shaped: fixed vocabularies, patterns with `is not null` beside them,
 *     an HMAC that is 64 hex characters, never free text;
 *   * a re-sent block is a no-op, not a second row (unique per tenant, agent, HMAC and
 *     detector), including for the service role holding only INSERT;
 *   * rows go with their tenant and agent, and both foreign keys are indexed;
 *   * append-only: the tenant reads its own rows, the service role reads and inserts,
 *     nobody updates or deletes one, and the retention functions are service-role only.
 *
 * Grants are checked with has_*_privilege, never by calling denied things under `set
 * role` (that crashes the local PG 17.6 image). Every test runs inside begin … rollback,
 * as in client-reported-calls.db.test.ts; the table is created inside each transaction.
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const MIGRATION_URL = new URL("../db/migrations/0089_injection_findings.sql", import.meta.url);
const MIGRATION = existsSync(MIGRATION_URL) ? readFileSync(MIGRATION_URL, "utf8") : "select 'missing 0089' :: int;";
const SIDECAR_URL = new URL("../db/migrations/0090_injection_findings_sidecar.sql", import.meta.url);
const SIDECAR = existsSync(SIDECAR_URL) ? readFileSync(SIDECAR_URL, "utf8") : "select 'missing 0090' :: int;";

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

const TABLE = "public.injection_findings";

function inMigrated(body: string, { stock = false, sidecar = false } = {}) {
  return psql(
    `begin;\nset local client_min_messages = warning;\n` +
      `lock table public.users, public.agents in share row exclusive mode nowait;\n${stock ? STOCK_DEFAULTS : ""}` +
      `drop table if exists ${TABLE};\n${MIGRATION}\n${sidecar ? `${SIDECAR}\n` : ""}` +
      `create temp table t_agent on commit drop as select id as agent_id, user_id from public.agents where user_id is not null order by created_at limit 1;\n` +
      `${body}\nrollback;\n`
  );
}

const HMAC = `'${"ab".repeat(32)}'`;
const COLS = "surface, source, path, families, severity, detector, normalization_version, content_hmac, provider, model";
const GOOD = `'proxy', 'tool_result', 'messages[2].content[0].content', array['instruction_override','exfil_directive'], 'high', 'pc-heuristic-1', 1, ${HMAC}, 'anthropic', 'claude-haiku-4-5'`;
/** One row from t_agent's tenant and agent; `values` replaces GOOD. */
const insert = (values = GOOD, suffix = "") =>
  `insert into ${TABLE} (user_id, agent_id, ${COLS}) select user_id, agent_id, ${values} from t_agent${suffix};`;
const withField = (index: number, value: string) => {
  const parts = GOOD.split(/, (?![^[]*\])/);
  parts[index] = value;
  return parts.join(", ");
};

describe.skipIf(!live)("0089 injection_findings, on a real Postgres", () => {
  it("holds a finding", () => {
    const r = inMigrated(`${insert()}\nselect source || ':' || severity || ':' || array_to_string(families, '+') || ':' || detector from ${TABLE};`);
    expect(r).toMatchObject({ ok: true, out: "tool_result:high:instruction_override+exfil_directive:pc-heuristic-1" });
  });

  it("refuses a row that does not fit its shape", () => {
    for (const bad of [
      withField(0, "'sidecar_typo'"),
      withField(1, "'Tool Result'"),
      withField(2, "'messages[0]; drop table x'"),
      withField(2, `'${"a".repeat(513)}'`),
      withField(3, "array[]::text[]"),
      withField(3, "array['made_up_family']"),
      withField(4, "'medium'"),
      withField(5, "'PC Heuristic'"),
      withField(6, "0"),
      withField(7, "'not-hex'"),
      withField(7, `'${"ab".repeat(31)}'`),
      withField(7, "null"),
      withField(8, "'Anthropic!'"),
      withField(9, "'model with spaces'"),
    ]) {
      const r = inMigrated(insert(bad));
      expect(r.ok, bad).toBe(false);
      expect(r.out).toMatch(/check constraint|violates|out of range|null value/);
    }
  });

  it("makes a re-sent block a no-op: one row per tenant, agent, HMAC and detector", () => {
    const dup = inMigrated(`${insert()}\n${insert()}`);
    expect(dup.ok).toBe(false);
    expect(dup.out).toMatch(/duplicate key value/);
    const conflict = " on conflict (user_id, agent_id, content_hmac, detector) do nothing";
    const idempotent = inMigrated(`${insert(GOOD, conflict)}\n${insert(GOOD, conflict)}\nselect count(*) from ${TABLE};`);
    expect(idempotent).toMatchObject({ ok: true, out: "1" });
    // A new detector is a new finding about the same block.
    const nextDetector = inMigrated(`${insert()}\n${insert(withField(5, "'pc-heuristic-2'"))}\nselect count(*) from ${TABLE};`);
    expect(nextDetector).toMatchObject({ ok: true, out: "2" });
  });

  it("lets the service role write with only INSERT: on conflict do nothing needs no UPDATE", () => {
    const upsert = insert(GOOD, " on conflict (user_id, agent_id, content_hmac, detector) do nothing");
    const r = inMigrated(`grant select on t_agent to service_role;\nset local role service_role;\n${upsert}\n${upsert}\nselect count(*) from ${TABLE};`, { stock: true });
    expect(r).toMatchObject({ ok: true, out: "1" });
  });

  // The hold taints only on rows the table inserted (lib/injection-findings.ts): PostgREST's
  // ignore-duplicates upsert with select is this statement, so a re-sent block returns none.
  it("returns only the rows it inserted: a re-sent block returns nothing to taint on", () => {
    const upsert = insert(GOOD, " on conflict (user_id, agent_id, content_hmac, detector) do nothing returning content_hmac");
    const r = inMigrated(`grant select on t_agent to service_role;\nset local role service_role;\n${upsert}\n${upsert}`, { stock: true });
    expect(r).toMatchObject({ ok: true, out: "ab".repeat(32) });
  });

  it("goes with its tenant and its agent, and indexes both foreign keys", () => {
    const fk = inMigrated(
      `select confrelid::regclass::text || ':' || confdeltype::text from pg_constraint where conrelid = '${TABLE}'::regclass and contype = 'f' order by 1;`
    );
    expect(fk).toMatchObject({ ok: true });
    expect(fk.out.split("\n")).toEqual(["agents:c", "users:c"]);
    const leading = inMigrated(
      `select string_agg(pg_get_indexdef(indexrelid), E'\\n') from pg_index where indrelid = '${TABLE}'::regclass;`
    );
    expect(leading.out).toMatch(/\(user_id, agent_id, content_hmac, detector\)/);
    expect(leading.out).toMatch(/\(agent_id, user_id, created_at DESC\)/);
  });

  it("is append-only and tenant-scoped, even over stock defaults", () => {
    const r = inMigrated(
      [
        `select relrowsecurity from pg_class where oid = '${TABLE}'::regclass;`,
        `select string_agg(r || ':' || p || ':' || has_table_privilege(r, '${TABLE}', p)::text, ',' order by r, p)
           from unnest(array['anon','authenticated','service_role']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;`,
        `select string_agg(polname || ':' || pg_get_expr(polqual, polrelid), ',') from pg_policy where polrelid = '${TABLE}'::regclass;`,
        `select string_agg(r || ':' || has_function_privilege(r, 'public.prune_injection_findings(uuid, uuid)', 'EXECUTE')::text || ':' ||
                has_function_privilege(r, 'public.purge_injection_findings()', 'EXECUTE')::text, ',' order by r)
           from unnest(array['anon','authenticated','service_role']) r;`,
      ].join("\n"),
      { stock: true }
    );
    expect(r).toMatchObject({ ok: true });
    const [rls, grants, policies, fns] = r.out.split("\n");
    expect(rls).toBe("t");
    expect(grants).toBe(
      [
        "anon:DELETE:false", "anon:INSERT:false", "anon:SELECT:false", "anon:UPDATE:false",
        "authenticated:DELETE:false", "authenticated:INSERT:false", "authenticated:SELECT:true", "authenticated:UPDATE:false",
        "service_role:DELETE:false", "service_role:INSERT:true", "service_role:SELECT:true", "service_role:UPDATE:false",
      ].join(",")
    );
    expect(policies).toMatch(/^injection_findings_select_own:\(user_id = \( SELECT auth\.uid\(\)/);
    expect(fns).toBe("anon:false:false,authenticated:false:false,service_role:true:true");
  });

  it("ages out only rows older than 30 days, and only the named agent's", () => {
    const r = inMigrated(
      [
        insert(),
        insert(withField(7, `'${"cd".repeat(32)}'`)),
        `update ${TABLE} set created_at = now() - interval '31 days' where content_hmac = ${HMAC};`,
        `select public.prune_injection_findings((select agent_id from t_agent), (select user_id from t_agent));`,
        `select public.prune_injection_findings(gen_random_uuid(), (select user_id from t_agent));`,
        `select count(*) from ${TABLE};`,
      ].join("\n")
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.out.split("\n")).toEqual(["1", "0", "1"]);
  });
});

describe.skipIf(!live)("0090 sidecar findings, on a real Postgres", () => {
  const insertSidecar = (tool: string) =>
    `insert into ${TABLE} (user_id, agent_id, ${COLS}, tool_name) select user_id, agent_id, ${withField(0, "'sidecar'")}, ${tool} from t_agent;`;

  it("refuses a sidecar row before 0090, and holds one after it", () => {
    expect(inMigrated(insertSidecar("'WebFetch'")).ok).toBe(false);
    const r = inMigrated(`${insertSidecar("'mcp__github__get_file'")}\nselect surface || ':' || tool_name from ${TABLE};`, { sidecar: true });
    expect(r).toMatchObject({ ok: true, out: "sidecar:mcp__github__get_file" });
  });

  it("still holds a proxy row, with no tool name", () => {
    expect(inMigrated(`${insert()}\nselect surface || ':' || coalesce(tool_name, '-') from ${TABLE};`, { sidecar: true })).toMatchObject({
      ok: true,
      out: "proxy:-",
    });
  });

  it("refuses a tool name on a proxy row, and one that does not fit its shape", () => {
    const proxyWithTool = `insert into ${TABLE} (user_id, agent_id, ${COLS}, tool_name) select user_id, agent_id, ${GOOD}, 'WebFetch' from t_agent;`;
    for (const sql of [proxyWithTool, insertSidecar("'bad tool name'"), insertSidecar(`'${"x".repeat(129)}'`)]) {
      const r = inMigrated(sql, { sidecar: true });
      expect(r.ok, sql).toBe(false);
      expect(r.out).toMatch(/check constraint/);
    }
  });

  it("applies twice without error, and changes no grant", () => {
    const r = inMigrated(
      `${SIDECAR}\nselect string_agg(r || ':' || p || ':' || has_column_privilege(r, '${TABLE}', 'tool_name', p)::text, ',' order by r, p)
         from unnest(array['anon','authenticated','service_role']) r, unnest(array['SELECT','INSERT','UPDATE']) p;`,
      { sidecar: true, stock: true }
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.out).toBe(
      [
        "anon:INSERT:false", "anon:SELECT:false", "anon:UPDATE:false",
        "authenticated:INSERT:false", "authenticated:SELECT:true", "authenticated:UPDATE:false",
        "service_role:INSERT:true", "service_role:SELECT:true", "service_role:UPDATE:false",
      ].join(",")
    );
  });
});
