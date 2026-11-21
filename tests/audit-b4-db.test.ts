// B4: ordered source audit, not a substitute for catalog checks on a local stack.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const files = readdirSync(join(root, "db/migrations")).filter(n => /^\d{4}.*\.sql$/.test(n)).sort();
type Statement = { sql: string; file: string };
// Split only outside strings, comments and dollar bodies. Function bodies contain
// semicolons and SQL-looking strings which must not become outer DDL/grants.
function statements(source: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < source.length;) {
    if (source.startsWith("--", i)) {
      const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; current += " ";
    } else if (source.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("unclosed SQL comment");
      current += " ";
    } else if (source[i] === "'") {
      const start = i++;
      while (i < source.length) {
        if (source[i++] !== "'") continue;
        if (source[i] === "'") { i++; continue; }
        break;
      }
      current += source.slice(start, i);
    } else if (source[i] === "$" && /^\$(?:[a-z_]\w*)?\$/i.test(source.slice(i))) {
      const tag = source.slice(i).match(/^\$(?:[a-z_]\w*)?\$/i)![0];
      const end = source.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error("unclosed dollar body");
      current += source.slice(i, end + tag.length); i = end + tag.length;
    } else if (source[i] === ";") {
      if (current.trim()) out.push(current.trim()); current = ""; i++;
    } else current += source[i++];
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
const all: Statement[] = files.flatMap(file => statements(readFileSync(join(root, "db/migrations", file), "utf8"))
  .map(sql => ({ file, sql: sql.toLowerCase().replace(/\s+/g, " ") })));
const privileges = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
type Table = { rls: boolean; policies: Map<string, string>; grants: Map<string, Set<string>> };
const tables = new Map<string, Table>();
const functions = new Map<string, Statement>();
const functionGrants = new Map<string, Set<string>>();
const functionDefaults = new Set(["public", "anon", "authenticated"]);
const signature = (name: string, args: string, declaration = false) => name + "(" + args.split(",").map(arg => {
  const clean = arg.trim().split(/\s+default\s+/)[0]!.trim();
  return declaration ? clean.replace(/^(?:p_\w+|event)\s+/, "") : clean;
}).join(",") + ")";
function apply({ sql, file }: Statement) {
  const defaults = sql.match(/^alter default privileges(?: in schema public)? revoke execute on functions from (.+)$/);
  if (defaults) for (const role of defaults[1]!.split(",").map(r => r.trim())) functionDefaults.delete(role);
  let m = sql.match(/^create table (?:if not exists )?public\.(\w+)/);
  // Model Supabase's documented default API-role table grants as well as the
  // explicit migration statements. Catalog SQL distinguishes deployment drift.
  if (m && !tables.has(m[1]!)) tables.set(m[1]!, { rls: false, policies: new Map(),
    grants: new Map(["anon", "authenticated"].map(r => [r, new Set(privileges)])) });
  m = sql.match(/^alter table public\.(\w+) (enable|disable) row level security/);
  if (m) { const t = tables.get(m[1]!); if (t) t.rls = m[2] === "enable"; }
  m = sql.match(/^create policy (\w+) on public\.(\w+)\s+([\s\S]+)/);
  if (m) tables.get(m[2]!)?.policies.set(m[1]!, m[3]!.replace(/\s+/g, " "));
  m = sql.match(/^drop policy (?:if exists )?(\w+) on public\.(\w+)/);
  if (m) tables.get(m[2]!)?.policies.delete(m[1]!);
  m = sql.match(/^create (?:or replace )?function public\.(\w+)\s*\(([^)]*)\)/);
  if (m) {
    const key = signature(m[1]!, m[2]!, true);
    functions.set(key, { sql, file });
    // CREATE OR REPLACE preserves ACLs; a fresh function uses current defaults.
    if (!functionGrants.has(key)) functionGrants.set(key, new Set(functionDefaults));
  }
  m = sql.match(/^drop function (?:if exists )?public\.(\w+)\s*\(([^)]*)\)/);
  if (m) { const key = signature(m[1]!, m[2]!); functions.delete(key); functionGrants.delete(key); }
  m = sql.match(/^(grant|revoke) (?:all(?: privileges)?|execute) on function public\.(\w+)\s*\(([^)]*)\)\s+(?:to|from)\s+(.+)$/);
  if (m) {
    const key = signature(m[2]!, m[3]!);
    const roles = functionGrants.get(key);
    if (!roles) throw new Error(`grant for unknown function: ${key} in ${file}`);
    for (const role of m[4]!.split(",").map(r => r.trim())) m[1] === "grant" ? roles.add(role) : roles.delete(role);
  }
  m = sql.match(/^(grant|revoke) ([\s\S]+?) on (?:table )?([\s\S]+?) (?:to|from) ([\s\S]+)$/);
  if (m && !/^(function|schema|sequence)\b/.test(m[3]!)) {
    const rights = m[2]!.match(/\w+\s*\([^)]*\)|\w+/g) ?? [];
    for (const table of m[3]!.split(",").map(t => t.trim().replace(/^public\./, ""))) {
      const t = tables.get(table); if (!t) continue;
      for (const role of m[4]!.split(",").map(r => r.trim())) {
        const held = t.grants.get(role) ?? new Set<string>(); t.grants.set(role, held);
        for (const right of rights) {
          const expanded = right === "all" || right === "privileges" ? privileges : [right.replace(/\s+/g, " ")];
          for (const p of expanded) m[1] === "grant" ? held.add(p) : held.delete(p);
        }
      }
    }
  }
}
all.forEach(apply);
// 0019 guards the tooling-created ledger in a DO block. It is not a CREATE in
// the migration stream; model its known guarded operations separately.
const ledger = all.find(s => s.file.startsWith("0019") && s.sql.startsWith("do "));
if (ledger) {
  tables.set("schema_migrations", { rls: false, policies: new Map(), grants: new Map() });
  for (const match of ledger.sql.matchAll(/(?:revoke all on public\.schema_migrations from \w+|alter table public\.schema_migrations enable row level security)/g)) {
    apply({ sql: match[0], file: ledger.file });
  }
}
const columnUpdate = (column: string) => [...tables.get("agents")!.grants.get("authenticated")!]
  .some(p => p === "update" || p.startsWith("update (") && p.slice(p.indexOf("(") + 1, -1).split(",").map(s => s.trim()).includes(column));

beforeAll(() => {
  expect(files[0]).toMatch(/^0001_/);
  // A floor that proves the parser read the stream, not an inventory: Core prunes the
  // Cloud-only tables and has exactly 30 (curated suite, 2026-11-21).
  expect(tables.size).toBeGreaterThan(20); expect(functions.size).toBeGreaterThan(50);
  expect(tables.get("agents")?.rls).toBe(true);
  expect(functions.has("get_provider_key(uuid,text)")).toBe(true);
});

describe("B4 final migration state", () => {
  it("B4 final tables and policies retain tenant RLS and final definers retain empty search paths and restricted execution", () => {
    for (const [name, t] of tables) {
      expect(t.rls, name).toBe(true);
      for (const [policy, body] of t.policies) {
        const command = body.match(/^for (all|select|insert|update|delete) /)?.[1];
        expect(command, `${name}.${policy}`).toBeTruthy();
        const predicate = `(${name === "users" ? "id" : "user_id"} = (select auth.uid()))`;
        const using = command === "insert" ? "" : ` using ${predicate}`;
        const check = ["insert", "update", "all"].includes(command!) ? ` with check ${predicate}` : "";
        expect(body, `${name}.${policy}`).toBe(`for ${command} to authenticated${using}${check}`);
      }
    }
    const authenticated = new Set(["dismiss_onboarding()", "complete_onboarding()", "start_onboarding_refusal_test(uuid)",
      "agent_provider_stamps(uuid,uuid)", "agent_access_key_activity(uuid,uuid)"]);
    for (const [key, { sql }] of functions) {
      if (/security definer\b/.test(sql)) expect(sql, key).toMatch(/set search_path\s*(?:=|to)\s*''/);
      const roles = functionGrants.get(key)!;
      if (/security definer\b/.test(sql) || roles.has("authenticated") && !/returns trigger\b/.test(sql)) {
        expect(roles.has("public"), key).toBe(false); expect(roles.has("anon"), key).toBe(false);
        expect(roles.has("authenticated"), key).toBe(authenticated.has(key));
      }
    }
  });
  it.fails("B4-01 budget changes must retain the server validation audit and cache path", () => {
    for (const column of ["budget_tokens", "budget_cents", "budget_period", "budget_period_cents"]) {
      expect(columnUpdate(column), `authenticated UPDATE agents.${column}`).toBe(false);
    }
  });
  it.fails("B4-02 client table grants must exclude non-RLS DDL privileges", () => {
    // Existing admin-audit-checkpoint-grants-migration.test.ts covers four
    // previously fixed tables. This checks the remaining table surface.
    const covered = new Set(["admin_audit", "agent_spend_checkpoint", "agent_owners", "break_glass_grants"]);
    for (const [name, t] of tables) {
      if (covered.has(name)) continue;
      for (const role of ["anon", "authenticated"]) {
        for (const p of ["references", "trigger"]) expect(t.grants.get(role)?.has(p) ?? false, `${name} ${role} ${p}`).toBe(false);
      }
    }
  });
});
