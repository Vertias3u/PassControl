// The migration ledger must not be reachable through PostgREST.
//
// `public.schema_migrations` is the one table in this product that no migration
// creates. Both `scripts/migrate.sh` and `scripts/dev-stack.sh` create it
// themselves, as `postgres`, before applying anything — and Supabase's default
// privileges on schema `public` grant every new table there to `anon` and
// `authenticated`. So the ledger came up world-writable on every database this
// project has ever migrated, and no migration test could have noticed, because
// there is no migration to read.
//
// Verified against the running local stack on 2026-08-07, with the anon key
// alone: `GET /rest/v1/schema_migrations` returned the full applied list, and
// `DELETE /rest/v1/schema_migrations?version=eq.<no match>` returned 204 —
// authorised, and matching no rows only because the filter said so.
//
// What that is worth to an attacker, stated honestly:
//
//  * The applied list names unreleased work. `0017_agent_owners` is readable
//    today; `break_glass_grants` would be readable the day it lands.
//  * Wiping it strands the migration tooling. The next `npm run migrate` replays
//    from 0001 and fails there (0001 references `spent_cents`, which 0005
//    renamed), so the operator cannot ship a migration until they rebuild the
//    ledger by hand.
//
// What it is NOT: a path to the corruption 0005 warns about. That replay dies at
// 0001, inside 0001's own transaction, so 0005's scaling `update` is never
// reached. Checked by replaying 0001–0005 against the live local schema inside a
// rolled-back transaction. The fix is worth making anyway — an anon-writable
// table in a credential gateway is not something to leave standing because the
// worst case happens to be blocked one migration downstream.
//
// ── The second half of the same problem ──────────────────────────────────────
//
// Locking the ledger does not make the rows already in it true. Every row that
// predates the lockdown was written to a table anyone could write to, and this
// tool reads those rows as proof that a migration ran. Insert
// `0021_passport_expiry_rotation.sql` into an unlocked ledger and the next,
// FIXED run locks the table, keeps the forged row, skips 0021, and prints
// "✓ migrate done". The code then selects columns that do not exist and both
// minting doors return 500 — and the same trick silently suppresses whatever
// security migration an attacker picks next.
//
// So a ledger has to earn trust once, explicitly. The unforgeable marker is the
// `checksum` column: adding a column requires table ownership, which is exactly
// what PostgREST's `anon`/`authenticated` do not have. Its presence therefore
// proves a vetted run happened; its absence over a non-empty ledger means the
// rows have never been vouched for by anyone.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");

const LEDGER = "public.schema_migrations";

describe("the migration ledger is locked at creation", () => {
  // Both scripts, because they are alternative entry points to the same table:
  // migrate.sh for a hosted database, dev-stack.sh for the local container. A
  // fix applied to one leaves the other creating an exposed table.
  it.each(["scripts/migrate.sh", "scripts/dev-stack.sh"])(
    "%s revokes the default grants it inherits",
    (path) => {
      const sh = read(path);
      expect(sh, `${path} does not create the ledger`).toMatch(/create table if not exists\s+public\.schema_migrations/i);

      // Supabase's `alter default privileges ... grant all on tables to anon,
      // authenticated` fires the moment postgres creates the table, so the
      // revoke has to be part of creating it — not a later migration only.
      expect(sh).toMatch(/revoke all[^;]*public\.schema_migrations[^;]*from[^;]*anon/i);
      expect(sh).toMatch(/revoke all[^;]*public\.schema_migrations[^;]*from[^;]*authenticated/i);

      // Belt and braces: RLS with no policy denies anon and authenticated even
      // if a future `alter default privileges` hands the grants back.
      expect(sh).toMatch(/alter table\s+public\.schema_migrations\s+enable row level security/i);
    }
  );

  // Four separate `psql -c` invocations are four separate transactions, so the
  // table exists and is world-writable for the length of three round trips.
  // Small, but it is the same window the lockdown exists to close, and closing
  // it costs one heredoc.
  it.each(["scripts/migrate.sh", "scripts/dev-stack.sh"])(
    "%s creates and locks the ledger in ONE transaction",
    (path) => {
      const sh = read(path);
      const block = sh.slice(sh.indexOf("begin;"), sh.indexOf("commit;"));
      expect(block, `${path} has no begin;…commit; block`).not.toBe("");
      expect(block).toMatch(/create table if not exists\s+public\.schema_migrations/i);
      expect(block).toMatch(/revoke all[^;]*public\.schema_migrations[^;]*from[^;]*anon/i);
      expect(block).toMatch(/revoke all[^;]*public\.schema_migrations[^;]*from[^;]*authenticated/i);
      expect(block).toMatch(/alter table\s+public\.schema_migrations\s+enable row level security/i);
      // The lock must not be split across the block boundary either: nothing
      // outside it may be what performs the revoke.
      const outside = sh.slice(0, sh.indexOf("begin;")) + sh.slice(sh.indexOf("commit;"));
      expect(outside).not.toMatch(/revoke all[^;]*public\.schema_migrations/i);
    }
  );

  // Only migrate.sh can be exercised end to end (dev-stack.sh needs Docker, the
  // Supabase CLI and a seed step). So the part that cannot be run in a test is
  // pinned by identity instead: the two scripts must lock the ledger with
  // character-identical SQL. A hand-copy that drifts is the realistic failure.
  it("locks the ledger with the same SQL in both scripts", () => {
    const block = (path: string) => {
      const sh = read(path);
      return sh.slice(sh.indexOf("begin;"), sh.indexOf("commit;") + "commit;".length);
    };
    expect(block("scripts/dev-stack.sh")).toEqual(block("scripts/migrate.sh"));
  });

  // Both scripts, again: a fix in migrate.sh alone leaves the local stack
  // trusting forged rows, and the local stack is where this gets exercised.
  it.each(["scripts/migrate.sh", "scripts/dev-stack.sh"])(
    "%s refuses an unvetted ledger and records a checksum per migration",
    (path) => {
      const sh = read(path);
      // The trust marker: a column only the table owner can add.
      expect(sh).toMatch(/add column if not exists checksum text/i);
      // Recorded on apply, not merely on rebaseline.
      expect(sh).toMatch(/insert into public\.schema_migrations \(version, checksum\)/i);
      // The explicit, documented way out of the refusal.
      expect(sh).toMatch(/PASSCONTROL_LEDGER_REBASELINE/);
      // A refusal has to be an exit code, not a warning printed before it
      // carries on and skips the migration anyway.
      expect(sh).toMatch(/exit 1/);
    }
  );
});

// The behaviour, not the text of the script.
//
// `psql` is stubbed: these tests are about which files migrate.sh decides to
// apply and whether it exits non-zero, which is exactly what the forged row
// subverts. They say nothing about the SQL being valid — the local stack and
// the migration tests cover that — and they never touch a database.
describe("scripts/migrate.sh decides what to apply", () => {
  const migrations = readdirSync(join(repo, "db/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sha256 = (file: string) =>
    createHash("sha256").update(readFileSync(join(repo, "db/migrations", file))).digest("hex");

  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pc-ledger-"));
    const bin = join(dir, "bin");
    execFileSync("mkdir", ["-p", bin]);
    // Recognises only the shapes scripts/migrate.sh issues. Anything else exits
    // 3, so a script change that starts asking a new question fails loudly here
    // instead of being silently mocked away.
    writeFileSync(
      join(bin, "psql"),
      `#!/usr/bin/env bash
set -uo pipefail
sql=""; file=""; args=("$@"); n=$#
for ((i=0; i<n; i++)); do
  case "\${args[i]}" in
    -c) sql+="\${args[i+1]} " ;;
    -f) file="\${args[i+1]}" ;;
  esac
done
[ -z "$sql" ] && [ -z "$file" ] && sql="$(cat)"
D="$PC_STUB_DIR"
case "$sql" in
  *_pc_ledger_state*) echo "$(cat "$D/vetted")|$(grep -c . "$D/ledger" || true)"; exit 0 ;;
  *"add column if not exists checksum"*) echo vetted >> "$D/calls"; exit 0 ;;
  *"update public.schema_migrations set checksum"*) echo "restamp" >> "$D/calls"; exit 0 ;;
  *"select version ||"*) cat "$D/ledger"; exit 0 ;;
  *"select version from"*) cut -d'|' -f1 "$D/ledger"; exit 0 ;;
esac
if [ -n "$file" ]; then basename "$file" >> "$D/applied"; exit 0; fi
echo "stub psql: unhandled: $sql" >&2; exit 3
`
    );
    chmodSync(join(bin, "psql"), 0o755);
    writeFileSync(join(dir, "calls"), "");
    writeFileSync(join(dir, "applied"), "");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(
    ledger: string[],
    vetted: boolean,
    env: Record<string, string> = {}
  ): { status: number; applied: string[]; calls: string[]; out: string } {
    writeFileSync(join(dir, "ledger"), ledger.length ? ledger.join("\n") + "\n" : "");
    writeFileSync(join(dir, "vetted"), vetted ? "t" : "f");
    let status = 0;
    let out = "";
    try {
      out = execFileSync("bash", [join(repo, "scripts/migrate.sh")], {
        env: {
          NODE_ENV: "test",
          PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
          DATABASE_URL: "postgresql://stub/stub",
          PC_STUB_DIR: dir,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"] as const,
        encoding: "utf8" as const,
      });
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? 1;
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    const lines = (name: string) =>
      readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
    return { status, applied: lines("applied"), calls: lines("calls"), out };
  }

  // The path that must not break: a database nobody has migrated yet.
  it("applies every migration to a fresh database and vets the ledger", () => {
    const { status, applied, calls } = run([], false);
    expect(status).toBe(0);
    expect(applied).toEqual(migrations);
    expect(calls).toContain("vetted"); // an empty ledger has nothing to forge
  }, 15_000); // Spawns one stubbed psql process per migration; 5s is brittle under full-suite load.

  // The finding. A ledger that has never been vetted claims 0021 ran; it did
  // not. Skipping it takes both minting doors offline, and the operator is told
  // the migration succeeded.
  it("refuses an unvetted ledger that claims an unapplied migration", () => {
    const forged = migrations.slice(0, 18).map((v) => `${v}|`);
    forged.push("0021_passport_expiry_rotation.sql|");

    const { status, applied, calls, out } = run(forged, false);

    expect(status).not.toBe(0);
    expect(applied).toEqual([]); // nothing ran, including the migrations it would have skipped
    expect(calls).not.toContain("vetted"); // and the refusal is not marked as settled
    // The gap is named, because that is what points the operator at the row.
    expect(out).toContain("0021_passport_expiry_rotation.sql");
    // …and the message survives to the end. A refusal that stops before saying
    // how to proceed is a dead end, and `set -e` will happily produce one.
    expect(out).toContain("PASSCONTROL_LEDGER_REBASELINE=keep");
  });

  // Refusing forever would break every existing database, so there is one
  // explicit way through — and it means what it says: the recorded list is
  // accepted AS IS, forged rows included. An operator who does not want 0021
  // skipped deletes that row first.
  it("accepts the recorded list only when the operator says so", () => {
    const forged = migrations.slice(0, 18).map((v) => `${v}|`);
    forged.push("0021_passport_expiry_rotation.sql|");

    const { status, applied, calls } = run(forged, false, {
      PASSCONTROL_LEDGER_REBASELINE: "keep",
    });

    expect(status).toBe(0);
    expect(calls).toContain("vetted");
    expect(applied).toEqual(
      migrations.filter((v) => !forged.some((row) => row.startsWith(`${v}|`)))
    );
  });

  // A ledger already vetted by an earlier run is not asked about again.
  it("skips what a vetted ledger records and applies the rest", () => {
    const recorded = migrations.slice(0, 20).map((v) => `${v}|${sha256(v)}`);

    const { status, applied } = run(recorded, true);

    expect(status).toBe(0);
    expect(applied).toEqual(migrations.slice(20));
  });

  // What the checksums are FOR: a file that changed after it was applied means
  // the database and the repository disagree about what ran.
  it("refuses when a recorded migration's file no longer matches", () => {
    const recorded = migrations.map((v) => `${v}|${sha256(v)}`);
    recorded[0] = `${migrations[0]}|${"0".repeat(64)}`;

    const { status, applied, out } = run(recorded, true);

    expect(status).not.toBe(0);
    expect(applied).toEqual([]);
    expect(out).toContain(migrations[0]); // names the file, or it is not actionable
  });
});

describe("the migration that closes it on databases already deployed", () => {
  const sql = read("db/migrations/0019_lock_migration_ledger.sql");

  it("revokes from both PostgREST roles", () => {
    expect(sql).toMatch(/revoke all[^;]*public\.schema_migrations[^;]*from[^;]*anon/i);
    expect(sql).toMatch(/revoke all[^;]*public\.schema_migrations[^;]*from[^;]*authenticated/i);
  });

  it("enables RLS and grants no policy back", () => {
    expect(sql).toMatch(/alter table\s+public\.schema_migrations\s+enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
  });

  // The scripts create the ledger before they apply any file, so this migration
  // can assume the table exists — but a database migrated by some other route
  // must not be broken by it.
  it("is safe on a database where the ledger does not exist", () => {
    expect(sql).toMatch(/if not exists|to_regclass|if exists/i);
  });

  // This migration must touch nothing else. It is a lockdown, and a lockdown
  // that also changes a tenant table is one nobody can review in isolation.
  it("touches only the ledger", () => {
    const tables = [...sql.matchAll(/\b(?:alter table|grant|revoke)[^;]*?public\.(\w+)/gi)].map(
      (m) => m[1]
    );
    expect(tables.length).toBeGreaterThan(0);
    expect([...new Set(tables)]).toEqual(["schema_migrations"]);
  });
});

// The general rule the ledger broke. Stated over every migration so the next
// table added to `public` cannot repeat it — the ledger was invisible to this
// check only because a shell script, not a migration, created it.
describe("every table a migration creates in public has RLS", () => {
  const files = readdirSync(join(repo, "db/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("finds migrations to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)("%s", (file) => {
    const sql = read(join("db/migrations", file));
    const created = [...sql.matchAll(/create table (?:if not exists\s+)?public\.(\w+)/gi)].map(
      (m) => m[1]
    );
    for (const table of created) {
      expect(
        sql,
        `${file} creates public.${table} without enabling row level security`
      ).toMatch(new RegExp(`alter table\\s+public\\.${table}\\s+enable row level security`, "i"));
    }
  });
});

// Nothing in the application should ever read or write the ledger — it is
// tooling state. If it appears in app code, the lockdown above will break that
// code, and it is better to know here.
describe("the application never touches the ledger", () => {
  it("is confined to scripts, migrations and this test", () => {
    const roots = ["app", "lib", "components", "cli"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(join(repo, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && read(p).includes("schema_migrations")) {
          hits.push(p);
        }
      }
    };
    roots.forEach(walk);
    expect(hits, `${LEDGER} is referenced by application code`).toEqual([]);
  });
});
