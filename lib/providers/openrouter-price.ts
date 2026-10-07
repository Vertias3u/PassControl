// OpenRouter's price for a model, read from its public endpoint listing and cached.
// The rules for turning that listing into a hold are in openrouter.ts.
import { redis } from "@/lib/state/redis";
import { OPENROUTER_FREE_ROUTER, ZERO, openrouterCeiling, openrouterEndpointsUrl, type OpenRouterCeiling } from "./openrouter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PRICE_TTL_SECONDS = 3600;
const UNPRICED_TTL_SECONDS = 300;
const FETCH_TIMEOUT_MS = 3000;
const priceKey = (model: string) => `orprice1:${model}`;

export interface CeilingLookupDeps {
  fetch?: typeof fetch;
  cache?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  };
}

const redisCache: NonNullable<CeilingLookupDeps["cache"]> = {
  get: (key) => redis().get<unknown>(key),
  set: (key, value, ttlSeconds) => redis().set(key, value, { ex: ttlSeconds }),
};

function cachedCeiling(raw: unknown): OpenRouterCeiling | "unpriced" | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return undefined; } })() : raw;
  if (value === "unpriced") return "unpriced";
  if (!isRecord(value)) return undefined;
  const fields = ["inputMicrocentsPerToken", "outputMicrocentsPerToken", "requestMicrocents", "imageMicrocents"] as const;
  if (!fields.every((f) => Number.isSafeInteger(value[f]) && (value[f] as number) >= 0)) return undefined;
  return {
    inputMicrocentsPerToken: value.inputMicrocentsPerToken as number,
    outputMicrocentsPerToken: value.outputMicrocentsPerToken as number,
    requestMicrocents: value.requestMicrocents as number,
    imageMicrocents: value.imageMicrocents as number,
  };
}

/**
 * The ceiling for a model, from cache or from OpenRouter's public listing (no key is
 * sent: the listing is public, and the tenant's key never goes anywhere but the call).
 * Null when it cannot be priced or the listing cannot be read; under a dollar limit
 * the caller refuses the call then, as for any unpriced model.
 *
 * A model OpenRouter answered with no price is remembered for five minutes, so a
 * refused agent retrying does not fetch on every call; a failed fetch is not cached.
 */
export async function openrouterCeilingFor(model: string, deps: CeilingLookupDeps = {}): Promise<OpenRouterCeiling | null> {
  if (model === OPENROUTER_FREE_ROUTER) return ZERO;
  const url = openrouterEndpointsUrl(model);
  if (url === null) return null;
  const cache = deps.cache ?? redisCache;
  try {
    const hit = cachedCeiling(await cache.get(priceKey(model)));
    if (hit === "unpriced") return null;
    if (hit) return hit;
  } catch {
    // A cache miss, not a refusal: read the listing.
  }
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
  let ceiling: OpenRouterCeiling | null = null;
  if (response.ok) {
    try {
      const json: unknown = await response.json();
      const data = isRecord(json) && isRecord(json.data) ? json.data : null;
      ceiling = data ? openrouterCeiling(data.endpoints) : null;
    } catch {
      return null;
    }
  } else if (response.status !== 404) {
    return null;
  }
  try {
    await cache.set(
      priceKey(model),
      JSON.stringify(ceiling ?? "unpriced"),
      ceiling ? PRICE_TTL_SECONDS : UNPRICED_TTL_SECONDS
    );
  } catch {
    // Uncached is still correct, only slower.
  }
  return ceiling;
}
