import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * Revocation is terminal, proved against a real Postgres.
 *
 * This cannot be tested with mocks, and it cannot be tested through the server
 * actions either — the defect is that the actions are not the only writer. A
 * signed-in browser session holds a PostgREST token, and `authenticated` was
 * granted `update (revoked_at)` on `api_keys` back in 0012 on the reasoning that
 * the only thing a dashboard user legitimately does to a key is revoke it.
 *
 * A timestamp column grant is bidirectional. Setting `revoked_at` back to NULL
 * is the same UPDATE the grant exists to permit, the row's RLS policy checks
 * ownership and nothing else, and there was no trigger — so a session that had
 * never cleared MFA could reverse an emergency stop and the key's original
 * `write` scope came back with it. `revokeApiKey`'s own `.is("revoked_at", null)`
 * predicate is a guard on the code path, not on the table.
 *
 * SKIPS only when the database is unreachable. If the stack IS up and 0068 has
 * not been applied, these FAIL rather than skip — deliberately. A missing
 * guard on a live database is a regression signal, not an absent fixture.
 * Deliberately the dev stack, not the `pc_op_scratch*` databases the operator
 * `.db.test.ts` files use. Those exist for service-role RPC behaviour, and their
 * template does not grant `authenticated` USAGE on the `auth` schema — so
 * `auth.uid()` raises there, every RLS policy denies, and a test written against
 * them would pass while proving nothing. This file's whole subject is what a
 * BROWSER SESSION can do, so it has to run where the grants match production.
 *
 * Everything runs inside one transaction that is always rolled back, and every
 * fixture id is a fresh uuid. Nothing is left behind.
 *
 *   docker exec -i supabase_db_PassControl psql -U postgres -d postgres \
 *     -v ON_ERROR_STOP=1 -f - < db/migrations/0068_revocation_is_terminal.sql
 */
const CONTAINER = process.env.KEYS_DB_CONTAINER ?? "supabase_db_PassControl";
const DB = process.env.KEYS_DB ?? "postgres";

function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}

function tryPsql(sql: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: psql(sql) };
  } catch (error) {
    const e = error as { stderr?: Buffer; stdout?: Buffer };
    return { ok: false, out: String(e.stderr ?? "") + String(e.stdout ?? "") };
  }
}

function live(): boolean {
  try {
    psql("select 1 from public.api_keys limit 1");
    return true;
  } catch {
    return false;
  }
}

const up = live();
const when = up ? it : it.skip;
const skipped = (what: string) =>
  `SKIPPED — database ${DB} in ${CONTAINER} is not reachable, so ${what} was never asked of a real Postgres`;

/**
 * One session, one transaction, always rolled back. The whole fixture is built
 * as `postgres` and then the session DROPS to `authenticated` with a tenant's
 * claims — which is exactly the authority a signed-in browser tab holds, at
 * aal1, without ever having touched MFA.
 */
function asTenant(uid: string, body: string): string {
  return `
    begin;
    insert into auth.users (id, email) values ('${uid}', '${uid}@keys.test');
    insert into public.users (id, email) values ('${uid}', '${uid}@keys.test');
    ${body}
    rollback;
  `;
}

function seedKey(uid: string, keyId: string, revokedAt: string): string {
  return `insert into public.api_keys (id, user_id, name, key_prefix, key_hash, scope, revoked_at)
          values ('${keyId}', '${uid}', 'disposable', 'pc_test', 'not-a-real-hash', 'write', ${revokedAt});`;
}

const claims = (uid: string) => `
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated","aal":"aal1"}';
`;

describe("revocation is terminal at the table, not only in the action", () => {
  when(
    up
      ? "refuses to bring a revoked control key back, from the tenant's own aal1 session"
      : skipped("un-revoking a key"),
    () => {
      const uid = randomUUID();
      const keyId = randomUUID();
      const attempt = tryPsql(
        asTenant(
          uid,
          `${seedKey(uid, keyId, "now()")}
           ${claims(uid)}
           update public.api_keys set revoked_at = null where id = '${keyId}';
           reset role;
           select 'still_revoked=' || (revoked_at is not null)::text
             from public.api_keys where id = '${keyId}';`
        )
      );

      // The database refuses, loudly. Before 0068 this reported UPDATE 1 and
      // printed still_revoked=false — the key authenticated again, with its
      // original write scope, from a session that never cleared MFA.
      expect(attempt.ok).toBe(false);
      expect(attempt.out).toContain("revocation is terminal");
      expect(attempt.out).not.toContain("still_revoked=false");
    }
  );

  when(
    up
      ? "refuses to move a revocation to a different time, which is the same erasure slower"
      : skipped("rewriting a revocation timestamp"),
    () => {
      const uid = randomUUID();
      const keyId = randomUUID();
      const attempt = tryPsql(
        asTenant(
          uid,
          `${seedKey(uid, keyId, "now() - interval '1 day'")}
           ${claims(uid)}
           update public.api_keys set revoked_at = now() where id = '${keyId}';`
        )
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.out).toContain("revocation is terminal");
    }
  );

  when(
    up
      ? "still lets that same session revoke a live key — the emergency stop is untouched"
      : skipped("the ordinary revoke path"),
    () => {
      const uid = randomUUID();
      const keyId = randomUUID();
      const result = psql(
        asTenant(
          uid,
          `${seedKey(uid, keyId, "null")}
           ${claims(uid)}
           update public.api_keys set revoked_at = now() where id = '${keyId}';
           select 'revoked=' || (revoked_at is not null)::text from public.api_keys where id = '${keyId}';`
        )
      );

      // The fix must not make revocation need MFA, or a server round trip, or
      // anything else an operator does not have in the moment they need it.
      expect(result).toContain("revoked=true");
    }
  );

  when(
    up
      ? "still refuses another tenant's key, so RLS is not doing less than it was"
      : skipped("cross-tenant revocation"),
    () => {
      const owner = randomUUID();
      const stranger = randomUUID();
      const keyId = randomUUID();
      const result = psql(
        asTenant(
          owner,
          `insert into auth.users (id, email) values ('${stranger}', '${stranger}@keys.test');
           insert into public.users (id, email) values ('${stranger}', '${stranger}@keys.test');
           ${seedKey(owner, keyId, "null")}
           ${claims(stranger)}
           update public.api_keys set revoked_at = now() where id = '${keyId}';
           reset role;
           select 'still_live=' || (revoked_at is null)::text from public.api_keys where id = '${keyId}';`
        )
      );

      expect(result).toContain("still_live=true");
    }
  );
});
