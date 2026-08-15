import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const sql = readFileSync(join(repo, "db/migrations/0026_agent_logs_identity_contract.sql"), "utf8");
const expand = readFileSync(join(repo, "db/migrations/0023_direct_agent_keys_expand.sql"), "utf8");
const immutable = readFileSync(join(repo, "db/migrations/0006_agent_logs_immutable.sql"), "utf8");
const log = readFileSync(join(repo, "lib/log.ts"), "utf8");
const gateway = readFileSync(join(repo, "app/api/v1/[provider]/[...path]/route.ts"), "utf8");

/** Every source file under `roots`, so a new writer cannot hide from this suite. */
function sourceFiles(roots: string[], exts = [".ts", ".tsx", ".mjs"]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist-cli") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (exts.some((ext) => entry.endsWith(ext))) out.push(full);
    }
  };
  for (const root of roots) walk(join(repo, root));
  return out;
}

describe("agent_logs identity contract migration", () => {
  it("finishes the contract phase 0023 explicitly deferred", () => {
    // 0023's own words, wrapped across comment lines in that file.
    expect(expand).toMatch(/not add the final discriminated identity CHECK/i);
    expect(sql).toMatch(/alter column auth_method set not null/i);
    expect(sql).toMatch(/constraint agent_logs_identity_discriminated/i);
  });

  // The teeth are the CHECK, not the NOT NULL. A row must agree with the identity
  // it claims in both directions, so an incomplete insert cannot be stamped
  // 'passport' by the column default and pass.
  it("requires each identity to carry its own columns and none of the other's", () => {
    const check = sql.slice(sql.indexOf("agent_logs_identity_discriminated"));
    expect(check).toMatch(/auth_method = 'passport'[\s\S]*?passport_id is not null[\s\S]*?jti is not null/);
    expect(check).toMatch(/auth_method = 'passport'[\s\S]*?agent_access_key_id is null[\s\S]*?credential_use_id is null/);
    expect(check).toMatch(/auth_method = 'direct_key'[\s\S]*?agent_access_key_id is not null[\s\S]*?credential_use_id is not null/);
    expect(check).toMatch(/auth_method = 'direct_key'[\s\S]*?passport_id is null[\s\S]*?jti is null/);
  });

  it("bounds the vocabulary so an unknown method is refused, not rendered", () => {
    expect(sql).toMatch(/check \(auth_method in \('passport', 'direct_key'\)\)/i);
  });

  // Dropping the default would make PostgREST reject every insert from a writer
  // that omits the column — and agent_logs writes are best-effort, so the audit
  // trail would go silently empty. lib/log.ts documents that trap; keep the
  // omission valid and let the CHECK do the work.
  it("does not drop the default the passport writer relies on", () => {
    expect(sql).not.toMatch(/alter column auth_method drop default/i);
    expect(log).toMatch(/Omitted keeps the passport writer compatible with the expansion migration/);
  });

  // ADD CONSTRAINT ... NOT VALID starts enforcing NEW rows immediately; VALIDATE
  // then scans the rows already there. Enforcement therefore precedes validation,
  // which is the ordering that matters. (The lock split usually claimed for this
  // pattern does NOT apply here: scripts/migrate.sh runs `psql -1`, so the whole
  // file is one transaction and the ADD's ACCESS EXCLUSIVE lock is held through
  // the VALIDATE anyway. Kept because it is correct and portable, not for locks.)
  it("adds both constraints NOT VALID and validates them separately", () => {
    // Exactly the two CHECKs this migration introduces are added NOT VALID. The
    // third `validate constraint` below belongs to 0023's foreign key, which is
    // adopted rather than added here — so it is counted by name, not by tally,
    // and a stray future NOT VALID still trips the first assertion.
    expect(sql.match(/not valid;/gi) ?? []).toHaveLength(2);
    expect(sql.match(/validate constraint/gi) ?? []).toHaveLength(3);
    for (const name of ["agent_logs_auth_method_known", "agent_logs_identity_discriminated"]) {
      expect(sql.indexOf(`add constraint ${name}`)).toBeLessThan(
        sql.indexOf(`validate constraint ${name}`)
      );
    }
  });

  // 0006 made agent_logs append-only: a direct UPDATE runs at trigger depth 1 and
  // raises 'agent_logs is append-only'. So a backfill UPDATE in this migration can
  // only ever do one of two things — match nothing (0023's ADD COLUMN ... DEFAULT
  // already gave every existing row 'passport', which is the ONLY reason 0023's own
  // identical UPDATE survived production), or abort the migration with an error
  // about immutability instead of about the null it found. SET NOT NULL reports
  // that null honestly, so the repair attempt is removed rather than kept as decor.
  it("does not attempt a repair UPDATE the append-only trigger would reject", () => {
    expect(sql).not.toMatch(/update\s+public\.agent_logs/i);
    expect(immutable).toMatch(/append-only: % is not permitted/);
    expect(sql).toMatch(/alter column auth_method set not null/i);
  });

  // 0023 left `agent_logs_access_key_fk` NOT VALID and said the final constraints
  // belong in a later migration. This is that migration, and the deferral has no
  // remaining justification — it is provably safe to finish here:
  //
  //   1. `agent_access_key_id` is ADDED BY 0023, in the statement immediately
  //      before the FK. A column that did not exist a moment ago is NULL on every
  //      row already stored, and a NULL never violates a foreign key.
  //   2. `agent_access_keys` — the referenced table — is CREATED by 0023 too, so
  //      no value could have been written against it earlier.
  //   3. A NOT VALID foreign key still enforces every subsequent INSERT/UPDATE;
  //      NOT VALID only skips the scan of pre-existing rows.
  //
  // Those three together mean the set of unenforced non-null values is empty by
  // construction, so VALIDATE cannot fail for a reason that is news. Leaving it
  // NOT VALID forever is what would be unexplained. Each clause below pins one
  // step of that argument, so the day a migration breaks a step, this goes red
  // rather than the validation silently becoming unsafe.
  it("finishes 0023's deferred foreign key, and keeps the argument that makes it safe", () => {
    expect(sql).toMatch(/validate constraint agent_logs_access_key_fk/i);

    // Step 1 + 2: the column and the referenced table are born in 0023, before the FK.
    const addsColumn = expand.search(/add column if not exists agent_access_key_id/i);
    const createsTable = expand.search(/create table if not exists public\.agent_access_keys/i);
    const addsFk = expand.search(/add constraint agent_logs_access_key_fk/i);
    expect(addsColumn).toBeGreaterThan(-1);
    expect(createsTable).toBeGreaterThan(-1);
    expect(addsColumn).toBeLessThan(addsFk);
    expect(createsTable).toBeLessThan(addsFk);

    // Step 1, the other half: no EARLIER migration may introduce the column, or
    // rows predating the FK could hold a non-null value it never checked.
    const earlier = readdirSync(join(repo, "db/migrations"))
      .filter((file) => file.endsWith(".sql") && file < "0023")
      .filter((file) => /agent_access_key_id/i.test(readFileSync(join(repo, "db/migrations", file), "utf8")));
    expect(earlier).toEqual([]);
  });

  it("changes no policy, grant or trigger", () => {
    expect(sql).not.toMatch(/create policy|drop policy/i);
    expect(sql).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(sql).not.toMatch(/create trigger|drop trigger/i);
    expect(sql).not.toMatch(/row level security/i);
  });
});

// A constraint is only as good as the set of writers it was checked against. There
// is no database in this suite, so what is pinned here is the input side: every
// path that can produce an agent_logs row, and the identity each one carries.
// If a second writer appears, this describe block is what fails.
describe("every agent_logs writer satisfies the discriminated identity", () => {
  it("has exactly one application writer", () => {
    const writers = sourceFiles(["lib", "app", "scripts", "cli", "sdk"]).filter((file) =>
      /from\(\s*["']agent_logs["']\s*\)\s*\.?\s*\n?\s*\.insert\(/.test(readFileSync(file, "utf8"))
    );
    expect(writers.map((file) => file.slice(repo.length + 1))).toEqual(["lib/log.ts"]);
  });

  it("has no SQL-side writer — no migration, function or trigger inserts a row", () => {
    const offenders = readdirSync(join(repo, "db/migrations"))
      .filter((file) => file.endsWith(".sql"))
      .filter((file) =>
        /insert\s+into\s+(public\.)?agent_logs/i.test(
          readFileSync(join(repo, "db/migrations", file), "utf8")
        )
      );
    expect(offenders).toEqual([]);
  });

  // The TypeScript union is the compile-time mirror of the SQL CHECK: each identity
  // must carry its own two columns and is forbidden (`?: never`) from naming the
  // other's. A row that type-checks here cannot violate the constraint there.
  it("mirrors the CHECK in lib/log.ts's discriminated LogEntry", () => {
    const passport = log.slice(log.indexOf("type PassportLogIdentity"), log.indexOf("type DirectKeyLogIdentity"));
    expect(passport).toMatch(/passportId: string;/);
    expect(passport).toMatch(/jti: string;/);
    expect(passport).toMatch(/agentAccessKeyId\?: never;/);
    expect(passport).toMatch(/credentialUseId\?: never;/);

    const direct = log.slice(log.indexOf("type DirectKeyLogIdentity"), log.indexOf("export type LogEntry"));
    expect(direct).toMatch(/authMethod: "direct_key";/);
    expect(direct).toMatch(/agentAccessKeyId: string;/);
    expect(direct).toMatch(/credentialUseId: string;/);
    expect(direct).toMatch(/passportId\?: never;/);
    expect(direct).toMatch(/jti\?: never;/);

    // The direct branch must NULL the passport columns explicitly rather than omit
    // them: omission is fine on an INSERT, but writing them out is what keeps the
    // row's two halves visibly exclusive at the one place a reader checks.
    const row = log.slice(log.indexOf('entry.authMethod === "direct_key"'), log.indexOf("provider: entry.provider"));
    expect(row).toMatch(/auth_method: "direct_key"/);
    expect(row).toMatch(/passport_id: null/);
    expect(row).toMatch(/jti: null/);
  });

  // Both gateway routes (real provider and demo) build the identity the same way.
  it("builds a complete identity at every gateway call site", () => {
    const identities = gateway.match(/const logIdentity =[\s\S]*?\n  const reserveId/g) ?? [];
    expect(identities).toHaveLength(2);
    for (const identity of identities) {
      expect(identity).toMatch(/passportId: principal\.passportId, jti: principal\.visaJti/);
      expect(identity).toMatch(/authMethod: "direct_key"[\s\S]*agentAccessKeyId: principal\.keyId[\s\S]*credentialUseId/);
    }
  });

  // The other side of the retained default: a legitimate insert that OMITS
  // auth_method still lands, because it carries the identity columns the CHECK
  // demands. This fixture is that writer, and it is the case the default exists for.
  it("keeps the auth_method-omitting fixture in db/tests valid under the new CHECK", () => {
    const invariants = readFileSync(join(repo, "db/tests/rls_invariants.sql"), "utf8");
    const insert = invariants.slice(invariants.indexOf("insert into public.agent_logs"));
    expect(insert).toMatch(/\(agent_id, user_id, passport_id, jti, status\)/);
    expect(insert.slice(0, insert.indexOf(";"))).not.toMatch(/auth_method|agent_access_key_id|credential_use_id/);
  });
});
