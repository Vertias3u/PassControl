// The database and routing side of PAVP. lib/verify/passport.ts is where the
// rendered shape is pinned; this pins the two things that live outside it — what
// the SQL function is allowed to return and to whom, and the fact that the page
// is public without being prerendered or indexed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRERENDERED_PUBLIC_PATHS, isPrerenderedPublicPath } from "@/lib/csp";

const repo = process.cwd();
const migration = readFileSync(
  join(repo, "db/migrations/0015_public_passport_verification.sql"),
  "utf8"
);

describe("the public verification function", () => {
  it("returns only the three public columns", () => {
    const returns = migration.match(/returns table \(([\s\S]*?)\)/i)?.[1] ?? "";
    const columns = returns
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);

    expect(columns.sort()).toEqual(["created_at", "passport_pubkey", "status"]);
  });

  it("never selects a private column", () => {
    const body = migration.match(/as \$\$([\s\S]*?)\$\$/)?.[1] ?? "";
    expect(body).toBeTruthy();
    for (const column of [
      "name",
      "user_id",
      "allowed_scopes",
      "policy",
      "budget_tokens",
      "budget_cents",
      "spent_tokens",
      "spent_microcents",
      "agent_logs",
    ]) {
      expect(body).not.toContain(column);
    }
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
