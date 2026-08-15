import { describe, expect, it } from "vitest";

import { PROVIDERS, upstreamBaseUrl, type ProviderId } from "@/lib/providers";
// @ts-expect-error — plain .mjs CLI module, no types
import { PROVIDER_UPSTREAMS } from "@/cli/proxy-policy.mjs";

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
    expect(Object.keys(PROVIDER_UPSTREAMS).sort()).toEqual([...PROVIDERS].sort());
  });

  it.each([...PROVIDERS])("derives %s's host and base path from upstreamBaseUrl", (provider) => {
    const upstream = new URL(upstreamBaseUrl(provider as ProviderId));
    const entry = PROVIDER_UPSTREAMS[provider];

    expect(entry.hostname).toBe(upstream.hostname);
    // `""` for a bare host, `/openai` for groq. The sidecar strips this prefix
    // off an absolute-form request before mapping it onto /api/v1/<provider>,
    // because the gateway re-adds it from upstreamBaseUrl.
    expect(entry.basePath).toBe(upstream.pathname === "/" ? "" : upstream.pathname.replace(/\/+$/, ""));
  });
});
