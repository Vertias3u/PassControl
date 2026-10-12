import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0084: model calls a client REPORTED, on a real Postgres (subscription mode, Phase 1b).
 *
 * A Claude Pro/Max session talks to Anthropic directly, so the gateway never sees its
 * calls. Claude Code's own telemetry reports them to the sidecar, which uploads them
 * here. They are a different kind of fact from `agent_logs`: nobody but the client
 * says they happened, there is no receipt, and their cost is what the call WOULD
 * have cost on the API, never money spent. So they get a table of their own, and
 * `agent_logs` (whose rows are receipt-bearing proof) stays untouched.
 *
 * What these tests hold:
 *   * every row is shaped: patterns with `is not null` beside them, counts bounded,
 *     a cost only on a call and a status only on an error;
 *   * a retried upload is a no-op, not a second row (unique per agent and event key);
 *   * rows go with their tenant and agent, and both foreign keys are indexed;
 *   * append-only: the tenant reads its own rows, the service role reads and inserts,
 *     and nobody updates or deletes one (stock defaults restored first, so the result
 *     is 0084's own revoke).
 *
 * Every test runs inside begin … rollback; the database is never changed. The table
 * is created inside each transaction, so the container may be any local stack at
 * 0083 (LIMITS_DB_CONTAINER). Locks are taken up front with NOWAIT and retried, as
 * in kill-switch-records.db.test.ts, so it never waits while holding one.
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

const STOCK_DEFAULTS =
  "alter default privileges in schema public grant all on tables to public, anon, authenticated;\n";

const TABLE = "public.client_reported_calls";

/** 0084 applied fresh (the table dropped first, as on a database before it), then `body`. */
function inMigrated(body: string, { stock = false } = {}) {
  return psql(
    `begin;\nset local client_min_messages = warning;\n` +
      `lock table public.users, public.agents in share row exclusive mode nowait;\n${stock ? STOCK_DEFAULTS : ""}` +
      `drop table if exists ${TABLE};\n${MIGRATION}\n` +
      `create temp table t_agent on commit drop as select id as agent_id, user_id from public.agents where user_id is not null order by created_at limit 1;\n` +
      `${body}\nrollback;\n`
  );
}

const KEY = "'evt_0123456789abcdef'";
/** One row from t_agent's tenant and agent, with `cols`/`values` added to the minimum. */
const insert = (cols = "", values = "") =>
  `insert into ${TABLE} (user_id, agent_id, event_key, source, kind, auth_method${cols ? `, ${cols}` : ""}) ` +
  `select user_id, agent_id, ${KEY}, 'claude_code_otel', 'model_call', 'passport'${values ? `, ${values}` : ""} from t_agent;`;
const insertRaw = (cols: string, values: string) =>
  `insert into ${TABLE} (user_id, agent_id, ${cols}) select user_id, agent_id, ${values} from t_agent;`;

describe.skipIf(!live)("0084 client_reported_calls, on a real Postgres", () => {
  it("holds a reported call and a reported error, with everything Claude Code reports about them", () => {
    const r = inMigrated(
      [
        insert(
          "client_session, client_agent, model, occurred_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reported_cost_usd_micros, duration_ms",
          "'4f6c1d2e-0000-4000-8000-000000000001', 'general-purpose', 'claude-haiku-5-5', now(), 120, 40, 3000, 0, 1830, 912"
        ),
        insertRaw(
          "event_key, source, kind, auth_method, model, status_code, duration_ms",
          "'evt_fedcba9876543210', 'claude_code_otel', 'model_error', 'direct_key', 'claude-sonnet-5-5', 529, 40"
        ),
        `select string_agg(kind || ':' || auth_method || ':' || coalesce(reported_cost_usd_micros::text, '-') || ':' || coalesce(status_code::text, '-'), ',' order by kind) from ${TABLE};`,
        `select bool_and(received_at is not null) from ${TABLE};`,
      ].join("\n")
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.out.split("\n")).toEqual(["model_call:passport:1830:-,model_error:direct_key:-:529", "t"]);
  });

  it("refuses a row that does not fit its shape", () => {
    for (const bad of [
      // The fixed vocabularies.
      insertRaw("event_key, source, kind, auth_method", `${KEY}, 'someone_else', 'model_call', 'passport'`),
      insertRaw("event_key, source, kind, auth_method", `${KEY}, 'claude_code_otel', 'anything', 'passport'`),
      insertRaw("event_key, source, kind, auth_method", `${KEY}, 'claude_code_otel', 'model_call', 'cookie'`),
      // The event key: generated by the sidecar, never free text.
      insertRaw("event_key, source, kind, auth_method", `'short', 'claude_code_otel', 'model_call', 'passport'`),
      insertRaw("event_key, source, kind, auth_method", `'evt bad key with spaces', 'claude_code_otel', 'model_call', 'passport'`),
      // Declared fields hold the patterns the sidecar and gateway hold them to.
      insert("client_session", "'bad session id'"),
      insert("client_agent", "E'agent\\nX-Injected: 1'"),
      insert("model", "'model with spaces'"),
      // Counts are counts.
      insert("input_tokens", "-1"),
      insert("output_tokens", "1000000000001"),
      insert("reported_cost_usd_micros", "-5"),
      insert("duration_ms", "-1"),
      // A cost belongs to a call, a status to an error.
      insert("status_code", "500"),
      insertRaw(
        "event_key, source, kind, auth_method, reported_cost_usd_micros",
        `${KEY}, 'claude_code_otel', 'model_error', 'passport', 10`
      ),
      insertRaw("event_key, source, kind, auth_method, status_code", `${KEY}, 'claude_code_otel', 'model_error', 'passport', 99`),
    ]) {
      const r = inMigrated(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.out).toMatch(/check constraint|violates|out of range/);
    }
  });

  // Phase 2: what the tool rules decided at Claude Code's PreToolUse hook. The tool's
  // name and the decision, never the command, path or URL it was about.
  const decision = (cols: string, values: string) =>
    insertRaw(`event_key, source, kind, auth_method, ${cols}`, `${KEY}, 'claude_code_otel', 'tool_decision', 'passport', ${values}`);

  it("holds a tool decision: the tool, the decision, the rule and the wait", () => {
    const r = inMigrated(
      [
        decision("client_session, tool_name, decision, rule_index, duration_ms", "'sess-1', 'mcp__github__create_issue', 'owner_approved', 3, 41000"),
        `select kind || ':' || tool_name || ':' || decision || ':' || rule_index || ':' || duration_ms from ${TABLE};`,
      ].join("\n")
    );
    expect(r).toMatchObject({ ok: true, out: "tool_decision:mcp__github__create_issue:owner_approved:3:41000" });
    for (const d of ["deny", "ask", "owner_approved", "owner_denied", "owner_timeout", "owner_unavailable", "rules_invalid"]) {
      expect(inMigrated(decision("tool_name, decision", `'Bash', '${d}'`)).ok, d).toBe(true);
    }
  });

  it("refuses a tool decision that does not fit, and tool fields on a model call", () => {
    for (const bad of [
      decision("tool_name", "'Bash'"),
      decision("decision", "'deny'"),
      decision("tool_name, decision", "'Bash', 'allow'"),
      decision("tool_name, decision", "'rm -rf /', 'deny'"),
      decision("tool_name, decision, rule_index", "'Bash', 'deny', 100"),
      decision("tool_name, decision, rule_index", "'Bash', 'deny', -1"),
      decision("tool_name, decision, model", "'Bash', 'deny', 'claude-haiku-5-5'"),
      decision("tool_name, decision, input_tokens", "'Bash', 'deny', 1"),
      decision("tool_name, decision, reported_cost_usd_micros", "'Bash', 'deny', 1"),
      decision("tool_name, decision, status_code", "'Bash', 'deny', 500"),
      insert("tool_name", "'Bash'"),
      insert("decision", "'deny'"),
      insert("rule_index", "0"),
      insertRaw("event_key, source, kind, auth_method, tool_name", `${KEY}, 'claude_code_otel', 'model_error', 'passport', 'Bash'`),
    ]) {
      const r = inMigrated(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.out).toMatch(/check constraint|violates|out of range/);
    }
  });

  it("makes a retried upload a no-op: one row per agent and event key", () => {
    const dup = inMigrated(`${insert()}\n${insert()}`);
    expect(dup.ok).toBe(false);
    expect(dup.out).toMatch(/duplicate key value/);
    const idempotent = inMigrated(
      `${insert().replace(/;$/, " on conflict (agent_id, event_key) do nothing;")}\n` +
        `${insert().replace(/;$/, " on conflict (agent_id, event_key) do nothing;")}\n` +
        `select count(*) from ${TABLE};`
    );
    expect(idempotent).toMatchObject({ ok: true, out: "1" });
  });

  it("lets the service role retry with only INSERT: on conflict do nothing needs no UPDATE", () => {
    // What PostgREST sends for the route's upsert(…, { ignoreDuplicates: true }).
    // Granted ALLOWED privileges only, so `set local role` here runs nothing denied.
    const upsert = insert().replace(/;$/, " on conflict (agent_id, event_key) do nothing;");
    const r = inMigrated(`grant select on t_agent to service_role;\nset local role service_role;\n${upsert}\n${upsert}\nselect count(*) from ${TABLE};`, { stock: true });
    expect(r).toMatchObject({ ok: true, out: "1" });
  });

  it("goes with its tenant and its agent, and indexes both foreign keys", () => {
    const fk = inMigrated(
      `select confrelid::regclass::text || ':' || confdeltype::text from pg_constraint where conrelid = '${TABLE}'::regclass and contype = 'f' order by 1;`
    );
    expect(fk).toMatchObject({ ok: true });
    expect(fk.out.split("\n")).toEqual(["agents:c", "users:c"]);
    // Supabase's unindexed_foreign_keys rule: an index whose LEADING columns are the
    // key's full column list, in order. Comparing the first column only (as 0083's
    // single-column test could) passes a composite key no index covers.
    const idx = inMigrated(
      "select c.conname || '=' || exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indisvalid " +
        "and c.conkey = (string_to_array(i.indkey::text, ' ')::smallint[])[1:array_length(c.conkey, 1)]) " +
        `from pg_constraint c where c.conrelid = '${TABLE}'::regclass and c.contype = 'f' order by 1;`
    );
    expect(idx).toMatchObject({ ok: true });
    expect(idx.out.split("\n")).toEqual(["client_reported_calls_agent_tenant=true", "client_reported_calls_user_id_fkey=true"]);
  });

  it("is append-only: readable by its tenant, inserted by the service role, changed by nobody", () => {
    const privs = ["select", "insert", "update", "delete", "truncate"];
    const roles = ["anon", "authenticated", "service_role"];
    const r = inMigrated(
      [
        ...roles.flatMap((role) =>
          privs.map((p) => `select '${role}.${p}=' || has_table_privilege('${role}', '${TABLE}', '${p}');`)
        ),
        `select 'public=' || exists (select 1 from pg_class c, aclexplode(c.relacl) x where c.oid = '${TABLE}'::regclass and x.grantee = 0);`,
        `select 'rls=' || relrowsecurity from pg_class where oid = '${TABLE}'::regclass;`,
        "select 'policies=' || string_agg(cmd || ':' || array_to_string(roles, '+') || ':' || coalesce(qual, ''), ' | ') from pg_policies where tablename = 'client_reported_calls';",
      ].join("\n"),
      { stock: true }
    );
    expect(r).toMatchObject({ ok: true });
    const out = r.out.split("\n");
    expect(out.slice(0, 15)).toEqual([
      "anon.select=false",
      "anon.insert=false",
      "anon.update=false",
      "anon.delete=false",
      "anon.truncate=false",
      "authenticated.select=true",
      "authenticated.insert=false",
      "authenticated.update=false",
      "authenticated.delete=false",
      "authenticated.truncate=false",
      "service_role.select=true",
      "service_role.insert=true",
      "service_role.update=false",
      "service_role.delete=false",
      "service_role.truncate=false",
    ]);
    expect(out[15]).toBe("public=false");
    expect(out[16]).toBe("rls=true");
    expect(out[17]).toMatch(/^policies=SELECT:authenticated:\(user_id = \( SELECT auth\.uid\(\)/);
    expect(out[17]).not.toContain("|");
  });

  // Retention (owner, 2026-10-12): 90 days. The table stays append-only for everyone;
  // the one way a row leaves early is this function, whose window is fixed inside it,
  // so the caller can age rows out but never choose which recent ones to remove.
  describe("90-day retention", () => {
    const aged = (key: string, days: number) =>
      `insert into ${TABLE} (user_id, agent_id, event_key, source, kind, auth_method, received_at) ` +
      `select user_id, agent_id, '${key}', 'claude_code_otel', 'model_call', 'passport', now() - interval '${days} days' from t_agent;`;

    it("removes this agent's rows older than 90 days, and nothing newer", () => {
      const r = inMigrated(
        [
          aged("evt_old_aaaaaaaaaaaaaa", 91),
          aged("evt_edge_aaaaaaaaaaaaa", 89),
          aged("evt_new_aaaaaaaaaaaaaa", 0),
          "select public.prune_client_reported_calls(agent_id, user_id) from t_agent;",
          `select string_agg(event_key, ',' order by event_key) from ${TABLE};`,
        ].join("\n")
      );
      expect(r).toMatchObject({ ok: true });
      expect(r.out.split("\n")).toEqual(["1", "evt_edge_aaaaaaaaaaaaa,evt_new_aaaaaaaaaaaaaa"]);
    });

    it("removes nothing when the tenant does not own the agent", () => {
      const r = inMigrated(
        [
          aged("evt_old_aaaaaaaaaaaaaa", 91),
          "select public.prune_client_reported_calls(agent_id, gen_random_uuid()) from t_agent;",
          `select count(*) from ${TABLE};`,
        ].join("\n")
      );
      expect(r).toMatchObject({ ok: true });
      expect(r.out.split("\n")).toEqual(["0", "1"]);
    });

    it("the daily sweep removes every tenant's rows older than 90 days, and nothing newer", () => {
      const r = inMigrated(
        [
          aged("evt_old_aaaaaaaaaaaaaa", 91),
          aged("evt_edge_aaaaaaaaaaaaa", 89),
          "select public.purge_client_reported_calls();",
          `select string_agg(event_key, ',' order by event_key) from ${TABLE};`,
        ].join("\n")
      );
      expect(r).toMatchObject({ ok: true });
      expect(r.out.split("\n")).toEqual(["1", "evt_edge_aaaaaaaaaaaaa"]);
    });

    it("the daily sweep is callable by the service role only, with a fixed search path", () => {
      const fn = "public.purge_client_reported_calls()";
      const r = inMigrated(
        [
          ...["anon", "authenticated", "service_role", "public"].map(
            (role) => `select '${role}=' || has_function_privilege('${role}', '${fn}', 'execute');`
          ),
          `select 'definer=' || prosecdef || ' path=' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = '${fn}'::regprocedure;`,
        ].join("\n"),
        { stock: true }
      );
      expect(r).toMatchObject({ ok: true });
      expect(r.out.split("\n")).toEqual([
        "anon=false",
        "authenticated=false",
        "service_role=true",
        "public=false",
        'definer=true path=search_path=""',
      ]);
    });

    it("is callable by the service role only, and runs with a fixed search path", () => {
      const fn = "public.prune_client_reported_calls(uuid, uuid)";
      const r = inMigrated(
        [
          ...["anon", "authenticated", "service_role", "public"].map(
            (role) => `select '${role}=' || has_function_privilege('${role}', '${fn}', 'execute');`
          ),
          `select 'definer=' || prosecdef || ' path=' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = '${fn}'::regprocedure;`,
        ].join("\n"),
        { stock: true }
      );
      expect(r).toMatchObject({ ok: true });
      expect(r.out.split("\n")).toEqual([
        "anon=false",
        "authenticated=false",
        "service_role=true",
        "public=false",
        'definer=true path=search_path=""',
      ]);
    });
  });

  it("refuses a row whose agent belongs to another tenant", () => {
    // The route takes both ids from the credential, but the table holds it too: a
    // row can never pin one tenant's report on another tenant's agent.
    const OTHER = "0084aaaa-0000-4000-8000-000000000084";
    const r = inMigrated(
      `insert into auth.users (id, email) values ('${OTHER}', 'other-${OTHER}@example.test');\n` +
        `insert into public.users (id, email) values ('${OTHER}', 'other-${OTHER}@example.test');\n` +
        `insert into ${TABLE} (user_id, agent_id, event_key, source, kind, auth_method) ` +
        `select '${OTHER}'::uuid, agent_id, ${KEY}, 'claude_code_otel', 'model_call', 'passport' from t_agent;`
    );
    expect(r.ok).toBe(false);
    // The composite key, not the users insert above, is what refused it.
    expect(r.out).toMatch(/client_reported_calls_agent_tenant/);
  });
});
