// Package 2, step 5: Azure OpenAI through its v1 OpenAI-compatible API.
//
// Facts pinned here come from learn.microsoft.com/en-us/azure/foundry/openai/
// api-version-lifecycle (updated 2026-06-05, read 2026-09-27; plan §4a):
//   * base `https://<resource>.openai.azure.com/openai/v1/`, and `base_url`
//     "accepts both …openai.azure.com/openai/v1/ and …services.ai.azure.com/openai/v1/";
//   * "api-version is no longer a required parameter with the v1 GA API";
//   * key auth is an `api-key` header; `model` is the DEPLOYMENT name.
//
// What makes Azure different from every other provider is that it has NO host of
// ours: each customer's resource is its own. So the credential's address is part
// of the credential, validated by an Azure-only rule that admits Microsoft-owned
// suffixes in every PROVIDER_ENDPOINT_MODE (owner decision P2-2) — and a key with
// no address is refused, never sent to a guessed host.
import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  authHeaders,
  isProvider,
  modelListingUrl,
  providerRequiresEndpoint,
  requestShapeFamily,
  upstreamBaseUrl,
  usesOpenAiUsageShape,
} from "@/lib/providers";
import {
  azureEndpointSuggestion,
  isEndpointAllowedFor,
  joinUpstream,
  normalizeEndpointFor,
  versionlessUpstreamPath,
  type EndpointPolicy,
} from "@/lib/providers/endpoint";
import { costMicrocents, hasListedPrice, isPricedEndpoint } from "@/lib/pricing";
import { advertisedClientPath, canonicalEndpointPath, endpointAllows, isResponsesEndpoint } from "@/lib/scope";
import { outputLimitShape } from "@/lib/output-limit";
import { evaluateGate } from "@/lib/gate";
import { serverSideToolUse } from "@/lib/providers/server-side-tools";
import { usageFromJson } from "@/lib/usage/parseStream";
import { classifyUpstreamFailure } from "@/lib/providers/exhaustion";
// @ts-expect-error — plain .mjs CLI module, no types
import { providerForHost, classifyConnect, classifyProxyRequest } from "@/cli/proxy-policy.mjs";

const OFF: EndpointPolicy = { kind: "off" };
const SELFHOST: EndpointPolicy = { kind: "selfhost" };
const ALLOWLIST: EndpointPolicy = { kind: "allowlist", hosts: ["gateway.company.com"] };
const POLICIES = [OFF, SELFHOST, ALLOWLIST];
const RESOURCE = "https://contoso-ai.openai.azure.com/openai/v1";

describe("azure is a registered provider with no host of its own", () => {
  it("is in PROVIDERS and passes the runtime guard", () => {
    expect(PROVIDERS).toContain("azure");
    expect(isProvider("azure")).toBe(true);
  });

  it("has no built-in upstream: there is nowhere to send a key without its address", () => {
    expect(upstreamBaseUrl("azure")).toBeNull();
    expect(modelListingUrl("azure")).toBeNull();
    expect(providerRequiresEndpoint("azure")).toBe(true);
  });

  it("every other provider keeps its fixed host and needs no endpoint", () => {
    // `local` is the other provider with no host of ours (tests/local-provider.test.ts).
    for (const provider of PROVIDERS.filter((p) => p !== "azure" && p !== "local")) {
      expect(upstreamBaseUrl(provider)).toMatch(/^https:\/\//);
      expect(providerRequiresEndpoint(provider)).toBe(false);
    }
  });

  it("authenticates with an api-key header, never a bearer token", () => {
    expect(authHeaders("azure", "az-key")).toEqual({ "api-key": "az-key" });
  });

  it("speaks OpenAI's request and usage shapes", () => {
    expect(requestShapeFamily("azure")).toBe("openai");
    expect(usesOpenAiUsageShape("azure")).toBe(true);
  });
});

describe("the Azure resource address rule", () => {
  it.each(POLICIES)("admits a resource's v1 base in every mode (%o)", (policy) => {
    expect(isEndpointAllowedFor("azure", RESOURCE, policy)).toBe(true);
    expect(isEndpointAllowedFor("azure", "https://contoso.services.ai.azure.com/openai/v1", policy)).toBe(true);
    expect(isEndpointAllowedFor("azure", "https://contoso.openai.azure.com:443/openai/v1/", policy)).toBe(true);
  });

  it("stores one canonical spelling", () => {
    expect(normalizeEndpointFor("azure", "https://Contoso-AI.OpenAI.Azure.com/openai/v1/", OFF)).toBe(RESOURCE);
    expect(normalizeEndpointFor("azure", "https://contoso-ai.openai.azure.com:443/openai/v1", OFF)).toBe(RESOURCE);
  });

  it.each([
    ["plain http", "http://contoso.openai.azure.com/openai/v1"],
    ["another port", "https://contoso.openai.azure.com:8443/openai/v1"],
    ["userinfo", "https://u:p@contoso.openai.azure.com/openai/v1"],
    ["a query", "https://contoso.openai.azure.com/openai/v1?api-version=preview"],
    ["a fragment", "https://contoso.openai.azure.com/openai/v1#x"],
    ["a lookalike suffix", "https://contoso.openai.azure.com.evil.example/openai/v1"],
    ["a hyphenated lookalike", "https://contoso-openai.azure.com.example/openai/v1"],
    ["the bare suffix", "https://openai.azure.com/openai/v1"],
    ["two labels", "https://a.contoso.openai.azure.com/openai/v1"],
    ["an unnamed suffix", "https://contoso.cognitiveservices.azure.com/openai/v1"],
    ["a label starting with a hyphen", "https://-contoso.openai.azure.com/openai/v1"],
    ["a label ending with a hyphen", "https://contoso-.openai.azure.com/openai/v1"],
    ["an IP literal", "https://10.0.0.5/openai/v1"],
    ["no path", "https://contoso.openai.azure.com"],
    ["the legacy /openai path", "https://contoso.openai.azure.com/openai"],
    ["a deeper path", "https://contoso.openai.azure.com/openai/v1/chat"],
    ["a traversal", "https://contoso.openai.azure.com/openai/v1/../../x"],
    ["an encoded traversal", "https://contoso.openai.azure.com/openai/%2e%2e/v1"],
    ["a backslash", "https://contoso.openai.azure.com/openai\\v1"],
    ["an unrelated host", "https://api.openai.com/v1"],
  ])("refuses %s in every mode", (_label, value) => {
    for (const policy of POLICIES) {
      expect(isEndpointAllowedFor("azure", value, policy)).toBe(false);
      expect(normalizeEndpointFor("azure", value, policy)).toBeNull();
    }
  });

  it("an Azure key goes only to Azure, even where self-host admits any address", () => {
    expect(isEndpointAllowedFor("azure", "http://10.1.2.3:8000/v1", SELFHOST)).toBe(false);
    expect(isEndpointAllowedFor("azure", "https://gateway.company.com/openai/v1", ALLOWLIST)).toBe(false);
  });

  it("does not widen what any other provider may be pointed at", () => {
    expect(isEndpointAllowedFor("openai", RESOURCE, OFF)).toBe(false);
    expect(isEndpointAllowedFor("openai", "http://10.1.2.3:8000/v1", SELFHOST)).toBe(true);
    expect(isEndpointAllowedFor("openai", "https://gateway.company.com/v1", ALLOWLIST)).toBe(true);
  });

  it("names the exact address to use when given the portal's bare endpoint", () => {
    // The Azure portal shows `https://<name>.openai.azure.com/`. That is refused
    // rather than silently rewritten, and the refusal says what to type.
    expect(azureEndpointSuggestion("https://contoso-ai.openai.azure.com/")).toBe(RESOURCE);
    expect(azureEndpointSuggestion("https://contoso-ai.openai.azure.com/openai")).toBe(RESOURCE);
    expect(azureEndpointSuggestion("https://evil.example/")).toBeNull();
    expect(azureEndpointSuggestion(RESOURCE)).toBeNull();
  });

  it("joins the canonical path under the resource's own /openai/v1", () => {
    const path = canonicalEndpointPath("azure", "POST", ["chat", "completions"]);
    expect(path).not.toBeNull();
    expect(joinUpstream(RESOURCE, versionlessUpstreamPath(path!))).toBe(
      "https://contoso-ai.openai.azure.com/openai/v1/chat/completions"
    );
  });
});

describe("azure endpoints", () => {
  it.each([
    ["POST", ["chat", "completions"], ["v1", "chat", "completions"]],
    ["POST", ["v1", "chat", "completions"], ["v1", "chat", "completions"]],
    ["POST", ["responses"], ["v1", "responses"]],
    ["POST", ["v1", "responses"], ["v1", "responses"]],
    ["POST", ["embeddings"], ["v1", "embeddings"]],
    ["POST", ["v1", "embeddings"], ["v1", "embeddings"]],
    ["GET", ["models"], ["v1", "models"]],
    ["GET", ["v1", "models"], ["v1", "models"]],
  ] as const)("serves %s /%s", (method, path, upstream) => {
    expect(canonicalEndpointPath("azure", method, path)).toEqual(upstream);
  });

  it.each([
    ["POST", ["v1", "files"]],
    ["POST", ["v1", "fine_tuning", "jobs"]],
    ["POST", ["openai", "deployments", "x", "chat", "completions"]],
    ["GET", ["v1", "responses", "resp_1"]],
  ] as const)("refuses %s /%s", (method, path) => {
    expect(endpointAllows("azure", method, path)).toBe(false);
  });
});

describe("azure Responses is read as Responses, not as chat", () => {
  // Found by the advertised-path test, not by the first draft of this file: with
  // Responses unrecognised, a Responses call settled through the CHAT usage
  // parser, found no usage, and charged every call its estimate.
  it("recognises the Responses endpoint", () => {
    expect(isResponsesEndpoint("azure", ["v1", "responses"])).toBe(true);
    expect(isResponsesEndpoint("azure", ["v1", "chat", "completions"])).toBe(false);
  });

  it("settles Responses usage from input_tokens / output_tokens", () => {
    const usage = usageFromJson(
      "azure",
      { usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 } },
      "responses"
    );
    expect(usage.inputTokens).toBe(20);
    expect(usage.outputTokens).toBe(7);
  });

  it("reads an output ceiling from max_output_tokens on Responses", () => {
    expect(outputLimitShape("azure", ["v1", "responses"])).toBe("openai_responses");
    expect(outputLimitShape("azure", ["v1", "chat", "completions"])).toBe("chat_completions");
  });

  it("advertises chat completions, not Responses, as the chat base", () => {
    expect(advertisedClientPath("azure", "chat")).toEqual(["chat", "completions"]);
    expect(advertisedClientPath("azure", "responses")).toEqual(["responses"]);
  });
});

describe("azure is never priced", () => {
  it("has no price rows: a deployment name says nothing about the model behind it", () => {
    expect(hasListedPrice("gpt-4o-mini", "azure")).toBe(false);
    expect(isPricedEndpoint(RESOURCE)).toBe(false);
    expect(costMicrocents("gpt-4o-mini", 1000, 1000, "azure", RESOURCE)).toBe(0);
  });

  const gateInput = (dollarLimited: boolean, path: string[] = ["chat", "completions"], method = "POST") => ({
    agentId: "agent",
    killState: { platformKill: false, tenantKill: false, denylist: [] },
    suspended: false,
    scopes: [{ provider: "azure", models: ["gpt-*"] }],
    provider: "azure",
    method,
    path,
    model: method === "GET" ? "" : "gpt-4o-mini",
    now: new Date("2026-09-29T12:00:00Z"),
    requestedOutput: null,
    dollarLimited,
  });

  it("under a dollar limit is refused as an unpriced endpoint, before any hold", () => {
    const gate = evaluateGate(gateInput(true) as never);
    expect(gate.deniedBy).toBe("endpoint");
    const step = gate.steps.find((s) => s.name === "endpoint");
    expect(step?.rule).toBe("endpoint:unpriced_endpoint");
    expect(step?.httpStatus).toBe(402);
  });

  it("without a dollar limit passes the endpoint step", () => {
    const gate = evaluateGate(gateInput(false) as never);
    expect(gate.deniedBy).toBeFalsy();
    expect(gate.steps.find((s) => s.name === "endpoint")?.status).toBe("pass");
  });
});

describe("azure hosted tools are refused like OpenAI's", () => {
  it("refuses a hosted tool and a stored prompt", () => {
    expect(serverSideToolUse("azure", { tools: [{ type: "web_search_preview" }] })).not.toBeNull();
    expect(serverSideToolUse("azure", { tools: [{ type: "code_interpreter" }] })).not.toBeNull();
    expect(serverSideToolUse("azure", { tools: [{ type: "mcp", server_url: "https://x" }] })).not.toBeNull();
    expect(serverSideToolUse("azure", { prompt: { id: "pmpt_1" } })).not.toBeNull();
  });

  it("lets function tools through", () => {
    expect(serverSideToolUse("azure", { tools: [{ type: "function", name: "f" }] })).toBeNull();
  });
});

describe("azure usage and failures", () => {
  it("reads OpenAI's chat usage shape", () => {
    const usage = usageFromJson("azure", {
      usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
    });
    expect(usage.inputTokens).toBe(12);
    expect(usage.outputTokens).toBe(30);
  });

  it("claims no credit-exhaustion signature it has not verified", () => {
    expect(classifyUpstreamFailure("azure", 429, JSON.stringify({ error: { code: "429" } }))).toBeNull();
  });
});

describe("the sidecar recognises Azure resources by suffix", () => {
  it("maps a resource host to azure with the v1 base path", () => {
    expect(providerForHost("contoso-ai.openai.azure.com")).toMatchObject({
      provider: "azure",
      basePath: "/openai/v1",
    });
    expect(providerForHost("Contoso.services.ai.azure.com.")).toMatchObject({ provider: "azure" });
  });

  it("does not match lookalikes", () => {
    expect(providerForHost("contoso.openai.azure.com.evil.example")).toBeNull();
    expect(providerForHost("openai.azure.com")).toBeNull();
    expect(providerForHost("a.b.openai.azure.com")).toBeNull();
  });

  it("routes an absolute-form request to the governed azure route, base path stripped", () => {
    const verdict = classifyProxyRequest({
      url: "http://contoso-ai.openai.azure.com/openai/v1/chat/completions",
      gatewayOrigin: "http://127.0.0.1:3000",
    });
    expect(verdict).toMatchObject({ allow: true, path: "/api/v1/azure/chat/completions" });
  });

  it("refuses a CONNECT tunnel to a resource, even when --allow-connect names it", () => {
    const verdict = classifyConnect({
      target: "contoso-ai.openai.azure.com:443",
      gatewayOrigin: "http://127.0.0.1:3000",
      allowHosts: ["contoso-ai.openai.azure.com"],
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.code).toBe("provider_tunnel_not_governed");
  });
});
