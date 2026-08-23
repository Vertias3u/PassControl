import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planAgentImports, planOwnershipImport } from "@/lib/workspace-import";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

// Real passport ids: base64url of 32 bytes, which is what
// passportIdToPublicKey accepts (lib/crypto/ed25519.ts:24). Fixed rather than
// generated so every case below differs in exactly the field under test.
const PUBKEY_A = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const PUBKEY_B = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

function agent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "billing-bot",
    passport_pubkey: PUBKEY_A,
    allowed_scopes: [{ provider: "anthropic", models: ["claude-*"] }],
    budget_tokens: 1000,
    budget_cents: null,
    policy: { max_requests_per_hour: 10 },
    policy_shadow: null,
    fallbacks: [],
    status: "active",
    expires_at: null,
    ...over,
  };
}

describe("planAgentImports — the pure decision", () => {
  it("plans a create for an agent whose passport is not already registered", () => {
    const plan = planAgentImports([agent()], []);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ action: "create", name: "billing-bot" });
  });

  // The collision key is the passport public key, NOT the name: `agents` has a
  // unique constraint on passport_pubkey and none at all on name (0001_init),
  // so two agents may legitimately share a name and the same passport may not
  // be registered twice.
  it("skips an agent whose passport is already registered, and issues no row", () => {
    const plan = planAgentImports([agent()], [PUBKEY_A]);
    expect(plan[0]).toMatchObject({ action: "skip", reason: "already_exists" });
    expect(plan[0]).not.toHaveProperty("row");
  });

  it("does not treat a shared name as a collision", () => {
    const plan = planAgentImports([agent({ passport_pubkey: PUBKEY_B })], [PUBKEY_A]);
    expect(plan[0]).toMatchObject({ action: "create" });
  });

  it("refuses a duplicate passport in the file instead of claiming the tenant already owns it", () => {
    const plan = planAgentImports([agent(), agent({ name: "same-key-copy" })], []);
    expect(plan[0]).toMatchObject({ action: "create" });
    expect(plan[1]).toMatchObject({
      action: "reject",
      name: "same-key-copy",
      reason: "duplicate_passport_in_file",
    });
  });

  // ── The permission-widening pins ──────────────────────────────────────────
  // lib/scope.ts:269 — parsePolicy(null) returns { deny: [], windows: [],
  // maxRequestsPerHour: null }. A null policy is therefore not "no policy yet",
  // it is NO RESTRICTIONS. Creating a policy-bearing agent without its policy
  // would hand back something strictly more permissive than the file described,
  // on a fleet table that shows it as restored. Reject the whole agent instead.
  it("rejects an agent whose policy is malformed rather than creating it unrestricted", () => {
    const plan = planAgentImports([agent({ policy: { bogusKey: true } })], []);
    expect(plan[0]).toMatchObject({ action: "reject" });
    expect(plan[0]).not.toHaveProperty("row");
  });

  // A missing property and an exported `null` are different facts. `null` is
  // the intentional, unrestricted policy setting; an absent property is a
  // truncated file. Letting the latter reach the column default would widen a
  // formerly constrained agent while still calling it restored.
  it("accepts an explicit null policy but rejects an omitted one", () => {
    const unrestricted = planAgentImports([agent({ policy: null })], []);
    expect(unrestricted[0]).toMatchObject({ action: "create" });
    expect((unrestricted[0] as { row: Record<string, unknown> }).row.policy).toBeNull();

    const truncated = agent();
    delete truncated.policy;
    expect(planAgentImports([truncated], [])[0]).toMatchObject({
      action: "reject",
      reason: "policy_missing",
    });
  });

  it("rejects a malformed shadow policy too", () => {
    const plan = planAgentImports([agent({ policy_shadow: { bogusKey: true } })], []);
    expect(plan[0]).toMatchObject({ action: "reject" });
  });

  // `[]` is how failover is switched off (lib/validate.ts:220-222), so writing
  // `[]` for a list that failed validation is not a safe default — it is a
  // different configuration that happens to look tidy.
  it("rejects a malformed fallback list rather than writing it as empty", () => {
    const plan = planAgentImports([agent({ fallbacks: [{ provider: "nope", model: 5 }] })], []);
    expect(plan[0]).toMatchObject({ action: "reject" });
  });

  it("rejects an agent with an invalid passport key", () => {
    const plan = planAgentImports([agent({ passport_pubkey: "not-a-key" })], []);
    expect(plan[0]).toMatchObject({ action: "reject" });
  });

  it("preserves a restrictive status rather than resurrecting the agent as active", () => {
    const plan = planAgentImports([agent({ status: "revoked" })], []);
    expect(plan[0]).toMatchObject({ action: "create" });
    expect((plan[0] as { row: Record<string, unknown> }).row.status).toBe("revoked");
  });

  it.each([
    "status",
    "budget_tokens",
    "budget_cents",
    "allowed_scopes",
    "expires_at",
    "fallbacks",
    "policy_shadow",
  ])("rejects a truncated %s field rather than taking a permissive database default", (field) => {
    const truncated = agent();
    delete truncated[field];
    expect(planAgentImports([truncated], [])[0]).toMatchObject({
      action: "reject",
      reason: `${field}_missing`,
    });
  });

  it("carries live restrictions and suspension into the one insert row", () => {
    const policy = { deny: [{ provider: "anthropic", models: ["claude-secret-*"] }], max_requests_per_hour: 3 };
    const shadow = { max_requests_per_hour: 2 };
    const plan = planAgentImports([
      agent({
        policy,
        policy_shadow: shadow,
        status: "suspended",
        budget_tokens: 42,
        budget_cents: 7,
        expires_at: "2028-01-01T00:00:00.000Z",
        fallbacks: [{ provider: "openai", model: "gpt-4o-mini" }],
      }),
    ], []);
    expect(plan[0]).toMatchObject({ action: "create" });
    expect((plan[0] as { row: Record<string, unknown> }).row).toMatchObject({
      policy,
      policy_shadow: shadow,
      status: "suspended",
      budget_tokens: 42,
      budget_cents: 7,
      expires_at: "2028-01-01T00:00:00.000Z",
      fallbacks: [{ provider: "openai", model: "gpt-4o-mini" }],
    });
  });

  it("rejects a status outside the enum instead of falling back to the default", () => {
    const plan = planAgentImports([agent({ status: "godmode" })], []);
    expect(plan[0]).toMatchObject({ action: "reject" });
  });

  // ── What must never cross ─────────────────────────────────────────────────
  it("never carries an identity, a public listing, or a server-clock field", () => {
    const plan = planAgentImports([agent({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      user_id: "someone-elses-tenant",
      created_at: "1999-01-01T00:00:00Z",
      published: true,
      public_label: "Trusted Bot",
    })], []);
    const row = (plan[0] as { row: Record<string, unknown> }).row;
    // user_id is supplied by the route from the authenticated caller. A planner
    // that emitted it at all would make a file able to name its own tenant.
    for (const forbidden of ["id", "user_id", "created_at", "published", "public_label"]) {
      expect(Object.keys(row), `${forbidden} must not be importable`).not.toContain(forbidden);
    }
  });
});

describe("planOwnershipImport", () => {
  it("restores the declaration unverified, never the proof of it", () => {
    const plan = planOwnershipImport(
      { kind: "domain", subject: "example.com", tier: "domain", published: true, verified_at: "2026-01-01T00:00:00Z" },
      false
    );
    expect(plan).toMatchObject({ action: "create" });
    const row = (plan as { row: Record<string, unknown> }).row;
    // tier records what was actually PROVEN (0017_agent_owners.sql). A file that
    // could set it would make the verified badge self-declared.
    for (const forbidden of ["tier", "verified_at", "published", "verification_token", "user_id"]) {
      expect(Object.keys(row), `${forbidden} must not be importable`).not.toContain(forbidden);
    }
    expect(row).toMatchObject({ kind: "domain", subject: "example.com" });
  });

  it("skips when the tenant already has an owner row", () => {
    const plan = planOwnershipImport({ kind: "self_attested", subject: "me" }, true);
    expect(plan).toMatchObject({ action: "skip" });
  });

  it("rejects a kind outside the check constraint", () => {
    expect(planOwnershipImport({ kind: "trust-me", subject: "me" }, false)).toMatchObject({ action: "reject" });
  });
});

describe("workspace import route", () => {
  const ROUTE = "app/api/control/v1/workspace/import/route.ts";

  it("requires the control-plane write scope", async () => {
    expect(await source(ROUTE)).toContain('control("write"');
  });

  it("scopes every write to the authenticated caller, not to the file", async () => {
    const route = await source(ROUTE);
    expect(route).toContain("user_id: userId");
  });

  // The preview an operator confirms and the writes that follow must come from
  // one function. Two implementations drift, and the confirmation then describes
  // something that did not happen.
  it("computes the dry run and the apply from the same planner", async () => {
    const route = await source(ROUTE);
    expect(route).toContain("planAgentImports");
    expect(route.match(/planAgentImports\(/g) ?? []).toHaveLength(1);
  });

  it("never imports credentials, grants or a handle", async () => {
    const route = await source(ROUTE);
    for (const forbidden of ["providerMappings", "provider_credentials", "breakGlassGrants", "username"]) {
      expect(route, `${forbidden} must not be written by an import`).not.toContain(`${forbidden}:`);
    }
  });
});
