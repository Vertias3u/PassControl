import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "db/migrations/0036_system_health_snapshot.sql"), "utf8");

describe("system-health database snapshot migration", () => {
  it("is a read-only service-role-only security-definer RPC with a pinned path", () => {
    expect(sql).toMatch(/create function public\.system_health_snapshot\(\)[\s\S]*security definer[\s\S]*stable[\s\S]*set search_path = ''/i);
    expect(sql).toMatch(/revoke all on function public\.system_health_snapshot\(\) from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.system_health_snapshot\(\) to service_role/i);
    const body = sql.match(/as \$\$([\s\S]*?)\$\$/i)?.[1] ?? "";
    expect(body).not.toMatch(/\b(insert|update|delete|format)\b/i);
  });
});
