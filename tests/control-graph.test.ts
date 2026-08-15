import { describe, expect, it } from "vitest";
import {
  appendPresentationEventQueue,
  buildControlGraph,
  eventFromStoredRow,
  mergeRealtimeStoredEvent,
  presentationOutcomeForStatus,
  presentationSnapshot,
  routeForStoredStatus,
  type ControlGraphAgentRow,
} from "@/lib/control-graph";
import type { DepartureRow } from "@/lib/departures";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function agent(overrides: Partial<ControlGraphAgentRow> = {}): ControlGraphAgentRow {
  return {
    id: "agent-sensitive-123",
    name: "Secret Research Agent",
    passport_pubkey: "passport-public-sensitive-suffix",
    status: "active",
    allowed_scopes: [
      { provider: "anthropic", models: ["claude-*", "claude-haiku-4-5"] },
      { provider: "anthropic", models: ["claude-haiku-4-5"] },
    ],
    budget_tokens: 10_000,
    budget_cents: 500,
    spent_tokens: 2_000,
    spent_microcents: 9_900_000,
    policy: { deny: [] },
    fallbacks: [{ provider: "openai", model: "gpt-5-mini" }],
    ...overrides,
  };
}

function log(overrides: Partial<DepartureRow> = {}): DepartureRow {
  return {
    id: "call-sensitive-456",
    agent_id: "agent-sensitive-123",
    user_id: "tenant-sensitive-789",
    created_at: "2026-08-13T11:59:00.000Z",
    passport_id: "passport-sensitive",
    jti: "jti-sensitive",
    auth_method: "passport",
    agent_access_key_id: null,
    credential_use_id: null,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    input_tokens: 12,
    output_tokens: 4,
    cost_microcents: 3000,
    status: "ok",
    latency_ms: 420,
    receipt: "receipt-sensitive",
    policy_shadow_would: "allow@revision-sensitive",
    ...overrides,
  };
}

describe("Control Graph truth model", () => {
  it.each([
    ["ok", "receipt", "allowed"],
    ["upstream_error", "provider", "warning"],
    ["provider_exhausted", "provider", "warning"],
    ["no_provider_key", "credential", "warning"],
    ["blocked_scope", "gate", "blocked"],
    ["blocked_policy", "gate", "blocked"],
    ["blocked_budget", "gate", "blocked"],
    ["blocked_killed", "gate", "blocked"],
    ["blocked_suspended", "gate", "blocked"],
    ["blocked_endpoint", "gate", "blocked"],
  ] as const)("routes %s to the stored boundary", (status, stop, tone) => {
    expect(routeForStoredStatus(status)).toMatchObject({ stop, tone });
  });

  it("does not coerce an unknown stored status into allowed", () => {
    expect(routeForStoredStatus("future_status")).toEqual({
      stop: "gate",
      tone: "warning",
      label: "Unknown status: future_status",
    });
  });

  it.each([
    ["ok", "CLEARED", "receipt", "allowed"],
    ["blocked_scope", "NO VISA", "gate", "blocked"],
    ["blocked_budget", "NO FUNDS", "gate", "blocked"],
    ["blocked_suspended", "SUSPENDED", "gate", "blocked"],
    ["blocked_killed", "KILL SWITCH", "gate", "blocked"],
    ["blocked_policy", "POLICY", "gate", "blocked"],
    ["blocked_endpoint", "ENDPOINT", "gate", "blocked"],
    ["no_provider_key", "NO KEY", "credential", "warning"],
    ["upstream_error", "PROVIDER ERROR", "provider", "warning"],
    ["provider_exhausted", "PROVIDER CREDIT", "provider", "warning"],
  ] as const)("maps %s to an honest presentation outcome", (status, label, stop, tone) => {
    expect(presentationOutcomeForStatus(status)).toEqual({ label, stop, tone });
  });

  it("never presents an unknown status as cleared", () => {
    expect(presentationOutcomeForStatus("future_status")).toEqual({
      label: "UNRECOGNIZED",
      stop: "gate",
      tone: "warning",
    });
  });

  it("keeps burst events in arrival order while bounding the animation queue", () => {
    const queue = ["first", "second", "third"].reduce(
      (current, event) => appendPresentationEventQueue(current, event, 2),
      [] as string[]
    );
    expect(queue).toEqual(["second", "third"]);
  });

  it("records a receipt marker only when an allowed row actually stores one", () => {
    expect(eventFromStoredRow(log()).receiptRecorded).toBe(true);
    expect(eventFromStoredRow(log({ receipt: null })).receiptRecorded).toBe(false);
    expect(eventFromStoredRow(log({ status: "blocked_scope" })).receiptRecorded).toBe(false);
  });

  it("collapses duplicate provider scopes and excludes expired elevation", () => {
    const snapshot = buildControlGraph({
      agents: [agent()],
      providerCredentials: ["anthropic"],
      grants: [{
        id: "grant-1",
        agent_id: "agent-sensitive-123",
        scopes: [{ provider: "groq", models: ["llama-*"] }],
        expires_at: "2026-08-13T11:00:00.000Z",
      }],
      logs: [log()],
      killArmed: false,
      now: NOW,
    });
    const anthropic = snapshot.edges.filter((edge) => edge.kind === "scope" && edge.provider === "anthropic");
    expect(anthropic).toHaveLength(1);
    expect(anthropic[0]?.models).toEqual(["claude-*", "claude-haiku-4-5"]);
    expect(snapshot.edges.some((edge) => edge.kind === "elevation")).toBe(false);
    expect(snapshot.nodes.find((node) => node.id === "provider:anthropic")?.state).toBe("ready");
    expect(snapshot.nodes.find((node) => node.id === "provider:openai")?.state).toBe("missing");
    expect(snapshot.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "gate:passcontrol", target: "credential:vault", kind: "approval" }),
      expect.objectContaining({ source: "credential:vault", target: "provider:anthropic", kind: "dispatch" }),
    ]));
  });

  it("shows only a live, unrevoked break-glass edge with its exact deadline", () => {
    const snapshot = buildControlGraph({
      agents: [agent()],
      providerCredentials: [],
      grants: [{
        id: "grant-1",
        agent_id: "agent-sensitive-123",
        scopes: [{ provider: "groq", models: ["llama-*"] }],
        expires_at: "2026-08-13T13:00:00.000Z",
        revoked_at: null,
      }],
      logs: [],
      killArmed: false,
      now: NOW,
    });
    expect(snapshot.edges.find((edge) => edge.kind === "elevation")).toMatchObject({
      agentId: "agent-sensitive-123",
      provider: "groq",
      expiresAt: "2026-08-13T13:00:00.000Z",
    });
  });

  it("surfaces a per-agent emergency denylist without implying a tenant-wide kill", () => {
    const snapshot = buildControlGraph({
      agents: [agent()],
      providerCredentials: ["anthropic"],
      grants: [],
      logs: [],
      killArmed: false,
      denylistedAgentIds: ["agent-sensitive-123"],
      now: NOW,
    });
    expect(snapshot.killArmed).toBe(false);
    expect(snapshot.emergencyBlockedCount).toBe(1);
    expect(snapshot.nodes.find((node) => node.id === "agent:agent-sensitive-123")?.state).toBe("armed");
    expect(snapshot.agents["agent-sensitive-123"]?.emergencyBlocked).toBe(true);
  });

  it("adds honest placeholder topology for a realtime event from an identity not loaded yet", () => {
    const initial = buildControlGraph({
      agents: [agent()],
      providerCredentials: ["anthropic"],
      grants: [],
      logs: [],
      killArmed: false,
      now: NOW,
    });
    const merged = mergeRealtimeStoredEvent(initial, log({
      id: "new-call",
      agent_id: "new-agent",
      provider: "groq",
      model: "llama-3.3-70b-versatile",
    }));
    expect(merged.nodes.find((node) => node.id === "agent:new-agent")).toMatchObject({
      label: "Identity outside loaded topology",
      state: "unknown",
    });
    expect(merged.nodes.find((node) => node.id === "provider:groq")?.state).toBe("unknown");
    expect(merged.events[0]).toMatchObject({
      agentNodeId: "agent:new-agent",
      providerNodeId: "provider:groq",
    });
    expect(merged.events[0]?.agentNodeId).not.toBe("agent:historical");
  });

  it("builds a historical identity node without inventing a current agent", () => {
    const snapshot = buildControlGraph({
      agents: [],
      providerCredentials: [],
      grants: [],
      logs: [log({ agent_id: null })],
      killArmed: false,
      now: NOW,
    });
    expect(snapshot.nodes.find((node) => node.id === "agent:historical")?.state).toBe("revoked");
    expect(snapshot.events[0]?.agentNodeId).toBe("agent:historical");
  });

  it("removes tenant-sensitive values from the presentation snapshot itself", () => {
    const raw = buildControlGraph({
      agents: [agent()],
      providerCredentials: ["anthropic"],
      grants: [],
      logs: [log()],
      killArmed: false,
      now: NOW,
    });
    const serialized = JSON.stringify(presentationSnapshot(raw));
    for (const secret of [
      "Secret Research Agent",
      "agent-sensitive-123",
      "tenant-sensitive-789",
      "call-sensitive-456",
      "passport-sensitive",
      "jti-sensitive",
      "receipt-sensitive",
      "revision-sensitive",
      "passport-public-sensitive-suffix",
      "9900000",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("Agent 01");
    expect(serialized).toContain("anthropic");
    expect(serialized).toContain("claude-haiku-4-5");
  });

  it("named presentation reveals only the display name and strips sensitive identity state", () => {
    const raw = buildControlGraph({
      agents: [agent()],
      providerCredentials: ["anthropic"],
      grants: [{ id: "grant-secret", agent_id: "agent-sensitive-123", scopes: [], expires_at: "2026-08-13T13:00:00.000Z" }],
      logs: [log()],
      killArmed: false,
      now: NOW,
    });
    const serialized = JSON.stringify(presentationSnapshot(raw, "named"));
    expect(serialized).toContain("Secret Research Agent");
    for (const secret of [
      "agent-sensitive-123", "tenant-sensitive-789", "call-sensitive-456",
      "passport-sensitive", "jti-sensitive", "receipt-sensitive",
      "passport-public-sensitive-suffix", "2026-08-13T13:00:00.000Z", "9900000",
    ]) expect(serialized).not.toContain(secret);
  });
});
