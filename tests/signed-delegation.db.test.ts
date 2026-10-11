import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { retryOnDeadlock } from "./db-deadlock-retry";

/**
 * Bet D's schema (0081), proved against a real Postgres. Every case runs on the dev
 * stack's database inside ONE transaction that is always rolled back, with 0081 applied
 * inside it, so the owner's local database is never migrated by this file.
 * SKIPS only when the database is unreachable.
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const MIGRATION = readFileSync(new URL("../db/migrations/0081_signed_delegation.sql", import.meta.url), "utf8");

function psqlOnce(sql: string): { ok: boolean; out: string } {
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
function psql(sql: string): { ok: boolean; out: string } {
  return retryOnDeadlock(() => psqlOnce(sql));
}
const live = psql("select 1 from public.agents limit 1;").ok;

/** Run `body` after 0081 inside a transaction that is rolled back whatever happens. */
function inMigrated(body: string) {
  return psql(
    `begin;\nset local client_min_messages = warning;\n${MIGRATION}\n` +
      `create temp table t_agent on commit drop as select id, user_id from public.agents order by created_at limit 1;\n` +
      `${body}\nrollback;\n`
  );
}
const JTI = "jti-0000000000000001";
const KEY = "A".repeat(43);

describe.skipIf(!live)("0081 signed delegation, on a real Postgres", () => {
  it("the watermark moves forward, and never back or to NULL", () => {
    const forward = inMigrated(
      `update public.agents set delegations_valid_after = '2026-10-10T00:00:00Z' where id = (select id from t_agent);\n` +
        `update public.agents set delegations_valid_after = '2026-10-11T00:00:00Z' where id = (select id from t_agent);\n` +
        `select 'moved';`
    );
    expect(forward).toMatchObject({ ok: true });
    expect(forward.out).toContain("moved");
    for (const next of ["'2026-10-09T00:00:00Z'", "null"]) {
      const back = inMigrated(
        `update public.agents set delegations_valid_after = '2026-10-10T00:00:00Z' where id = (select id from t_agent);\n` +
          `update public.agents set delegations_valid_after = ${next} where id = (select id from t_agent);`
      );
      expect(back.ok).toBe(false);
      expect(back.out).toMatch(/only moves forward/);
    }
  });

  it("a first exchange inserts its row once: the second insert creates nothing", () => {
    const insert =
      `insert into public.delegation_exchanges (user_id, agent_id, jti, depth, worker_key, cap_microcents, scope, issued_at, expires_at)\n` +
      `select user_id, id, '${JTI}', 1, '${KEY}', 100, '[]'::jsonb, now(), now() + interval '1 hour' from t_agent\n` +
      `on conflict (agent_id, jti) do nothing returning 'created';`;
    const r = inMigrated(`${insert}\n${insert}\nselect 'rows=' || count(*) from public.delegation_exchanges where jti = '${JTI}';`);
    expect(r.ok).toBe(true);
    expect(r.out.split("\n").filter((l) => l === "created")).toHaveLength(1);
    expect(r.out).toContain("rows=1");
  });

  it("a revocation is append-only and recorded once per agent and jti", () => {
    const add = `insert into public.delegation_revocations (user_id, agent_id, jti) select user_id, id, '${JTI}' from t_agent;`;
    expect(inMigrated(`${add}\nselect 'ok';`).ok).toBe(true);
    for (const mutate of [
      `update public.delegation_revocations set jti = 'jti-9999999999999999';`,
      `delete from public.delegation_revocations;`,
      `truncate public.delegation_revocations;`,
    ]) {
      const r = inMigrated(`${add}\n${mutate}`);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/append-only/);
    }
    expect(inMigrated(`${add}\n${add}`).ok).toBe(false);
  });

  const logRow = (method: string, delegated: boolean) =>
    `insert into public.agent_logs (user_id, agent_id, status, auth_method, passport_id, jti${delegated ? ", delegation_jti, delegation_actor, delegation_chain_hash, delegation_links" : ""})\n` +
    `select user_id, id, 'allowed', '${method}', '${KEY}', 'visa-jti'${delegated ? `, '${JTI}', '${KEY}', '${KEY}', array['${JTI}']` : ""} from t_agent;`;

  it.each(["delegated", "delegated_proof_per_request"])("a %s call row carrying its delegation is accepted", (method) => {
    expect(inMigrated(`${logRow(method, true)}\nselect 'ok';`)).toMatchObject({ ok: true });
  });

  it("a delegated method without its delegation is refused, and so is a passport row naming one", () => {
    const missing = inMigrated(logRow("delegated", false));
    expect(missing.ok).toBe(false);
    expect(missing.out).toMatch(/agent_logs_delegation_shape/);
    const smuggled = inMigrated(logRow("passport", true));
    expect(smuggled.ok).toBe(false);
    expect(smuggled.out).toMatch(/agent_logs_delegation_shape/);
  });

  it("ordinary passport rows are unchanged, and an unknown method is still refused", () => {
    expect(inMigrated(`${logRow("passport", false)}\nselect 'ok';`).ok).toBe(true);
    const unknown = inMigrated(logRow("delegated_bearer", false));
    expect(unknown.ok).toBe(false);
    expect(unknown.out).toMatch(/agent_logs_auth_method_known/);
  });

  it("both new tables have RLS on, and authenticated can only read", () => {
    const r = inMigrated(
      `select relname || '=' || relrowsecurity from pg_class where relname in ('delegation_exchanges','delegation_revocations') order by relname;\n` +
        `select 'insert=' || has_table_privilege('authenticated', 'public.delegation_revocations', 'insert');\n` +
        `select 'select=' || has_table_privilege('authenticated', 'public.delegation_exchanges', 'select');`
    );
    expect(r.ok).toBe(true);
    expect(r.out).toContain("delegation_exchanges=true");
    expect(r.out).toContain("delegation_revocations=true");
    expect(r.out).toContain("insert=false");
    expect(r.out).toContain("select=true");
  });
});
