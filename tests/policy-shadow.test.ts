// Policy shadow mode — the schema and the write-side validator.
//
// Shadow mode lets an operator run a candidate policy against real traffic and
// see what it WOULD have done, without it deciding anything. The whole feature
// is only worth having if that second half is airtight, so the tests are
// organised around the ways it could stop being true:
//
//  1. The candidate becomes writable by the tenant directly, bypassing the
//     validator (a `grant update` in the migration).
//  2. The validator drifts from the reader, so shadow mode predicts a verdict
//     the gateway would not actually reach.
//  3. The shadow value leaks into something that binds — a receipt, a visa.
//
// The proxy hook and its two guards (the hourly counter must be charged exactly
// once; the shadow evaluation must be unable to throw on the credential path)
// are NOT covered here yet — that code is not written. This file covers the
// migration and the validator only, and says so rather than implying more.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validatePolicy } from "@/lib/validate";
import { policyIsWellFormed, agentPolicyForDisplay } from "@/lib/scope";

const repo = process.cwd();
const raw = readFileSync(join(repo, "db/migrations/0020_agent_policy_shadow.sql"), "utf8");

// Assert on the statements, not the commentary. This migration's header explains
// at length WHY it issues no `grant update`, and a file-wide match on that
// phrase fails on the prose that documents the guarantee — a test that punishes
// the explanation is a test that gets the explanation deleted.
const sql = raw.replace(/--[^\n]*/g, "");

describe("the migration", () => {
  it("adds both columns nullable, with no default and no backfill", () => {
    expect(sql).toMatch(/alter table public\.agents\s+add column policy_shadow jsonb/i);
    expect(sql).toMatch(/alter table public\.agent_logs\s+add column policy_shadow_would text/i);
    // A default would give every existing agent a shadow policy, and a NOT NULL
    // would need a backfill on a table the gateway reads on every call.
    expect(sql).not.toMatch(/policy_shadow[^;]*default/i);
    expect(sql).not.toMatch(/policy_shadow[^;]*not null/i);
    expect(sql).not.toMatch(/\bupdate public\./i);
  });

  // The reason this column is not in the 0011 allowlist. A tenant who could
  // PATCH it through PostgREST would write it without ever meeting
  // validatePolicy.
  it("grants the authenticated role nothing", () => {
    expect(sql).not.toMatch(/grant\s+update/i);
    expect(sql).not.toMatch(/to authenticated/i);
  });

  it("does not touch RLS or any other table", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/row level security/i);
    const tables = [...sql.matchAll(/alter table public\.(\w+)/gi)].map((m) => m[1]).sort();
    expect([...new Set(tables)]).toEqual(["agent_logs", "agents"]);
  });
});

describe("validatePolicy", () => {
  it("accepts null as 'no policy' — the way shadow mode is turned off", () => {
    expect(validatePolicy(null)).toBeNull();
    expect(validatePolicy(undefined)).toBeNull();
  });

  it.each([
    ["an empty document", {}],
    ["a deny rule", { deny: [{ provider: "anthropic", models: ["claude-*"] }] }],
    ["a time window", { windows: [{ days: ["mon"], start: "09:00", end: "17:00", tz: "UTC" }] }],
    ["an hourly cap", { max_requests_per_hour: 100 }],
  ])("accepts %s", (_label, value) => {
    expect(validatePolicy(value)).toEqual(value);
  });

  it.each([
    ["a bare string", "deny everything"],
    ["an array", [{ provider: "anthropic" }]],
    ["an unknown top-level key", { deny: [], sudo: true }],
    ["a deny rule with no models array", { deny: [{ provider: "anthropic", models: "claude-*" }] }],
    ["a deny rule with an extra key", { deny: [{ provider: "x", models: ["y"], force: 1 }] }],
    ["a non-numeric hourly cap", { max_requests_per_hour: "100" }],
  ])("rejects %s", (_label, value) => {
    expect(() => validatePolicy(value)).toThrow();
  });

  // The error is shown to an operator who just typed a rule, so it has to say
  // enough to fix it — and nothing about internals.
  it("explains itself without leaking internals", () => {
    let message = "";
    try {
      validatePolicy("nope");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/deny|window|rate limit/i);
    expect(message).not.toMatch(/parsePolicy|jsonb|postgres|undefined|\[object/i);
  });
});

// The property the whole design rests on: the validator does not own a second
// copy of the bounds. If someone reimplements validatePolicy by hand, these
// fail — which is the point.
describe("the validator cannot drift from the reader", () => {
  const cases: unknown[] = [
    null,
    {},
    { deny: [] },
    { deny: [{ provider: "anthropic", models: ["claude-*"] }] },
    { windows: [{ days: ["mon"], start: "09:00", end: "17:00", tz: "UTC" }] },
    { windows: [{ days: ["mon"], start: "9am", end: "5pm", tz: "UTC" }] },
    { windows: [{ days: ["mon"], start: "09:00", end: "17:00", tz: "CET" }] },
    { max_requests_per_hour: 100 },
    { max_requests_per_hour: -1 },
    { max_requests_per_hour: "100" },
    "nope",
    [],
    42,
    { sudo: true },
    { deny: [{ provider: "", models: ["x"] }] },
    { deny: [{ provider: "anthropic", models: [""] }] },
  ];

  it.each(cases.map((c, i) => [i, c]))(
    "case %i: accepted by the validator exactly when the reader can read it",
    (_i, value) => {
      let accepted = true;
      try {
        validatePolicy(value);
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(policyIsWellFormed(value ?? null));
    }
  );

  // policyIsWellFormed must be the reader's real verdict, not a lookalike.
  // agentPolicyForDisplay routes through the same parsePolicy, so its `valid`
  // flag is an independent read of the same boundary.
  it.each(cases.map((c, i) => [i, c]))("case %i: agrees with the display path", (_i, value) => {
    expect(policyIsWellFormed(value ?? null)).toBe(agentPolicyForDisplay(value ?? null).valid);
  });
});

describe("the shadow value never reaches anything that binds", () => {
  const read = (p: string) => readFileSync(join(repo, p), "utf8");

  // A receipt binds the gateway's DECISION. A hypothetical decision is not one,
  // and putting it in a signed artifact invites a reader to treat it as one.
  it("is absent from the receipt builder and the visa", () => {
    for (const path of ["lib/auth/visa.ts", "lib/scope.ts"]) {
      expect(read(path), path).not.toMatch(/policy_shadow/);
    }
  });
});
