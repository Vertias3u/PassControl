import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/0035_passport_key_namespace.sql"),
  "utf8"
);
const migrationScript = readFileSync(resolve(process.cwd(), "scripts/migrate.sh"), "utf8");
const localStackScript = readFileSync(resolve(process.cwd(), "scripts/dev-stack.sh"), "utf8");
const ciWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

describe("migration 0035 passport-key namespace", () => {
  it("locks agents before preflight and backfill, so no writer can outrun trigger installation", () => {
    // `scripts/migrate.sh` and the local-stack equivalent run each migration
    // under psql -1.  SHARE ROW EXCLUSIVE conflicts with INSERT/UPDATE/DELETE's
    // ROW EXCLUSIVE lock but permits ordinary reads, so it closes the rollout
    // gap without turning the whole application read-only.
    expect(migration).toMatch(/lock\s+table\s+public\.agents\s+in\s+share\s+row\s+exclusive\s+mode/i);
    expect(migration.indexOf("lock table public.agents")).toBeLessThan(
      migration.indexOf("passport_key_namespace_backfill_conflict")
    );
    expect(migration.indexOf("lock table public.agents")).toBeLessThan(
      migration.indexOf("create trigger agents_passport_key_namespace_sync")
    );
    // The lock is transaction-scoped; the repository paths that apply this
    // migration must therefore keep each SQL file in a single transaction.
    expect(migrationScript).toMatch(/psql\s+-1[\s\S]*-f\s+"\$f"/i);
    expect(localStackScript).toMatch(/\|\s+"\$\{PSQL\[@\]\}"\s+-1\s+-q/i);
    // CI used to be a THIRD applier with its own loop, and it diverged from
    // the two migrators twice — no transaction for 0035's LOCK TABLE, then no
    // ledger table for 0036's function body. It now runs scripts/migrate.sh,
    // so there is nothing left to keep in sync: pin that, not a flag.
    expect(ciWorkflow).toMatch(/bash\s+scripts\/migrate\.sh/);
    expect(ciWorkflow).not.toMatch(/for\s+f\s+in\s+db\/migrations/);
  });

  it("refuses a legacy cross-agent current/retired collision before backfill", () => {
    // A `union` followed by `on conflict do nothing` would make the migration
    // appear healthy while choosing one claimant for a key two agents hold.
    // The preflight must instead compare distinct agent ids and stop with an
    // explicit deployment error that leaves auth's ambiguity refusal intact.
    expect(migration).toMatch(/having\s+count\(distinct\s+claim\.agent_id\)\s*>\s*1/i);
    expect(migration).toMatch(/passport_key_namespace_backfill_conflict/i);
    expect(migration).toMatch(/Resolve the current-versus-retired key collision/i);
  });

  it("has one trigger-private namespace for both columns and no bypassable writer", () => {
    expect(migration).toMatch(/create table public\.passport_key_namespace/i);
    expect(migration).toMatch(/passport_pubkey text primary key/i);
    expect(migration).toMatch(/after insert or update of passport_pubkey, previous_passport_pubkey or delete/i);
    expect(migration).toMatch(/revoke all on table public\.passport_key_namespace from public, anon, authenticated, service_role/i);
    expect(migration).toMatch(/revoke all on function public\.sync_passport_key_namespace\(\) from public, anon, authenticated, service_role/i);
  });

  it("exposes only boolean service-role availability for the import preview", () => {
    expect(migration).toMatch(/create function public\.passport_key_availability\(p_passport_pubkeys text\[\]\)/i);
    expect(migration).toMatch(/returns table \(passport_pubkey text, available boolean\)/i);
    expect(migration).toMatch(/revoke all on function public\.passport_key_availability\(text\[\]\) from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.passport_key_availability\(text\[\]\)\s+to service_role/i);
    expect(migration).not.toMatch(/returns table \([^)]*(user_id|agent_id)/i);
  });
});
