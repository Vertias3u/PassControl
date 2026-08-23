// The write surface on `public.users`.
//
// 0002_lock_privileged_columns.sql set out to stop a user choosing their own
// `plan`. It issued `revoke update (plan)` and `revoke insert (plan)` and nothing
// else — no GRANT. Two things defeat it, and the repo already knows both:
//
//   * A column-level REVOKE cannot narrow a table-level GRANT. 0011 and 0012 both
//     say so in their headers ("a table-wide grant can't be narrowed by a
//     column-only REVOKE, so replace UPDATE with a column-scoped grant") and both
//     fix it the same way — revoke the table-wide privilege, then grant back the
//     named columns.
//   * 0007_grants.sql runs AFTER 0002 and re-issues `grant all on public.users …
//     to anon, authenticated, service_role`, which would have undone a correct
//     0002 anyway.
//
// The live database confirms the result: backup-public-20260819-0900.sql carries
// `GRANT ALL ON TABLE public.users TO anon/authenticated/service_role` and no
// column-level entry for that table at all — contrast public.agents, which does
// show `GRANT UPDATE(name)`, `GRANT UPDATE(budget_tokens)` and so on from 0011.
//
// So today `update public.users set plan = 'whatever' where id = auth.uid()`
// succeeds for any logged-in session. Nothing reads `plan` except the account
// export, which is why this is latent rather than actively exploited — but the
// table is about to carry the operator's public identity, so the write surface
// has to be closed before it does.
//
// The fix follows agent_owners (0017), not the column-allowlist of 0011/0012:
// revoke insert/update/delete outright and route every write through
// serviceClient(). agent_owners is the closest precedent — it is the other table
// with a public/published toggle, and its header gives the reason a column grant
// is the wrong tool here: RLS can only ask who owns the row, never whether the
// session cleared a second factor.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const MIGRATIONS_DIR = join(repo, "db/migrations");

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));

// Statements that change who may write public.users. Read in filename order,
// because that is the order scripts/migrate.sh applies them in — the LAST one
// wins, which is exactly how 0007 silently undid 0002.
//
// Matching has to be narrow in three ways or it names the wrong migration. Strip
// `--` comments first, anchor on a statement that BEGINS with grant/revoke, and
// stop at the first `;` so a match cannot run across statements. Without the
// anchor this picked up 0024, whose only crimes are the word "grants" in a prose
// comment and a `delete from public.users` inside a function body.
const GRANT_STATEMENT = /(?:^|\n)[ \t]*(grant|revoke)\b[^;]*;/gi;

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function writeStatements(sql: string): string[] {
  return (stripComments(sql).match(GRANT_STATEMENT) ?? [])
    .filter((statement) => /\bpublic\.users\b/i.test(statement))
    .filter((statement) => /\b(insert|update|delete|all)\b/i.test(statement));
}

const withWriteChanges = migrations.filter((m) => writeStatements(m.sql).length > 0);
const last = withWriteChanges.at(-1);

describe("the write surface on public.users", () => {
  it("is decided by a migration, not left to Supabase's default grants", () => {
    expect(last, "no migration grants or revokes write access on public.users").toBeTruthy();
  });

  // The heart of it. Whatever migration speaks last about writing this table
  // must be taking the privilege away, not handing it out.
  it("is closed to authenticated and anon by the last migration that speaks about it", () => {
    const statements = writeStatements(last!.sql).join("\n");

    expect(
      statements,
      `${last!.name} is the last migration to change write access on public.users, and it grants rather than revokes`
    ).toMatch(/revoke[\s\S]*?\bpublic\.users\b/i);

    for (const privilege of ["insert", "update", "delete"]) {
      expect(
        statements,
        `${last!.name} does not revoke ${privilege.toUpperCase()} on public.users`
      ).toMatch(new RegExp(`revoke[^;]*\\b${privilege}\\b[^;]*public\\.users[^;]*from[^;]*;`, "i"));
    }

    for (const role of ["authenticated", "anon"]) {
      expect(
        statements,
        `${last!.name} does not revoke write access on public.users from ${role}`
      ).toMatch(new RegExp(`revoke[^;]*public\\.users[^;]*from[^;]*\\b${role}\\b[^;]*;`, "i"));
    }
  });

  // A column allowlist is the 0011/0012 pattern and it is the wrong one here:
  // it would have to be extended for every future profile column, and getting it
  // wrong fails open. If someone reintroduces one, this says why not.
  it("hands back no column-level write grant to the browser roles", () => {
    const statements = writeStatements(last!.sql).join("\n");
    expect(
      statements,
      "public.users writes go through serviceClient(); a column grant would reopen the surface this migration closes"
    ).not.toMatch(/grant[^;]*\b(insert|update)\s*\([^)]*\)[^;]*public\.users[^;]*to[^;]*(authenticated|anon)/i);
  });

  it("leaves SELECT alone, because users_self already scopes reads to the caller's row", () => {
    const statements = writeStatements(last!.sql).join("\n");
    expect(statements).not.toMatch(/revoke[^;]*\bselect\b[^;]*public\.users[^;]*from[^;]*authenticated/i);
  });
});

describe("the application side of that lock", () => {
  // These two upserts exist because no row in public.users is created at signup —
  // not by app/actions/auth.ts, not by the auth callback, and not by a trigger.
  // They ran under the caller's own JWT, so revoking INSERT from `authenticated`
  // breaks agent creation unless they move to the service role first. 0028 made
  // exactly this move for public.agents, and the comment it left at
  // app/dashboard/actions.ts:107-112 is the reason it applies here too.
  it("never writes public.users through the cookie-bound client", () => {
    const actions = readFileSync(join(repo, "app/dashboard/actions.ts"), "utf8");
    expect(
      actions,
      "a user-client upsert on public.users cannot survive the revoke; use serviceClient()"
    ).not.toMatch(/\bdb\s*\.\s*from\("users"\)/);
  });
});
