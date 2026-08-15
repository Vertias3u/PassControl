import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLOUD_FAILURE_GUIDE,
  buildCloudSupportBundle,
  cloudOperationsNeedsAttention,
} from "@/lib/cloud-operations";

const repo = process.cwd();

describe("Cloud beta operations surface", () => {
  const signals = {
    providerCredentials: "configured" as const,
    receiptSigning: "configured" as const,
    observability: "configured" as const,
    agentRegistry: "available" as const,
    activityLog: "available" as const,
  };
  const quota = {
    state: "available" as const,
    resetAt: "2026-09-01T00:00:00.000Z",
    workspace: { used: 10, limit: 100, remaining: 90, utilization: .1 },
    globalCapacity: "available" as const,
  };

  it("auto-expands only for receipt, read, or capacity attention", () => {
    expect(cloudOperationsNeedsAttention(quota, signals)).toBe(false);
    expect(cloudOperationsNeedsAttention(quota, { ...signals, providerCredentials: "missing" })).toBe(false);
    expect(cloudOperationsNeedsAttention(quota, { ...signals, observability: "missing" })).toBe(false);
    expect(cloudOperationsNeedsAttention(quota, { ...signals, receiptSigning: "missing" })).toBe(true);
    expect(cloudOperationsNeedsAttention(quota, { ...signals, activityLog: "unavailable" })).toBe(true);
    expect(cloudOperationsNeedsAttention({ ...quota, workspace: { ...quota.workspace, utilization: .8 } }, signals)).toBe(true);
    expect(cloudOperationsNeedsAttention({ ...quota, globalCapacity: "near-limit" }, signals)).toBe(true);
    expect(cloudOperationsNeedsAttention({ ...quota, state: "unavailable" }, signals)).toBe(true);
  });
  it("keeps quota, rate limit, budget, suspension, and authentication failures distinct", () => {
    const byCode = new Map(CLOUD_FAILURE_GUIDE.flatMap((item) => item.codes.map((code) => [code, item])));
    for (const code of [
      "beta_quota_exceeded",
      "quota_unavailable",
      "rate_limited",
      "authentication_rate_limit_unavailable",
      "blocked_budget",
      "blocked_suspended",
      "blocked_killed",
      "invalid_credential",
      "invalid_visa",
      "authentication_unavailable",
    ]) {
      expect(byCode.has(code), code).toBe(true);
    }
    expect(byCode.get("beta_quota_exceeded")?.title).not.toBe(byCode.get("blocked_budget")?.title);
    expect(byCode.get("blocked_suspended")?.title).not.toBe(byCode.get("invalid_credential")?.title);
    expect(new Set(CLOUD_FAILURE_GUIDE.map((item) => item.action)).size).toBe(CLOUD_FAILURE_GUIDE.length);
  });

  it("builds the support bundle from an allowlist and aggregates failures without raw records", () => {
    const bundle = buildCloudSupportBundle({
      generatedAt: "2026-08-09T12:00:00.000Z",
      quota: {
        state: "available",
        resetAt: "2026-09-01T00:00:00.000Z",
        workspace: { used: 14, limit: 100, remaining: 86, utilization: 0.14 },
        globalCapacity: "available",
      },
      signals: {
        providerCredentials: "configured",
        receiptSigning: "configured",
        observability: "missing",
        agentRegistry: "available",
        activityLog: "available",
      },
      controls: { workspaceKillArmed: false, platformKillArmed: false },
      agents: [{
        id: "agent-12345678",
        name: "Indexer",
        status: "active",
        passport_pubkey: "passport-public-material-ABCDEFGH",
        budget_tokens: 1000,
        budget_cents: null,
        spent_tokens: 250,
        spent_microcents: 5000000,
        allowed_scopes: [{ provider: "openai", models: ["gpt-4.1", "gpt-*"] }],
        fallbacks: [{ provider: "anthropic", model: "claude-sonnet-4" }],
        policy: { deny: [{ provider: "openai", models: ["gpt-5"] }], windows: [{ days: ["mon"], start: "09:00", end: "17:00", tz: "UTC" }] },
        policy_shadow: { deny: [] },
        created_at: "2026-08-01T00:00:00Z",
        last_seen_at: "2026-08-09T11:00:00Z",
        expires_at: null,
        previous_valid_until: null,
        provider_api_key: "forbidden-provider-key",
        secret: "forbidden-secret",
      }],
      logs: [{
        id: "raw-log-id",
        agent_id: "agent-12345678",
        created_at: "2026-08-09T11:00:00Z",
        provider: "openai",
        model: "gpt-4.1",
        status: "blocked_budget",
        receipt: "forbidden-receipt",
        jti: "forbidden-jti",
        credential_use_id: "forbidden-credential-use-id",
        prompt: "forbidden-prompt",
      }, {
        agent_id: "agent-12345678",
        created_at: "2026-08-09T10:00:00Z",
        provider: "openai",
        model: "gpt-4.1",
        status: "blocked_budget",
      }],
    });

    expect(bundle).toMatchObject({
      schema_version: 1,
      service_health: {
        quota_counter: "available",
        agent_registry: "available",
        activity_log: "available",
      },
      agents: [{
        id: "agent-12345678",
        name: "Indexer",
        passport: { attached: true, public_key_suffix: "ABCDEFGH" },
        scopes: { provider_count: 1, model_pattern_count: 2 },
        fallbacks: { count: 1 },
        policy: { configured: true, deny_rule_count: 1, has_time_window: true },
        shadow_policy: { configured: true },
        budget: { cost_limit_cents: null },
      }],
      recent_failures: [{
        code: "blocked_budget",
        count: 2,
        latest_at: "2026-08-09T11:00:00Z",
      }],
    });
    const serialized = JSON.stringify(bundle);
    for (const forbidden of [
      "forbidden-provider-key",
      "forbidden-secret",
      "forbidden-receipt",
      "forbidden-jti",
      "forbidden-credential-use-id",
      "forbidden-prompt",
      "passport-public-material-ABCDEFGH",
      "gpt-4.1",
      "gpt-*",
      "claude-sonnet-4",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps loading, empty, unavailable, and downloadable states explicit in the rendered surface", () => {
    const component = readFileSync(join(repo, "components/dashboard/CloudBetaOperations.tsx"), "utf8");
    const skeleton = readFileSync(join(repo, "components/dashboard/DashboardSkeleton.tsx"), "utf8");
    const page = readFileSync(join(repo, "app/dashboard/page.tsx"), "utf8");
    expect(page).toContain("<CloudBetaOperations");
    expect(component).toMatch(/data-quota-state=\{quota\.state\}/);
    expect(component).toMatch(/data-bundle-state=\{bundleState\}/);
    expect(component).toContain("<details");
    expect(component).toContain('data-attention={needsAttention ? "required" : "clear"}');
    expect(component).toContain("Usage counter unavailable");
    expect(component).toContain("Cloud allowance not configured");
    expect(component).toContain("Download redacted bundle");
    expect(skeleton).toContain('data-skeleton="operations"');
  });
});
