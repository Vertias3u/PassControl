import type { DepartureRow } from "@/lib/departures";
import type { LogEntry } from "@/lib/log";
import { toScopeRows, type ScopeRow } from "@/lib/scope-rows";

export type ControlGraphNodeKind = "agent" | "gate" | "provider" | "credential";
export type ControlGraphEdgeKind = "identity" | "approval" | "dispatch" | "scope" | "elevation" | "fallback";
export type ControlGraphEventStop = "gate" | "credential" | "provider" | "receipt";
export type ControlGraphEventTone = "allowed" | "blocked" | "warning";
export type PresentationIdentityMode = "anonymous" | "named";

export interface PresentationOutcome {
  label: string;
  tone: ControlGraphEventTone;
  stop: ControlGraphEventStop;
}

export interface ControlGraphAgentRow {
  id: string;
  name: string;
  passport_pubkey?: string | null;
  status: string;
  allowed_scopes: unknown;
  budget_tokens?: number | null;
  budget_cents?: number | null;
  spent_tokens?: number | null;
  spent_microcents?: number | null;
  policy?: unknown;
  fallbacks?: unknown;
}

export interface ControlGraphGrantRow {
  id: string;
  agent_id: string;
  scopes: unknown;
  expires_at: string;
  revoked_at?: string | null;
}

export interface ControlGraphNode {
  id: string;
  kind: ControlGraphNodeKind;
  label: string;
  state: "active" | "suspended" | "revoked" | "ready" | "missing" | "armed" | "unknown";
  agentId?: string;
  provider?: string;
}

export interface ControlGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: ControlGraphEdgeKind;
  agentId?: string;
  provider?: string;
  models?: string[];
  expiresAt?: string;
  order?: number;
}

export interface ControlGraphAgentDetail {
  id: string;
  name: string;
  status: string;
  passportSuffix: string | null;
  scopes: ScopeRow[];
  budgetTokens: number | null;
  budgetCents: number | null;
  spentTokens: number;
  spentMicrocents: number;
  policyEnabled: boolean;
  elevationExpiresAt: string | null;
  emergencyBlocked: boolean;
}

export interface ControlGraphEvent {
  id: string;
  row: DepartureRow;
  agentNodeId: string;
  providerNodeId: string | null;
  stop: ControlGraphEventStop;
  tone: ControlGraphEventTone;
  label: string;
  receiptRecorded: boolean;
}

export interface ControlGraphSnapshot {
  nodes: ControlGraphNode[];
  edges: ControlGraphEdge[];
  agents: Record<string, ControlGraphAgentDetail>;
  events: ControlGraphEvent[];
  killArmed: boolean;
  emergencyBlockedCount: number;
}

const EVENT_ROUTE: Record<
  LogEntry["status"],
  { stop: ControlGraphEventStop; tone: ControlGraphEventTone; label: string }
> = {
  ok: { stop: "receipt", tone: "allowed", label: "Allowed and forwarded" },
  upstream_error: { stop: "provider", tone: "warning", label: "Provider error" },
  provider_exhausted: { stop: "provider", tone: "warning", label: "Provider credit exhausted" },
  no_provider_key: { stop: "credential", tone: "warning", label: "No provider key stored" },
  blocked_scope: { stop: "gate", tone: "blocked", label: "Blocked by visa scope" },
  blocked_policy: { stop: "gate", tone: "blocked", label: "Blocked by live policy" },
  blocked_budget: { stop: "gate", tone: "blocked", label: "Blocked by PassControl budget" },
  blocked_killed: { stop: "gate", tone: "blocked", label: "Blocked by kill switch" },
  blocked_suspended: { stop: "gate", tone: "blocked", label: "Blocked by suspension" },
  blocked_endpoint: { stop: "gate", tone: "blocked", label: "Blocked endpoint" },
};

export function routeForStoredStatus(status: string | null): {
  stop: ControlGraphEventStop;
  tone: ControlGraphEventTone;
  label: string;
} {
  return EVENT_ROUTE[status as LogEntry["status"]] ?? {
    stop: "gate",
    tone: "warning",
    label: status ? `Unknown status: ${status}` : "Unknown status",
  };
}

const PRESENTATION_OUTCOMES: Record<LogEntry["status"], string> = {
  ok: "CLEARED",
  blocked_scope: "NO VISA",
  blocked_budget: "NO FUNDS",
  blocked_suspended: "SUSPENDED",
  blocked_killed: "KILL SWITCH",
  blocked_policy: "POLICY",
  blocked_endpoint: "ENDPOINT",
  no_provider_key: "NO KEY",
  upstream_error: "PROVIDER ERROR",
  provider_exhausted: "PROVIDER CREDIT",
};

export function presentationOutcomeForStatus(status: string | null): PresentationOutcome {
  const route = routeForStoredStatus(status);
  return {
    label: PRESENTATION_OUTCOMES[status as LogEntry["status"]] ?? "UNRECOGNIZED",
    tone: route.tone,
    stop: route.stop,
  };
}

export function appendPresentationEventQueue<T>(current: readonly T[], incoming: T, limit = 12): T[] {
  return [...current, incoming].slice(-Math.max(1, limit));
}

function providerNodeId(provider: string) {
  return `provider:${provider}`;
}

function agentNodeId(agentId: string) {
  return `agent:${agentId}`;
}

function isNonEmptyObject(value: unknown) {
  return Boolean(value && typeof value === "object" && Object.keys(value as object).length > 0);
}

function fallbackRows(value: unknown): Array<{ provider: string; model: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as { provider?: unknown; model?: unknown };
    return typeof row.provider === "string" && typeof row.model === "string"
      ? [{ provider: row.provider, model: row.model }]
      : [];
  });
}

export function eventFromStoredRow(row: DepartureRow): ControlGraphEvent {
  const route = routeForStoredStatus(row.status);
  return {
    id: row.id,
    row,
    agentNodeId: row.agent_id ? agentNodeId(row.agent_id) : "agent:historical",
    providerNodeId: row.provider ? providerNodeId(row.provider) : null,
    ...route,
    receiptRecorded: route.stop === "receipt" && Boolean(row.receipt),
  };
}

export function buildControlGraph(input: {
  agents: ControlGraphAgentRow[];
  providerCredentials: string[];
  grants: ControlGraphGrantRow[];
  logs: DepartureRow[];
  killArmed: boolean;
  denylistedAgentIds?: string[];
  now?: Date;
}): ControlGraphSnapshot {
  const now = input.now ?? new Date();
  const configured = new Set(input.providerCredentials);
  const denylisted = new Set(input.denylistedAgentIds ?? []);
  const providerNames = new Set(configured);
  input.logs.forEach((row) => {
    if (row.provider) providerNames.add(row.provider);
  });
  const nodes: ControlGraphNode[] = [
    {
      id: "gate:passcontrol",
      kind: "gate",
      label: "PassControl",
      state: input.killArmed ? "armed" : "ready",
    },
    {
      id: "credential:vault",
      kind: "credential",
      label: "Credential boundary",
      state: "ready",
    },
  ];
  const edges: ControlGraphEdge[] = [];
  const details: Record<string, ControlGraphAgentDetail> = {};
  const activeGrants = new Map(
    input.grants
      .filter((grant) => !grant.revoked_at && Date.parse(grant.expires_at) > now.getTime())
      .map((grant) => [grant.agent_id, grant])
  );

  for (const agent of input.agents) {
    const scopes = toScopeRows(agent.allowed_scopes);
    const grant = activeGrants.get(agent.id);
    const elevatedScopes = grant ? toScopeRows(grant.scopes) : [];
    const agentId = agentNodeId(agent.id);
    nodes.push({
      id: agentId,
      kind: "agent",
      label: agent.name,
      agentId: agent.id,
      state: denylisted.has(agent.id)
        ? "armed"
        : agent.status === "suspended"
          ? "suspended"
          : agent.status === "revoked"
            ? "revoked"
            : "active",
    });
    edges.push({ id: `${agentId}:identity`, source: agentId, target: "gate:passcontrol", kind: "identity", agentId: agent.id });

    const byProvider = new Map<string, Set<string>>();
    for (const scope of scopes) {
      providerNames.add(scope.provider);
      const models = byProvider.get(scope.provider) ?? new Set<string>();
      scope.models.forEach((model) => models.add(model));
      byProvider.set(scope.provider, models);
    }
    for (const [provider, models] of byProvider) {
      edges.push({
        id: `${agentId}:scope:${provider}`,
        source: agentId,
        target: providerNodeId(provider),
        kind: "scope",
        agentId: agent.id,
        provider,
        models: [...models],
      });
    }
    for (const scope of elevatedScopes) {
      providerNames.add(scope.provider);
      edges.push({
        id: `${agentId}:elevation:${scope.provider}`,
        source: agentId,
        target: providerNodeId(scope.provider),
        kind: "elevation",
        agentId: agent.id,
        provider: scope.provider,
        models: [...new Set(scope.models)],
        expiresAt: grant?.expires_at,
      });
    }
    fallbackRows(agent.fallbacks).forEach((fallback, order) => {
      providerNames.add(fallback.provider);
      edges.push({
        id: `${agentId}:fallback:${order}:${fallback.provider}`,
        source: agentId,
        target: providerNodeId(fallback.provider),
        kind: "fallback",
        agentId: agent.id,
        provider: fallback.provider,
        models: [fallback.model],
        order: order + 1,
      });
    });
    details[agent.id] = {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      passportSuffix: agent.passport_pubkey ? agent.passport_pubkey.slice(-16) : null,
      scopes,
      budgetTokens: agent.budget_tokens ?? null,
      budgetCents: agent.budget_cents ?? null,
      spentTokens: agent.spent_tokens ?? 0,
      spentMicrocents: agent.spent_microcents ?? 0,
      policyEnabled: isNonEmptyObject(agent.policy),
      elevationExpiresAt: grant?.expires_at ?? null,
      emergencyBlocked: denylisted.has(agent.id),
    };
  }

  for (const provider of [...providerNames].sort()) {
    nodes.push({
      id: providerNodeId(provider),
      kind: "provider",
      label: provider,
      provider,
      state: configured.has(provider) ? "ready" : "missing",
    });
    edges.push({
      id: `credential:dispatch:${provider}`,
      source: "credential:vault",
      target: providerNodeId(provider),
      kind: "dispatch",
      provider,
    });
  }
  if (input.logs.some((row) => !row.agent_id || !details[row.agent_id])) {
    nodes.push({
      id: "agent:historical",
      kind: "agent",
      label: "Historical identity",
      state: "revoked",
    });
    edges.push({
      id: "agent:historical:identity",
      source: "agent:historical",
      target: "gate:passcontrol",
      kind: "identity",
    });
  }
  edges.push({
    id: "gate:credential",
    source: "gate:passcontrol",
    target: "credential:vault",
    kind: "approval",
  });

  return {
    nodes,
    edges,
    agents: details,
    events: input.logs.map((row) => {
      const event = eventFromStoredRow(row);
      return row.agent_id && !details[row.agent_id]
        ? { ...event, agentNodeId: "agent:historical" }
        : event;
    }),
    killArmed: input.killArmed,
    emergencyBlockedCount: input.agents.filter((agent) => denylisted.has(agent.id)).length,
  };
}

export function mergeRealtimeStoredEvent(
  snapshot: ControlGraphSnapshot,
  row: DepartureRow,
  limit = 40
): ControlGraphSnapshot {
  const event = eventFromStoredRow(row);
  const nodes = [...snapshot.nodes];
  const edges = [...snapshot.edges];
  const agents = { ...snapshot.agents };

  if (row.agent_id && !agents[row.agent_id]) {
    const id = agentNodeId(row.agent_id);
    nodes.push({
      id,
      kind: "agent",
      label: "Identity outside loaded topology",
      agentId: row.agent_id,
      state: "unknown",
    });
    edges.push({
      id: `${id}:identity`,
      source: id,
      target: "gate:passcontrol",
      kind: "identity",
      agentId: row.agent_id,
    });
    agents[row.agent_id] = {
      id: row.agent_id,
      name: "Identity outside loaded topology",
      status: "Topology not loaded",
      passportSuffix: null,
      scopes: [],
      budgetTokens: null,
      budgetCents: null,
      spentTokens: 0,
      spentMicrocents: 0,
      policyEnabled: false,
      elevationExpiresAt: null,
      emergencyBlocked: false,
    };
  } else if (!row.agent_id && !nodes.some((node) => node.id === "agent:historical")) {
    nodes.push({
      id: "agent:historical",
      kind: "agent",
      label: "Historical identity",
      state: "revoked",
    });
    edges.push({
      id: "agent:historical:identity",
      source: "agent:historical",
      target: "gate:passcontrol",
      kind: "identity",
    });
  }

  if (row.provider && !nodes.some((node) => node.id === providerNodeId(row.provider!))) {
    nodes.push({
      id: providerNodeId(row.provider),
      kind: "provider",
      label: row.provider,
      provider: row.provider,
      state: "unknown",
    });
    edges.push({
      id: `credential:dispatch:${row.provider}`,
      source: "credential:vault",
      target: providerNodeId(row.provider),
      kind: "dispatch",
      provider: row.provider,
    });
  }

  return {
    ...snapshot,
    nodes,
    edges,
    agents,
    events: [event, ...snapshot.events].slice(0, Math.max(1, limit)),
  };
}

export function presentationSnapshot(
  snapshot: ControlGraphSnapshot,
  identityMode: PresentationIdentityMode = "anonymous"
): ControlGraphSnapshot {
  const alias = new Map(
    Object.values(snapshot.agents)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((agent, index) => [agent.id, `Agent ${String(index + 1).padStart(2, "0")}`])
  );
  const safeId = new Map(
    [...alias.keys()].map((agentId, index) => [agentId, `anon-${index + 1}`])
  );
  const nodeId = (id: string) => {
    if (!id.startsWith("agent:")) return id;
    const raw = id.slice("agent:".length);
    return raw === "historical" ? id : `agent:${safeId.get(raw) ?? "anonymous"}`;
  };
  const agents = Object.fromEntries(
    Object.values(snapshot.agents).map((agent) => [
      safeId.get(agent.id) ?? "anonymous",
      {
        ...agent,
        id: safeId.get(agent.id) ?? "anonymous",
        name: identityMode === "named" ? agent.name : alias.get(agent.id) ?? "Agent",
        passportSuffix: null,
        budgetTokens: null,
        budgetCents: null,
        spentTokens: 0,
        spentMicrocents: 0,
        elevationExpiresAt: null,
      },
    ])
  );
  const events = snapshot.events.map((event, index) => ({
    ...event,
    id: `event-${index + 1}`,
    agentNodeId: nodeId(event.agentNodeId),
    row: {
      ...event.row,
      id: `event-${index + 1}`,
      agent_id: event.row.agent_id ? safeId.get(event.row.agent_id) ?? null : null,
      user_id: null,
      passport_id: null,
      jti: null,
      agent_access_key_id: null,
      credential_use_id: null,
      input_tokens: null,
      output_tokens: null,
      cost_microcents: null,
      latency_ms: null,
      created_at: null,
      receipt: null,
      policy_shadow_would: null,
    },
  }));
  return {
    ...snapshot,
    agents,
    events,
    nodes: snapshot.nodes.map((node) =>
      node.agentId
        ? {
            ...node,
            id: nodeId(node.id),
            agentId: safeId.get(node.agentId) ?? "anonymous",
            label: identityMode === "named"
              ? snapshot.agents[node.agentId]?.name ?? "Agent"
              : alias.get(node.agentId) ?? "Agent",
          }
        : { ...node, id: nodeId(node.id) }
    ),
    edges: snapshot.edges.map((edge, index) => ({
      ...edge,
      id: `edge-${index + 1}`,
      source: nodeId(edge.source),
      target: nodeId(edge.target),
      agentId: edge.agentId ? safeId.get(edge.agentId) ?? "anonymous" : undefined,
      expiresAt: undefined,
    })),
  };
}
