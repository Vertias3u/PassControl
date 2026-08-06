// The database and routing side of PAVP. lib/verify/passport.ts is where the
// rendered shape is pinned; this pins the two things that live outside it — what
// the SQL function is allowed to return and to whom, and the fact that the page
// is public without being prerendered or indexed.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRERENDERED_PUBLIC_PATHS, isPrerenderedPublicPath } from "@/lib/csp";

const repo = process.cwd();

// Read the migration that defines the CURRENT verify_passport, not the one that
// introduced it. This file used to hardcode 0015; when 0017 redefined the
// function, that guard would have kept passing green against a file that no
// longer described the live database — a stale guard is worse than a red one.
// Resolve it by finding the newest migration that creates the function.
const MIGRATIONS_DIR = join(repo, "db/migrations");
const CREATE_RE = /create (or replace )?function public\.verify_passport\s*\(/i;

const liveMigrationFile = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .reverse()
  .find((name) => CREATE_RE.test(readFileSync(join(MIGRATIONS_DIR, name), "utf8")));

const migration = readFileSync(join(MIGRATIONS_DIR, liveMigrationFile!), "utf8");

describe("the public verification function", () => {
  it("is read from the migration that actually defines it", () => {
    expect(liveMigrationFile).toBeTruthy();
    expect(migration).toMatch(CREATE_RE);
  });

  it("returns only public columns", () => {
    const returns = migration.match(/returns table \(([\s\S]*?)\n\)/i)?.[1] ?? "";
    const columns = returns
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);

    expect(columns.sort()).toEqual([
      "created_at",
      "owner_kind",
      "owner_subject",
      "owner_tier",
      "owner_verified_at",
      "passport_pubkey",
      "status",
    ]);
  });

  // The returns clause is the surface; the body is allowed to touch a private
  // column in a JOIN predicate. This used to assert the whole body contained no
  // "user_id" — correct while the query read one table, but the owner join is
  // `on o.user_id = a.user_id`, so the blunt check would fail on a correct
  // function. Assert the narrower true thing: nothing private is RETURNED, and
  // user_id appears only where it joins.
  it("never returns a private column", () => {
    const returns = migration.match(/returns table \(([\s\S]*?)\n\)/i)?.[1] ?? "";
    for (const column of [
      "user_id",
      "name",
      "allowed_scopes",
      "policy",
      "budget_tokens",
      "budget_cents",
      "spent_tokens",
      "spent_microcents",
      "agent_logs",
    ]) {
      expect(returns).not.toContain(column);
    }
  });

  it("touches user_id only to join the owner, never to select it", () => {
    const body = migration.match(/as \$\$([\s\S]*?)\$\$/)?.[1] ?? "";
    expect(body).toBeTruthy();
    const userIdMentions = [...body.matchAll(/user_id/g)].length;
    expect(body).toMatch(/on o\.user_id = a\.user_id/i);
    // Exactly the two in that one join predicate.
    expect(userIdMentions).toBe(2);
    for (const column of ["allowed_scopes", "policy", "budget_", "spent_", "agent_logs"]) {
      expect(body).not.toContain(column);
    }
  });

  it("shows an owner only once it has been published", () => {
    const body = migration.match(/as \$\$([\s\S]*?)\$\$/)?.[1] ?? "";
    expect(body).toMatch(/and o\.published/i);
    // A WHERE would suppress the passport row entirely for an unpublished
    // owner; it must be part of the LEFT JOIN so the columns come back NULL.
    expect(body).toMatch(/left join public\.agent_owners/i);
  });

  it("looks a passport up by its public key, never by the internal agent id", () => {
    expect(migration).toMatch(/where a\.passport_pubkey = p_passport_id/i);
    expect(migration).not.toMatch(/where[\s\S]{0,80}a\.id\s*=/i);
  });

  it("is service_role-only, so anon and authenticated gain no new database surface", () => {
    expect(migration).toMatch(
      /revoke all on function public\.verify_passport\(text\) from public, anon, authenticated/i
    );
    expect(migration).toMatch(
      /grant execute on function public\.verify_passport\(text\) to service_role/i
    );
    expect(migration).not.toMatch(/grant execute[^;]*to[^;]*\banon\b/i);
    expect(migration).not.toMatch(/grant execute[^;]*to[^;]*\bauthenticated\b/i);
  });

  it("pins search_path, as every definer function in this schema does", () => {
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path = ''/i);
  });

  // Widening a RETURNS TABLE forces a DROP — Postgres will not change the return
  // type of an existing function. Dropping discards the function's ACL, and the
  // default for a new function is EXECUTE to PUBLIC. So any migration that drops
  // this function MUST re-issue the revoke, or anon silently regains the ability
  // to call it through PostgREST and 0015's central protection is gone.
  it("re-issues the revoke whenever it drops the function", () => {
    if (!/drop function[^;]*verify_passport/i.test(migration)) return;

    const dropAt = migration.search(/drop function[^;]*verify_passport/i);
    const revokeAt = migration.search(
      /revoke all on function public\.verify_passport\(text\) from public, anon, authenticated/i
    );
    const grantAt = migration.search(
      /grant execute on function public\.verify_passport\(text\) to service_role/i
    );

    expect(revokeAt).toBeGreaterThan(dropAt);
    expect(grantAt).toBeGreaterThan(dropAt);
  });
});

describe("the owner binding table", () => {
  const owners = readFileSync(join(repo, "db/migrations/0017_agent_owners.sql"), "utf8");

  // Load-bearing for three call sites, none of which say so out loud:
  // setOwner upserts with onConflict "user_id", and readOwner /
  // readCurrentOwner both use .maybeSingle(), which ERRORS if more than one row
  // comes back. One row per tenant is what makes all three correct — and it is
  // also what keeps verify_passport's LEFT JOIN from multiplying agent rows.
  it("keys one owner per tenant, which upsert and maybeSingle both depend on", () => {
    expect(owners).toMatch(/user_id\s+uuid primary key references public\.users\(id\)/i);
  });

  it("enables RLS and scopes reads to the owning tenant", () => {
    expect(owners).toMatch(/alter table public\.agent_owners enable row level security/i);
    expect(owners).toMatch(/user_id = \(select auth\.uid\(\)\)/i);
  });

  // The tier is the whole value of the binding. A tenant that can write its own
  // tier can call itself domain-verified, which makes the label worthless.
  it("never lets a client write its own tier", () => {
    expect(owners).toMatch(/revoke insert, update, delete on public\.agent_owners/i);
    expect(owners).not.toMatch(/create policy[\s\S]*agent_owners[\s\S]*for (insert|update|all)/i);
  });

  it("constrains tier and kind to known values", () => {
    expect(owners).toMatch(/check \(kind in \('self_attested', 'domain', 'idv'\)\)/i);
    expect(owners).toMatch(/check \(tier in \('unverified', 'domain', 'idv'\)\)/i);
  });

  it("defaults to unpublished and unverified", () => {
    expect(owners).toMatch(/published\s+boolean not null default false/i);
    expect(owners).toMatch(/tier\s+text not null default 'unverified'/i);
  });
});

describe("the public verification route", () => {
  const middleware = readFileSync(join(repo, "middleware.ts"), "utf8");
  const robots = readFileSync(join(repo, "app/robots.ts"), "utf8");

  it("is reachable without a session", () => {
    const publicPaths = middleware.match(/const PUBLIC_PATHS = \[([\s\S]*?)\]/)?.[1] ?? "";
    expect(publicPaths).toContain('"/verify"');
  });

  it("is dynamically rendered, so it carries a nonce like every other dynamic page", () => {
    // Adding it to PRERENDERED_PUBLIC_PATHS would opt the page into
    // 'unsafe-inline'. It reads the database per request; it must stay dynamic.
    expect(PRERENDERED_PUBLIC_PATHS).not.toContain("/verify");
    expect(isPrerenderedPublicPath("/verify/anything")).toBe(false);

    const page = readFileSync(join(repo, "app/verify/[passportId]/page.tsx"), "utf8");
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("does not decode the route param a second time", () => {
    // Next has already percent-decoded the segment. Decoding again throws
    // URIError on a segment that decodes to a bare `%` — /verify/100%25 was a
    // 500 with a stack trace on the app's only unauthenticated route.
    const page = readFileSync(join(repo, "app/verify/[passportId]/page.tsx"), "utf8");
    expect(page).not.toMatch(/decodeURIComponent\s*\(\s*passportId/);
  });

  it("is shareable but not indexable", () => {
    expect(robots).toMatch(/"\/verify\/"/);
    const page = readFileSync(join(repo, "app/verify/[passportId]/page.tsx"), "utf8");
    expect(page).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});
