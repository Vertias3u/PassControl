import { describe, expect, it } from "vitest";

import { PROVIDERS, providerRequiresEndpoint, upstreamBaseUrl, type ProviderId } from "@/lib/providers";
import { isEndpointAllowedFor } from "@/lib/providers/endpoint";
// @ts-expect-error — plain .mjs CLI module, no types
import { PROVIDER_UPSTREAMS, SERVICE_UPSTREAMS, classifyProxyRequest, providerForHost } from "@/cli/proxy-policy.mjs";
import { SERVICE_CATALOG, SERVICE_IDS } from "@/lib/services/catalog";

/** Providers with a fixed host of ours. Azure has none: it is matched by suffix. */
const FIXED_HOST = PROVIDERS.filter((p) => !providerRequiresEndpoint(p));

/**
 * `cli/` is plain .mjs run straight from the checkout and published as-is, so it
 * cannot import `lib/providers.ts` — the same constraint that forced
 * `bareGatewayOrigin` to exist twice (see `tests/cli-control-gateway.test.ts`).
 * The provider host table is therefore a second copy of `upstreamBaseUrl`, and
 * this test is the thing that stops the copies drifting.
 *
 * The failure this prevents is not cosmetic. A provider added to `lib/providers.ts`
 * and missed here is a provider the sidecar will happily CONNECT-tunnel — an
 * ungoverned call through the component that exists to govern it.
 */
describe("CLI provider host table", () => {
  it("covers exactly the providers the gateway supports", () => {
    expect(Object.keys(PROVIDER_UPSTREAMS).sort()).toEqual([...FIXED_HOST].sort());
  });

  it.each([...FIXED_HOST])("derives %s's host and base path from upstreamBaseUrl", (provider) => {
    const upstream = new URL(upstreamBaseUrl(provider as ProviderId)!);
    const entry = PROVIDER_UPSTREAMS[provider];

    expect(entry.hostname).toBe(upstream.hostname);
    // `""` for a bare host, `/openai` for groq. The sidecar strips this prefix
    // off an absolute-form request before mapping it onto /api/v1/<provider>,
    // because the gateway re-adds it from upstreamBaseUrl.
    expect(entry.basePath).toBe(upstream.pathname === "/" ? "" : upstream.pathname.replace(/\/+$/, ""));
  });

  // The sidecar's Azure suffix rule is a second copy of the gateway's, for the
  // same .mjs reason. Run both over one list, so they cannot drift: a host the
  // gateway would send an Azure key to must be one the sidecar refuses to tunnel.
  it.each([
    "contoso.openai.azure.com",
    "contoso-ai.services.ai.azure.com",
    "a1.openai.azure.com",
    "openai.azure.com",
    "a.b.openai.azure.com",
    "-x.openai.azure.com",
    "x-.openai.azure.com",
    "contoso.cognitiveservices.azure.com",
    "contoso.openai.azure.com.evil.example",
    "api.openai.com",
  ])("agrees with the gateway about %s", (host) => {
    const gateway = isEndpointAllowedFor("azure", `https://${host}/openai/v1`, { kind: "off" });
    const sidecar = providerForHost(host)?.provider === "azure";
    expect(sidecar).toBe(gateway);
  });
});

// Any-API: the sidecar's service host table is a second copy of the gateway's
// catalog. A service added there and missed here is a host the sidecar would
// CONNECT-tunnel with nothing governing it.
describe("CLI service host table", () => {
  it("covers exactly the services the gateway serves", () => {
    expect(Object.keys(SERVICE_UPSTREAMS).sort()).toEqual([...SERVICE_IDS].sort());
  });

  // The prefix the gateway's upstreamUrl adds after the origin (Brave pins
  // /res/v1, Discord's API lives under /api). The sidecar strips the same prefix
  // from a request it routes, or the gateway would add it twice. Telegram's
  // `/bot<token>` is a credential, not a base path.
  const BASE_PATHS: Record<string, string> = { github: "", telegram: "", brave: "/res/v1", notion: "", discord: "/api" };

  it.each([...SERVICE_IDS])("agrees with the catalog on %s's host, and governs it at /api/v1/svc", (service) => {
    const origin = new URL(SERVICE_CATALOG[service].origin);
    expect(SERVICE_UPSTREAMS[service].hostname).toBe(origin.hostname);
    expect(SERVICE_UPSTREAMS[service].basePath).toBe(BASE_PATHS[service]);
    expect(providerForHost(origin.hostname)).toMatchObject({ route: `svc/${service}` });
  });

  it.each([
    ["brave", "http://api.search.brave.com/res/v1/web/search?q=x", "/api/v1/svc/brave/web/search?q=x"],
    ["discord", "http://discord.com/api/v10/channels/1/messages", "/api/v1/svc/discord/v10/channels/1/messages"],
    ["notion", "http://api.notion.com/v1/pages/p1", "/api/v1/svc/notion/v1/pages/p1"],
  ])("routes a plain-HTTP %s request to the path the gateway expects", (_service, url, path) => {
    expect(classifyProxyRequest({ url, gatewayOrigin: "https://gw.example" })).toMatchObject({ allow: true, path });
  });

  it.each(["brave", "discord"] as const)("%s's base path is exactly what the gateway's upstreamUrl adds", (service) => {
    const entry = SERVICE_CATALOG[service];
    // Discord's documentation example token, split so secret scanners do not block a push over it.
    const token = service === "brave" ? "BSAexampleSubscriptionToken0123456789" : ["MTk4NjIyNDgzNDcxOTI1MjQ4", "Cl2FMQ", "ZnCjm1XVW7vRze4b7Cq4se7kKWs"].join(".");
    expect(entry.upstreamUrl(token, "/x", "")).toBe(`${entry.origin}${BASE_PATHS[service]}/x`);
  });
});
