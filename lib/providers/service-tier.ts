// OpenAI reports the tier a call actually ran on only when the request names one
// (openai 6.49.0: "When the `service_tier` parameter is set, the response body will
// include the `service_tier` value based on the processing mode actually used").
// GPT-6/5.6 settle at their short-context rates only on a reported standard tier
// (lib/pricing.ts), so a project whose default is Fast mode must not be able to
// look like one. A call to OpenAI's own host that names no tier is therefore sent
// with "auto", which is what OpenAI does anyway ("When not set, the default behavior
// is 'auto'"): the call runs as before, and its tier is always reported.
//
// Only OpenAI's own host, and only chat and Responses: a custom OpenAI-compatible
// server may reject a field it does not know, and nothing there is priced anyway.
import type { UsageProtocol } from "@/lib/usage/parseStream";

export function withReportedServiceTier(
  provider: string,
  body: Record<string, unknown>,
  protocol: UsageProtocol,
  customEndpoint: string | null
): Record<string, unknown> {
  if (provider !== "openai" || customEndpoint || (protocol !== "provider" && protocol !== "responses")) return body;
  if (body.service_tier !== undefined) return body;
  return { ...body, service_tier: "auto" };
}
