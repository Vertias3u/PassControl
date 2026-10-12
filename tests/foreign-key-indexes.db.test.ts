import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0086: every foreign key in `public` has an index that covers it, on a real Postgres.
 *
 * Supabase's `unindexed_foreign_keys` advisor flags a key no index leads with: deleting
 * a parent row (a user, an agent) then scans the whole child table for references.
 * 1.5.0's 0081 added one more (`delegation_revocations.user_id`, whose unique key leads
 * with `agent_id`) beside nine older ones accepted as INFO. 0086 indexes all ten, and
 * this test holds the line for every table, so a later migration that adds a key
 * without its index fails here instead of turning up in the advisor after a deploy.
 *
 * The rule is the advisor's: an index whose LEADING columns are the key's full column
 * list, in order. A composite key is not covered by an index on its first column.
 *
 * Runs inside begin … rollback against any local stack at 0083 or later
 * (LIMITS_DB_CONTAINER); the database is never changed.
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const MIGRATION_URL = new URL("../db/migrations/0086_foreign_key_indexes.sql", import.meta.url);
const MIGRATION = existsSync(MIGRATION_URL) ? readFileSync(MIGRATION_URL, "utf8") : "select 'missing 0086' :: int;";

function psql(sql: string): { ok: boolean; out: string } {
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
const live = psql("select 1 from public.agents limit 1;").ok;

const UNINDEXED =
  "select c.conrelid::regclass || '.' || c.conname from pg_constraint c " +
  "join pg_namespace n on n.oid = c.connamespace where c.contype = 'f' and n.nspname = 'public' " +
  "and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indisvalid " +
  "and c.conkey = (string_to_array(i.indkey::text, ' ')::smallint[])[1:array_length(c.conkey, 1)]) order by 1;";

describe.skipIf(!live)("0086 foreign key indexes, on a real Postgres", () => {
  it("leaves no foreign key in public without an index that leads with it", () => {
    const r = psql(`begin;\n${MIGRATION}\n${UNINDEXED}\nrollback;`);
    expect(r).toMatchObject({ ok: true });
    expect(r.out).toBe("");
  });

  it("is safe to apply twice", () => {
    const r = psql(`begin;\n${MIGRATION}\n${MIGRATION}\nselect 'ok';\nrollback;`);
    expect(r).toMatchObject({ ok: true, out: "ok" });
  });
});
