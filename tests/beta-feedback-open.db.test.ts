import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0077: once sign-up is open, most accounts never had a beta application, and
 * 0025 made beta_feedback.application_id NOT NULL, so their feedback could not
 * be stored at all. Proved against the dev stack's database inside one
 * transaction that is always rolled back, with 0077 applied INSIDE it.
 * SKIPS only when the database is unreachable.
 */
const CONTAINER = process.env.LIMITS_DB_CONTAINER ?? "supabase_db_PassControl";
const MIGRATION = readFileSync(
  new URL("../db/migrations/0077_beta_feedback_without_application.sql", import.meta.url),
  "utf8"
);

function tryPsql(sql: string): { ok: boolean; out: string } {
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

const up = tryPsql("select 1 from public.beta_feedback limit 1;").ok;
const when = up ? it : it.skip;

function withAccount(body: string): { ok: boolean; out: string } {
  const uid = randomUUID();
  return tryPsql(`
    begin;
    ${MIGRATION}
    insert into auth.users (id, email) values ('${uid}', 'feedback-${uid}@example.test');
    insert into public.users (id, email) values ('${uid}', 'feedback-${uid}@example.test')
      on conflict (id) do nothing;
    ${body.replaceAll(":uid", `'${uid}'`)}
    rollback;
  `);
}

describe("0077 beta feedback without an application", () => {
  when("stores feedback from an account that never applied", () => {
    const result = withAccount(`
      insert into public.beta_feedback (user_id, application_id, setup_rating, feedback)
      values (:uid, null, 4, 'Open sign-up feedback, no application.');
      select count(*) from public.beta_feedback where user_id = :uid and application_id is null;
    `);
    expect(result.out).not.toMatch(/violates not-null/);
    expect(result.ok).toBe(true);
    expect(result.out.split("\n")).toContain("1");
  });

  when("keeps every other rule: a rating outside 1..5 is still refused", () => {
    const result = withAccount(`
      insert into public.beta_feedback (user_id, application_id, setup_rating, feedback)
      values (:uid, null, 9, 'Rating out of range should fail.');
    `);
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/check constraint/);
  });
});
