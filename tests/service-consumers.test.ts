// Where a service call's row lands (plans/any-api-credentials.md §5, §7).
//
// None of these is a leak — no reader returns a secret. They are silent
// misreadings, and the sharpest one was concrete: a successful GitHub call is
// `ok` with no model, which is exactly the shape the classifier files as an
// SDK model-listing probe and HIDES by default. Every governed GitHub read
// would have vanished from the Departures board.
import { describe, expect, it } from "vitest";
import { classifyCall, isHousekeeping, isInference, partitionByClass } from "@/lib/call-class";
import {
  departureCounts,
  departureDestination,
  departureProvider,
  groupDepartures,
  groupUpstreamStatus,
  recordedUpstreamStatus,
  visibleDepartures,
  type DepartureRow,
} from "@/lib/departures";
import { buildControlGraph, mergeRealtimeStoredEvent } from "@/lib/control-graph";
import { llmCredentialProviders } from "@/lib/providers/available";
import { serviceCallExplanation, serviceLabelFor, serviceUpstreamMeaning } from "@/lib/services/presentation";
import { nextActionsFor } from "@/components/dashboard/CallDetailDrawer";
import { deriveFirstCallActivation } from "@/lib/first-call-activation";

function row(overrides: Partial<DepartureRow> = {}): DepartureRow {
  return {
    id: "row-1",
    agent_id: "agent-1",
    created_at: "2026-09-29T09:07:03.000Z",
    passport_id: "passport-1",
    jti: "jti-1",
    provider: "svc:github",
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_microcents: null,
    status: "ok",
    call_kind: "service",
    endpoint: "GET /repos/acme/*/issues",
    ...overrides,
  };
}

describe("classifying a service call", () => {
  it("is its own class, never a hidden housekeeping probe", () => {
    expect(classifyCall(row())).toEqual({ klass: "service", reason: null });
    expect(isHousekeeping(row())).toBe(false);
  });

  it("is recognised from the provider alone, for a realtime payload without call_kind", () => {
    const { call_kind: _omit, endpoint: _e, ...partial } = row();
    expect(classifyCall(partial)).toEqual({ klass: "service", reason: null });
  });

  it("is recognised from call_kind alone", () => {
    expect(classifyCall(row({ provider: null })).klass).toBe("service");
  });

  it("stays a service call when refused", () => {
    expect(classifyCall(row({ status: "blocked_scope", endpoint: null })).klass).toBe("service");
  });

  it("is not inference: it spent no model tokens and has no model cost", () => {
    expect(isInference(row())).toBe(false);
  });

  it("gets its own side of the partition: neither a model call nor a probe", () => {
    const probe = row({ id: "probe", provider: "openai", call_kind: null, endpoint: null, model: "" });
    const chat = row({ id: "chat", provider: "openai", call_kind: null, endpoint: null, model: "gpt-4.1-mini" });
    const { inference, housekeeping, service } = partitionByClass([row(), probe, chat]);
    expect(service.map((r) => r.id)).toEqual(["row-1"]);
    expect(inference.map((r) => r.id)).toEqual(["chat"]);
    expect(housekeeping.map((r) => r.id)).toEqual(["probe"]);
  });

  it("leaves an LLM model-listing probe exactly as it was", () => {
    expect(classifyCall({ status: "ok", model: "", provider: "openai" }).klass).toBe("housekeeping");
  });
});

describe("the Departures board", () => {
  const view = { filter: "all" as const, query: "", showHousekeeping: false };

  it("shows a service call with housekeeping hidden, and counts it as cleared", () => {
    expect(visibleDepartures([row()], view)).toHaveLength(1);
    expect(departureCounts([row()])).toMatchObject({ cleared: 1, housekeeping: 0 });
  });

  it("names the rule that admitted it where an LLM call names its model", () => {
    expect(departureDestination(row())).toBe("GET /repos/acme/*/issues");
  });

  it("names the service as an operator knows it, not by its stored id", () => {
    expect(departureProvider(row())).toBe("GitHub");
    expect(departureProvider(row({ provider: "anthropic", call_kind: null }))).toBe("anthropic");
    expect(departureProvider(row({ provider: null, call_kind: null }))).toBeNull();
  });

  it("says a refused call matched no rule, rather than showing nothing", () => {
    expect(departureDestination(row({ status: "blocked_scope", endpoint: null }))).toBe("no matching rule");
  });

  it("finds a call by its endpoint", () => {
    expect(visibleDepartures([row()], { ...view, query: "/repos/acme" })).toHaveLength(1);
  });

  it("does not collapse refusals of two different paths into one burst", () => {
    const a = row({ id: "a", status: "blocked_policy", endpoint: "GET /repos/acme/*/issues" });
    const b = row({ id: "b", status: "blocked_policy", endpoint: "GET /user", created_at: "2026-09-29T09:07:04.000Z" });
    expect(groupDepartures([a, b])).toHaveLength(2);
  });
});

describe("the Control Graph", () => {
  it("does not draw a service token or a service call as an LLM provider", () => {
    const snapshot = buildControlGraph({
      agents: [],
      providerCredentials: ["anthropic", "svc:github"],
      grants: [],
      logs: [row()],
      killArmed: false,
    });
    const providers = snapshot.nodes.filter((node) => node.kind === "provider").map((node) => node.label);
    expect(providers).toEqual(["anthropic"]);

    const merged = mergeRealtimeStoredEvent(snapshot, row({ id: "live-1" }));
    expect(merged.nodes.filter((node) => node.kind === "provider").map((node) => node.label)).toEqual([
      "anthropic",
    ]);
  });
});

describe("which stored credentials are LLM provider keys", () => {
  it("drops service tokens and anything else that is not a provider", () => {
    expect(
      llmCredentialProviders([
        { provider: "openai" },
        { provider: "svc:github" },
        { provider: "anthropic" },
        { provider: "openai" },
        { provider: null },
        { provider: "svc" },
      ])
    ).toEqual(["openai", "anthropic"]);
  });
});

describe("explaining a service call in the call drawer", () => {
  it("names the service from its stored provider id", () => {
    expect(serviceLabelFor("svc:github")).toBe("GitHub");
    expect(serviceLabelFor("svc:unknown")).toBe("svc:unknown");
  });

  it.each([
    ["ok", /outside the agent's dollar limit/],
    ["blocked_scope", /deny.by.default/i],
    ["blocked_policy", /hourly/],
    ["blocked_endpoint", /GraphQL/],
    ["no_provider_key", /Settings, under Services/],
    ["endpoint_unavailable", /could not read/],
    ["upstream_error", /answered with an error/],
  ])("says what %s means for a GitHub call, not for a model call", (status, pattern) => {
    const text = serviceCallExplanation(status, "svc:github");
    expect(text).toMatch(pattern);
    expect(text).not.toMatch(/\bmodel\b/);
  });

  it("has nothing to add for a status every call shares", () => {
    expect(serviceCallExplanation("blocked_killed", "svc:github")).toBeNull();
    expect(serviceCallExplanation("blocked_suspended", "svc:github")).toBeNull();
  });

  it("sends a refused service call to the agent's service access, and a missing token to Services", () => {
    const scope = nextActionsFor(row({ status: "blocked_scope", endpoint: null }), null);
    expect(scope.map((a) => a.href)).toContain("/dashboard/agents/agent-1#agent-services");
    // Each service's own section on the agent page, GitHub's original anchor kept.
    const brave = nextActionsFor(row({ status: "blocked_scope", endpoint: null, provider: "svc:brave" }), null);
    expect(brave.map((a) => a.href)).toContain("/dashboard/agents/agent-1#agent-services-brave");
    const missing = nextActionsFor(row({ status: "no_provider_key" }), null);
    expect(missing.map((a) => a.href)).toContain("/dashboard/settings#services");
    expect(missing.map((a) => a.href)).not.toContain("/dashboard/settings#provider-credentials");
  });
});

// Found in the browser, not by the suite: the Overview's first-call guide read
// a refused GitHub call as "Model outside this agent's scope". The guide is
// about a first MODEL call; an allowed GitHub read would have completed its
// "governed call" step without one inference having run.
describe("the first-call guide", () => {
  const agents = [{ id: "agent-1", name: "Scout", status: "active" }];
  const guide = (logs: DepartureRow[]) =>
    deriveFirstCallActivation({ providerConfigured: true, refusalTest: null, agents, logs: logs as never });

  it("is not completed by an allowed GitHub call", () => {
    expect(guide([row({ status: "ok", receipt: "r" } as never)])).toMatchObject({ stage: "call", connected: false });
  });

  it("does not diagnose a refused GitHub call as a model outside scope", () => {
    expect(guide([row({ status: "blocked_scope", endpoint: null })])).toMatchObject({ stage: "call" });
  });

  it("still diagnoses the model call underneath a newer GitHub call", () => {
    const refusedModel = row({ id: "llm", provider: "openai", call_kind: null, endpoint: null, model: "gpt-5", status: "blocked_scope" });
    expect(guide([row({ id: "gh", created_at: "2026-09-29T10:00:00.000Z" }), refusedModel])).toMatchObject({
      stage: "diagnose",
      row: { id: "llm" },
    });
  });
});

// Also found in the browser: the drawer said a GitHub 401 meant "the provider
// rejected the stored provider key", and a 404 "a model id the provider does not
// publish". GitHub answers 404 for a private repository the token cannot see.
describe("what GitHub's own status means", () => {
  it("speaks of the GitHub token, never a provider key or a model", () => {
    for (const status of [401, 403, 404, 429, 502]) {
      const text = serviceUpstreamMeaning(status, "svc:github")!;
      expect(text).toContain("GitHub");
      expect(text).not.toMatch(/provider key|model/i);
    }
    expect(serviceUpstreamMeaning(401, "svc:github")).toMatch(/token/);
    expect(serviceUpstreamMeaning(404, "svc:github")).toMatch(/cannot see/);
  });

  it("has nothing to add for a status it cannot explain", () => {
    expect(serviceUpstreamMeaning(418, "svc:github")).toBeNull();
  });
});

// Found in the browser: a call PassControl refused read "Provider answered HTTP
// 403. GitHub refused this request" — GitHub never saw it. `res.http` on a
// receipt is the status PassControl RETURNED, which is the provider's only when
// the call was forwarded. It predates any-API: an LLM budget refusal read
// "Provider answered HTTP 402".
describe("the provider's status, as the drawer and board report it", () => {
  const receipt = (res: { status: string; http: number }) =>
    `e30.${Buffer.from(JSON.stringify({ res })).toString("base64url")}.sig`;

  it("is the recorded status when the call was forwarded", () => {
    const sent = row({ status: "upstream_error", receipt: receipt({ status: "upstream_error", http: 401 }) } as never);
    expect(recordedUpstreamStatus(sent)).toBe(401);
  });

  it("is nothing when PassControl refused the call itself", () => {
    const refused = row({ status: "blocked_scope", receipt: receipt({ status: "blocked_scope", http: 403 }) } as never);
    const budget = row({
      provider: "anthropic",
      call_kind: null,
      endpoint: null,
      model: "claude-haiku-4-5",
      status: "blocked_budget_period",
      receipt: receipt({ status: "blocked_budget_period", http: 402 }),
    } as never);
    expect(recordedUpstreamStatus(refused)).toBeNull();
    expect(recordedUpstreamStatus(budget)).toBeNull();
    expect(groupUpstreamStatus(groupDepartures([refused])[0]!)).toBeNull();
  });
});

describe("service status wording per service", () => {
  it("explains a 404 the GitHub way only for GitHub", async () => {
    const { serviceUpstreamMeaning } = await import("@/lib/services/presentation");
    expect(serviceUpstreamMeaning(404, "svc:github")).toMatch(/404, not 403/);
    expect(serviceUpstreamMeaning(404, "svc:telegram")).toBe("Telegram has no such method or resource.");
  });
});
