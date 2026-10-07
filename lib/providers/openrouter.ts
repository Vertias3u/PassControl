// OpenRouter: one key, many models, each on several upstream endpoints at different
// prices (plans/openrouter.md; DECISIONS 2026-10-07, OpenRouter).
//
// Three things here differ from every other provider:
//
// 1. PRICE. A model runs on whichever endpoint routing picks, and one model's endpoints
//    can be 7x apart (llama-3.3-70b: $0.32 to $2.253 per M output, read 2026-10-07). No
//    table row can be right, so the hold is priced at the DEAREST endpoint, read from
//    OpenRouter's own public listing, and `provider.max_price` is set at that rate on the
//    forwarded body so routing cannot pick anything dearer. OpenRouter documents that
//    max_price "will prevent your request from running if the price is not available".
//
// 2. SETTLEMENT. The charge is the `usage.cost` OpenRouter reports on the call, in USD.
//    On a BYOK call (the user's own provider key, stored at OpenRouter) that figure is
//    only OpenRouter's fee (none under its monthly BYOK allowance, 5% above), and the
//    inference itself is billed to the user's provider account, reported as
//    `cost_details.upstream_inference_cost`; both are charged then.
//
// 3. MODEL CHOICE. Fields other than `model` can pick the model (`models` fallbacks,
//    `route`, presets) and router models pick one themselves; scope can only judge the
//    one it can read, so those are refused.
//
// Pure: the price lookup, which reads the network and Redis, is in openrouter-price.ts.

export const OPENROUTER_FREE_ROUTER = "openrouter/free";

/** The rates a hold is priced at: the dearest of the model's endpoints, µ¢ each. */
export interface OpenRouterCeiling {
  inputMicrocentsPerToken: number;
  outputMicrocentsPerToken: number;
  requestMicrocents: number;
  imageMicrocents: number;
}

/** No charge at all: the ceiling of a free model. */
export const ZERO: OpenRouterCeiling = Object.freeze({
  inputMicrocentsPerToken: 0,
  outputMicrocentsPerToken: 0,
  requestMicrocents: 0,
  imageMicrocents: 0,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_USD = 1_000_000;

/**
 * USD to integer micro-cents (1 USD = 10^8 µ¢), rounded UP to the next whole µ¢, never
 * down: a fraction of a µ¢ is still spend. Null for anything that is not a finite,
 * non-negative amount below a million dollars.
 *
 * A string is a price from OpenRouter's listing (`"0.00000022"`), read exactly. A
 * number is a reported cost; it is first written to 12 decimal places, which is far
 * below a µ¢ (10^-8 USD) and absorbs binary noise: `0.1 * 1e8` is 10000000.000000002 in
 * floating point, and rounding that up would overcharge by a µ¢.
 */
export function usdToMicrocents(value: number | string): number | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value >= MAX_USD) return null;
    text = value.toFixed(12);
  } else if (typeof value === "string") {
    text = value;
  } else {
    return null;
  }
  const match = /^(\d{1,7})(?:\.(\d{1,30}))?$/u.exec(text);
  if (!match) return null;
  const whole = Number(match[1]);
  if (whole >= MAX_USD) return null;
  const fraction = match[2] ?? "";
  const micro = Number(fraction.slice(0, 8).padEnd(8, "0"));
  const remainder = /[1-9]/u.test(fraction.slice(8)) ? 1 : 0;
  return whole * 100_000_000 + micro + remainder;
}

/**
 * What the call cost, from its `usage` object, in µ¢; null when that cannot be read.
 *
 * `is_byok: true`: `cost` is the fee and the upstream bill is the inference, so both.
 * `is_byok: false`: `cost` alone. Unmarked, an upstream figure above zero is charged too,
 * the direction that cannot undercount a BYOK call.
 */
export function openrouterReportedMicrocents(usage: unknown): number | null {
  if (!isRecord(usage) || typeof usage.cost !== "number") return null;
  const cost = usdToMicrocents(usage.cost);
  if (cost === null) return null;
  const details = isRecord(usage.cost_details) ? usage.cost_details : null;
  const upstream = details?.upstream_inference_cost;
  if (usage.is_byok === false) return cost;
  if (usage.is_byok === true) {
    if (typeof upstream !== "number") return null;
    const bill = usdToMicrocents(upstream);
    return bill === null ? null : cost + bill;
  }
  if (upstream === undefined || upstream === null || upstream === 0) return cost;
  if (typeof upstream !== "number") return null;
  const bill = usdToMicrocents(upstream);
  return bill === null ? null : cost + bill;
}

// Per-token rates charged on input and on output, the per-call and per-image prices,
// and the dimensions that may be ignored: web search is refused at the gateway, and a
// discount only lowers what was held. Any other dimension with a price is one nobody
// here has read, so the model is unpriced rather than priced without it.
const INPUT_RATES = ["prompt", "input_cache_read", "input_cache_write", "input_cache_write_1h", "audio", "input_audio_cache"];
const OUTPUT_RATES = ["completion", "internal_reasoning", "image_output", "audio_output"];
const KNOWN = new Set([...INPUT_RATES, ...OUTPUT_RATES, "request", "image", "web_search", "discount", "overrides", "min_prompt_tokens"]);

/**
 * The dearest rates across every endpoint OpenRouter lists for a model, including its
 * long-prompt `overrides` tiers. Null when it cannot be priced: no endpoints (an alias
 * or a router), a variable price (`-1`), an unreadable one, or a priced dimension this
 * file does not know.
 */
export function openrouterCeiling(endpoints: unknown): OpenRouterCeiling | null {
  if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
  const out = { ...ZERO };
  for (const endpoint of endpoints) {
    if (!isRecord(endpoint) || !isRecord(endpoint.pricing)) return null;
    const base = endpoint.pricing;
    if (base.prompt === undefined || base.completion === undefined) return null;
    const overrides = base.overrides === undefined ? [] : base.overrides;
    if (!Array.isArray(overrides)) return null;
    for (const tier of [base, ...overrides]) {
      if (!isRecord(tier)) return null;
      for (const [key, raw] of Object.entries(tier)) {
        if (key === "overrides" || key === "min_prompt_tokens" || key === "discount" || key === "web_search") continue;
        const value = typeof raw === "string" || typeof raw === "number" ? usdToMicrocents(raw) : null;
        if (value === null) return null;
        if (!KNOWN.has(key)) {
          if (value !== 0) return null;
          continue;
        }
        if (INPUT_RATES.includes(key)) out.inputMicrocentsPerToken = Math.max(out.inputMicrocentsPerToken, value);
        else if (OUTPUT_RATES.includes(key)) out.outputMicrocentsPerToken = Math.max(out.outputMicrocentsPerToken, value);
        else if (key === "request") out.requestMicrocents = Math.max(out.requestMicrocents, value);
        else if (key === "image") out.imageMicrocents = Math.max(out.imageMicrocents, value);
      }
    }
  }
  return out;
}

function imageParts(body: unknown): number {
  if (!isRecord(body) || !Array.isArray(body.messages)) return 0;
  let n = 0;
  for (const message of body.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) if (isRecord(part) && part.type === "image_url") n += 1;
  }
  return n;
}

/** The hold for one call, at the ceiling: tokens, the per-call price, and each image. */
export function openrouterHoldMicrocents(
  ceiling: OpenRouterCeiling,
  estimate: { inputTokens: number; outputTokens: number },
  body: unknown
): number {
  return (
    estimate.inputTokens * ceiling.inputMicrocentsPerToken +
    estimate.outputTokens * ceiling.outputMicrocentsPerToken +
    ceiling.requestMicrocents +
    imageParts(body) * ceiling.imageMicrocents
  );
}

// `author/slug`, optionally `~`-prefixed (an alias) and `:variant`-suffixed. Nothing
// that could leave the path: no second slash, no dots-only segment, no query or fragment.
const MODEL_ID = /^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/** Where OpenRouter lists a model's endpoints and their prices; null for a malformed id. */
export function openrouterEndpointsUrl(model: string): string | null {
  if (model.length > 128 || !MODEL_ID.test(model)) return null;
  return `https://openrouter.ai/api/v1/models/${model}/endpoints`;
}

const toUsd = (microcents: number) => microcents / 100_000_000;

/**
 * The body as forwarded: `provider.max_price` at the held rates, in OpenRouter's units
 * (USD per million tokens; USD per request and per image). A lower ceiling the client
 * set is kept, and so are its other routing choices. A copy; the input is not changed.
 */
export function withMaxPrice(body: Record<string, unknown>, ceiling: OpenRouterCeiling): Record<string, unknown> {
  const provider = isRecord(body.provider) ? { ...body.provider } : {};
  const client = isRecord(provider.max_price) ? provider.max_price : {};
  const ours: Record<string, number> = {
    prompt: ceiling.inputMicrocentsPerToken / 100,
    completion: ceiling.outputMicrocentsPerToken / 100,
  };
  if (ceiling.requestMicrocents > 0) ours.request = toUsd(ceiling.requestMicrocents);
  if (ceiling.imageMicrocents > 0) ours.image = toUsd(ceiling.imageMicrocents);
  const merged: Record<string, unknown> = { ...client };
  for (const [field, limit] of Object.entries(ours)) {
    const theirs = client[field];
    merged[field] = typeof theirs === "number" && Number.isFinite(theirs) && theirs >= 0 ? Math.min(theirs, limit) : limit;
  }
  provider.max_price = merged;
  return { ...body, provider };
}

/**
 * A request field that would pick the model, or reach past what the gateway can see,
 * behind `model`'s back; null when there is none. `debug` echoes the upstream request
 * body back, which is not a path a governed call needs.
 */
export function openrouterModelSelectionField(body: unknown): string | null {
  if (!isRecord(body)) return null;
  for (const field of ["models", "route", "preset", "debug"]) {
    if (body[field] !== undefined && body[field] !== null) return field;
  }
  if (body.provider !== undefined && body.provider !== null) {
    if (!isRecord(body.provider)) return "provider";
    const maxPrice = body.provider.max_price;
    if (maxPrice !== undefined && maxPrice !== null && !isRecord(maxPrice)) return "provider.max_price";
  }
  return null;
}

/**
 * A model id that names no one model: OpenRouter's routers (`openrouter/auto` and the
 * rest), or a preset (`@preset/…`, also as `model@preset/…`), which is server-side
 * configuration that can set the model and add tools. The free router is the exception:
 * whatever it picks costs nothing.
 */
export function isOpenRouterModelRouter(model: string): boolean {
  const id = model.toLowerCase();
  if (id.includes("@")) return true;
  return id.startsWith("openrouter/") && id !== OPENROUTER_FREE_ROUTER;
}
