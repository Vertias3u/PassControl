// The price table, pinned to the providers' own pages. Every PRICE here was read
// from the raw page (not a summary) on 2026-09-27; the URL is the section header.
// Most model ids are on the same page. Two sets were mapped instead: Anthropic's
// page names models ("Claude Opus 5.5"), so ids follow its documented pattern
// (claude-opus-5-5; the models page confirms the current ones), and Together's
// three rows map display names ("gpt-oss-120B", "Llama 3.3 70B", "MiniMax M3")
// to the ids already in use.
// A change to a price must change this file too, with a new read date — that is
// the point: a price nobody re-read cannot drift in unnoticed.
//
// USD per 1M tokens. The table rounds each rate up to a whole micro-cent per
// token (lib/pricing.ts `mc`), so expectations go through the same rounding.
import { describe, expect, it } from "vitest";
import { costMicrocents, costMicrocentsForUsage, hasListedPrice, isLivePricedProvider } from "../lib/pricing";
import type { ProviderId } from "../lib/providers";

// `+ 0` turns the -0 that Math.ceil gives a zero rate into 0; toBe tells them apart.
const mc = (usd: number) => Math.ceil(usd * 100 - 1e-9) + 0;
type Row = [id: string, inputUsd: number, outputUsd: number];

// Every provider with a price page. Azure has none to pin: its `model` is a
// deployment name, so it is unpriced by design (see the test at the bottom).
// OpenRouter has none either: it is priced per call from its own endpoint listing
// and settled at the cost it reports (lib/providers/openrouter.ts).
const TABLE: Record<Exclude<ProviderId, "azure" | "local" | "openrouter">, { source: string; rows: Row[] }> = {
  anthropic: {
    source: "platform.claude.com/docs/en/about-claude/pricing (Base input, Output)",
    rows: [
      ["claude-fable-5-1", 10, 50], ["claude-fable-5", 10, 50],
      ["claude-opus-5-5", 4, 20], ["claude-opus-5", 5, 25],
      ["claude-opus-4-8", 5, 25], ["claude-opus-4-7", 5, 25], ["claude-opus-4-6", 5, 25], ["claude-opus-4-5", 5, 25],
      ["claude-opus-4-1", 15, 75], ["claude-opus-4", 15, 75],
      // Read 2026-10-08 (same page). Mythos 5.1 and 5 are limited availability and the
      // models pages do not list their ids; these follow the documented
      // claude-{name}-{major}[-{minor}] scheme.
      ["claude-sonnet-5-5", 2, 10], ["claude-mythos-5-1", 10, 50], ["claude-mythos-5", 10, 50],
      ["claude-sonnet-5", 2, 10], ["claude-sonnet-4-6", 3, 15], ["claude-sonnet-4-5", 3, 15], ["claude-sonnet-4", 3, 15],
      // Haiku 5.5 is HELD at its over-100K rates; it settles by prompt length
      // (tests/anthropic-haiku-tiers.test.ts). Read 2026-10-08.
      ["claude-haiku-5-5", 0.5, 2.5],
      ["claude-haiku-4-5", 1, 5], ["claude-haiku-4-5-20251001", 1, 5], ["claude-3-5-haiku", 0.8, 4],
    ],
  },
  openai: {
    // Standard tier; input = max(input, cache write) and both at the long-context
    // rate where the page gives one.
    source: "developers.openai.com/api/docs/pricing (Standard pricing data)",
    rows: [
      ["gpt-6-astra", 25, 75], ["gpt-6-sol", 5, 15], ["gpt-6-luna", 0.25, 0.75],
      // Read 2026-10-07 (same page, Standard).
      ["gpt-6.1-sol", 5, 15],
      ["gpt-5.6-sol", 10, 30], ["gpt-5.6-terra", 5, 18], ["gpt-5.6-luna", 0.5, 1.8],
      // gpt-5.6-cyber: the pricing page lists no long-context column, but its model page
      // (read 2026-10-07) prices >272K prompts at 2x input and 1.5x output "for the full
      // request", so the row holds at 2x the cache-write rate and 1.5x output.
      ["gpt-5.6-cyber", 31.25, 112.5], ["gpt-5.5-cyber", 12.5, 75],
      ["gpt-5.5", 10, 45], ["gpt-5.5-pro", 60, 270],
      ["gpt-5.4", 5, 22.5], ["gpt-5.4-mini", 0.75, 4.5], ["gpt-5.4-nano", 0.2, 1.25], ["gpt-5.4-pro", 60, 270],
      ["gpt-5.2", 1.75, 14], ["gpt-5.2-pro", 21, 168], ["gpt-5.1", 1.25, 10],
      ["gpt-5", 1.25, 10], ["gpt-5-mini", 0.25, 2], ["gpt-5-nano", 0.05, 0.4], ["gpt-5-pro", 15, 120],
      ["gpt-4.1", 2, 8], ["gpt-4.1-mini", 0.4, 1.6], ["gpt-4.1-nano", 0.1, 0.4],
      ["gpt-4o", 2.5, 10], ["gpt-4o-2024-05-13", 5, 15], ["gpt-4o-2024-08-06", 2.5, 10], ["gpt-4o-mini", 0.15, 0.6],
      ["o1", 15, 60], ["o1-pro", 150, 600], ["o3-pro", 20, 80], ["o3", 2, 8], ["o4-mini", 1.1, 4.4], ["o3-mini", 1.1, 4.4],
      ["gpt-4-turbo-2024-04-09", 10, 30], ["gpt-4-0613", 30, 60],
      ["gpt-3.5-turbo", 0.5, 1.5], ["gpt-3.5-turbo-0125", 0.5, 1.5], ["gpt-3.5-turbo-1106", 1, 2],
      // Embeddings (same page, read 2026-09-27): input only.
      ["text-embedding-3-small", 0.02, 0], ["text-embedding-3-large", 0.13, 0], ["text-embedding-ada-002", 0.1, 0],
    ],
  },
  groq: {
    source: "console.groq.com/docs/models (PRICE PER 1M TOKENS)",
    rows: [
      ["openai/gpt-oss-120b", 0.15, 0.6], ["openai/gpt-oss-20b", 0.075, 0.3],
      ["openai/gpt-oss-safeguard-20b", 0.075, 0.3], ["qwen/qwen3.8-27b", 0.8, 4],
    ],
  },
  mistral: {
    source: "docs.mistral.ai/models/pricing (Standard) + model cards for API names",
    rows: [
      ["mistral-large-latest", 0.5, 1.5], ["mistral-large-2512", 0.5, 1.5],
      ["mistral-medium-latest", 1.5, 7.5],
      ["mistral-small-latest", 0.15, 0.6], ["mistral-small-2603", 0.15, 0.6],
      ["ministral-14b-latest", 0.2, 0.2], ["ministral-14b-2512", 0.2, 0.2],
      ["ministral-8b-latest", 0.15, 0.15], ["ministral-8b-2512", 0.15, 0.15],
      ["ministral-3b-latest", 0.1, 0.1], ["ministral-3b-2512", 0.1, 0.1],
      ["codestral-latest", 0.3, 0.9], ["codestral-2508", 0.3, 0.9],
      // Embeddings: mistral.ai/pricing/api, read 2026-09-27. Input only.
      ["mistral-embed", 0.1, 0], ["mistral-embed-23-12", 0.1, 0], ["mistral-embed-2312", 0.1, 0],
      ["codestral-embed", 0.15, 0], ["codestral-embed-25-05", 0.15, 0], ["codestral-embed-2505", 0.15, 0],
    ],
  },
  together: {
    source: "together.ai/pricing (Serverless: gpt-oss-120B, Llama 3.3 70B, MiniMax M3)",
    rows: [
      ["openai/gpt-oss-120b", 0.15, 0.6], ["OpenAI/gpt-oss-120B", 0.15, 0.6],
      ["meta-llama/Llama-3.3-70B-Instruct-Turbo", 1.04, 1.04], ["MiniMaxAI/MiniMax-M3", 0.3, 1.2],
    ],
  },
  deepseek: {
    source: "api-docs.deepseek.com/quick_start/pricing (PEAK)",
    rows: [
      ["deepseek-flash", 0.3, 1.2], ["deepseek-v4-flash", 0.3, 1.2],
      ["deepseek-v4-flash-vision-exp", 0.3, 1.2], ["deepseek-v4-pro", 1.32, 3.96],
    ],
  },
  gemini: {
    // Highest modality rate for input; Gemini 3.1 Pro at the >200k rate; Omni
    // at its video output rate.
    source: "ai.google.dev/gemini-api/docs/pricing (Standard, Paid Tier)",
    rows: [
      ["gemini-3.8-flash", 0.75, 3.75], ["gemini-3.7-flash", 0.75, 3.75], ["gemini-3.6-flash", 0.75, 3.75],
      ["gemini-3.5-flash", 1.5, 9], ["gemini-3.5-flash-lite", 0.3, 2.5], ["gemini-3.1-flash-lite", 0.5, 1.5],
      ["gemini-3.1-pro-preview", 4, 18], ["gemini-3.1-pro-preview-customtools", 4, 18],
      ["gemini-3-flash-preview", 1, 3], ["gemini-omni-1.1-flash", 1.5, 17.5], ["gemini-omni-flash-preview", 1.5, 17.5],
      ["gemini-2.5-pro", 2.5, 15], ["gemini-2.5-flash", 1, 2.5], ["gemini-2.5-flash-lite", 0.3, 0.4],
    ],
  },
  xai: {
    // Read 2026-09-27. Every row at the >=200k-prompt rate, which xAI applies to
    // ALL tokens of such a request (lib/pricing.ts).
    source: "docs.x.ai/developers/models.md (>=200k prompt rate)",
    rows: [
      ["grok-4.7", 4, 12], ["grok-4.6", 4, 12], ["grok-4.5", 4, 12], ["grok-4.3", 2.5, 5],
      ["grok-4.20-0309-reasoning", 2.5, 5], ["grok-4.20-0309-non-reasoning", 2.5, 5],
      ["grok-4.20-multi-agent-0309", 2.5, 5], ["grok-build-0.1", 2, 4],
    ],
  },
};

describe.each(Object.entries(TABLE) as [ProviderId, (typeof TABLE)[keyof typeof TABLE]][])(
  "%s prices",
  (provider, { source, rows }) => {
    it.each(rows)(`%s is $%s in / $%s out per 1M (${source})`, (id, inUsd, outUsd) => {
      expect(hasListedPrice(id, provider)).toBe(true);
      expect(costMicrocents(id, 1, 0, provider)).toBe(mc(inUsd));
      expect(costMicrocents(id, 0, 1, provider)).toBe(mc(outUsd));
    });
  }
);

// OpenAI's cached input (owner, 2026-10-07). Read from the raw page on 2026-10-07:
// "Long context cached input" where the page gives one, else "Short context cached
// input", the same rule as the input column above. `null` is a "-" on the page: no
// cached rate, so cached tokens are charged at the full input rate.
const OPENAI_CACHED: [id: string, cachedUsd: number | null][] = [
  ["gpt-6-astra", 2], ["gpt-6-sol", 0.4], ["gpt-6-luna", 0.02], ["gpt-6.1-sol", 0.2],
  ["gpt-5.6-sol", 0.8], ["gpt-5.6-terra", 0.4], ["gpt-5.6-luna", 0.04],
  ["gpt-5.6-cyber", 2.5], ["gpt-5.5-cyber", 1.25],
  ["gpt-5.5", 1], ["gpt-5.5-pro", null],
  ["gpt-5.4", 0.5], ["gpt-5.4-mini", 0.075], ["gpt-5.4-nano", 0.02], ["gpt-5.4-pro", null],
  ["gpt-5.2", 0.175], ["gpt-5.2-pro", null], ["gpt-5.1", 0.125],
  ["gpt-5", 0.125], ["gpt-5-mini", 0.025], ["gpt-5-nano", 0.005], ["gpt-5-pro", null],
  ["gpt-4.1", 0.5], ["gpt-4.1-mini", 0.1], ["gpt-4.1-nano", 0.025],
  ["gpt-4o", 1.25], ["gpt-4o-2024-05-13", null], ["gpt-4o-2024-08-06", 1.25], ["gpt-4o-mini", 0.075],
  ["o1", 7.5], ["o1-pro", null], ["o3-pro", null], ["o3", 0.5], ["o4-mini", 0.275], ["o3-mini", 0.55],
  ["gpt-4-turbo-2024-04-09", null], ["gpt-4-0613", null],
  ["gpt-3.5-turbo", null], ["gpt-3.5-turbo-0125", null], ["gpt-3.5-turbo-1106", null],
];

describe("openai cached input prices (developers.openai.com/api/docs/pricing, read 2026-10-07)", () => {
  const allCached = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cachedInputTokens: 1 };
  it.each(OPENAI_CACHED)("%s cached input is $%s per 1M", (id, cachedUsd) => {
    const input = costMicrocents(id, 1, 0, "openai");
    expect(costMicrocentsForUsage(allCached, id, "openai")).toBe(cachedUsd === null ? input : mc(cachedUsd));
  });

  it("names every OpenAI chat row, so a new model cannot skip the question", () => {
    const chatRows = TABLE.openai.rows.map(([id]) => id).filter((id) => !id.startsWith("text-embedding"));
    expect(OPENAI_CACHED.map(([id]) => id).sort()).toEqual(chatRows.sort());
  });

  it("never prices a cached token above an uncached one", () => {
    for (const [id] of OPENAI_CACHED) {
      expect(costMicrocentsForUsage(allCached, id, "openai")).toBeLessThanOrEqual(costMicrocents(id, 1, 0, "openai"));
    }
  });
});

// What a GPT-6 / GPT-5.6 call is SETTLED at (owner, 2026-10-07). Their model pages
// (read 2026-10-07) price a prompt above 272K input tokens at the long-context rates
// "for the full request", so a call whose reported input is at most 272,000 settles
// at the short-context rates, and only when the response reports a standard tier.
// [input, cached input, cache write, output], USD per 1M: the pricing page's Short
// and Long context columns; gpt-5.6-cyber from its model page (1.25x write, 2x/1.5x).
// GPT-5.5 and GPT-5.4 are absent on purpose: their pages say "for the full session".
type Rates = [input: number, cached: number, write: number, output: number];
const OPENAI_TIERS: [id: string, short: Rates, long: Rates][] = [
  ["gpt-6-astra", [10, 1, 12.5, 50], [20, 2, 25, 75]],
  ["gpt-6-sol", [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]],
  // Cached reads at 5% of input, not 10% (its model page).
  ["gpt-6.1-sol", [2, 0.1, 2.5, 10], [4, 0.2, 5, 15]],
  ["gpt-6-luna", [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]],
  ["gpt-5.6-sol", [4, 0.4, 5, 20], [8, 0.8, 10, 30]],
  ["gpt-5.6-terra", [2, 0.2, 2.5, 12], [4, 0.4, 5, 18]],
  ["gpt-5.6-luna", [0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]],
  ["gpt-5.6-cyber", [12.5, 1.25, 15.625, 75], [25, 2.5, 31.25, 112.5]],
];

describe("openai settlement tiers (model pages, read 2026-10-07)", () => {
  const SHORT = 272_000;
  const LONG = 272_001;
  // One kind of token at a time, so each rate is read on its own. A Responses
  // report states its cache writes (0 here unless named); the tier is "default".
  const cost = (id: string, input: number, kind: "ordinary" | "cached" | "write" | "output") =>
    costMicrocentsForUsage(
      {
        inputTokens: kind === "output" ? 0 : input,
        outputTokens: kind === "output" ? input : 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cachedInputTokens: kind === "cached" ? input : 0,
        cacheWriteInputTokens: kind === "write" ? input : 0,
        serviceTier: "default",
      },
      id,
      "openai"
    );

  it.each(OPENAI_TIERS)("%s settles at its short- and long-context rates", (id, short, long) => {
    const [si, sc, sw, so] = short;
    const [li, lc, lw] = long;
    expect(cost(id, SHORT, "ordinary")).toBe(SHORT * mc(si));
    expect(cost(id, SHORT, "cached")).toBe(SHORT * mc(sc));
    expect(cost(id, SHORT, "write")).toBe(SHORT * mc(sw));
    expect(cost(id, 1000, "output")).toBe(1000 * mc(so));
    expect(cost(id, LONG, "ordinary")).toBe(LONG * mc(li));
    expect(cost(id, LONG, "cached")).toBe(LONG * mc(lc));
    expect(cost(id, LONG, "write")).toBe(LONG * mc(lw));
  });

  it.each(OPENAI_TIERS)("%s: the hold covers every settlement rate", (id, short, long) => {
    const holdIn = costMicrocents(id, 1, 0, "openai");
    const holdOut = costMicrocents(id, 0, 1, "openai");
    for (const [rates, label] of [[short, "short"], [long, "long"]] as const) {
      expect(Math.max(mc(rates[0]), mc(rates[1]), mc(rates[2])), `${label} input`).toBeLessThanOrEqual(holdIn);
      expect(mc(rates[3]), `${label} output`).toBeLessThanOrEqual(holdOut);
    }
    short.forEach((rate, i) => expect(rate).toBeLessThanOrEqual(long[i] as number));
  });

  it("leaves GPT-5.5 and GPT-5.4 at the long-context rates their pages bill a whole session at", () => {
    for (const id of ["gpt-5.5", "gpt-5.4"]) {
      expect(cost(id, 1000, "ordinary")).toBe(1000 * costMicrocents(id, 1, 0, "openai"));
      expect(cost(id, 1000, "output")).toBe(1000 * costMicrocents(id, 0, 1, "openai"));
    }
  });
});

describe("rows are exact, never a prefix", () => {
  it.each([
    // A loose pattern once priced each of these at a sibling's (far lower) rate.
    ["openai", "o3-pro-2026-01-01", 20],
    ["openai", "gpt-5.4-pro", 60],
    ["gemini", "gemini-2.5-flash-image", null],
    ["gemini", "gemini-2.5-flash-preview-tts", null],
    ["gemini", "gemini-3.1-flash-image", null],
    ["openai", "gpt-5.4-codex", null],
    ["anthropic", "claude-opus-5-7", null],
    ["anthropic", "claude-sonnet-4-5-20250929", 3],
  ] as [ProviderId, string, number | null][])("%s %s", (provider, id, inUsd) => {
    expect(hasListedPrice(id, provider)).toBe(inUsd !== null);
    if (inUsd !== null) expect(costMicrocents(id, 1, 0, provider)).toBe(mc(inUsd));
  });
});

describe("retired or unpublished models have no row", () => {
  it.each([
    ["deepseek", "deepseek-chat"], ["deepseek", "deepseek-reasoner"],
    ["groq", "llama-3.3-70b-versatile"], ["groq", "llama-3.1-8b-instant"],
    ["together", "openai/gpt-oss-20b"],
    ["anthropic", "claude-3-5-sonnet-latest"], ["anthropic", "claude-3-opus-20240229"],
    ["mistral", "devstral-medium-latest"], ["mistral", "open-mistral-nemo"],
  ] as [ProviderId, string][])("%s %s", (provider, id) => {
    expect(hasListedPrice(id, provider)).toBe(false);
  });
});

describe("Gemini's models/ spelling prices the same model", () => {
  it("models/gemini-2.5-flash is gemini-2.5-flash", () => {
    expect(hasListedPrice("models/gemini-2.5-flash", "gemini")).toBe(true);
    expect(costMicrocents("models/gemini-2.5-flash", 1000, 1000, "gemini")).toBe(
      costMicrocents("gemini-2.5-flash", 1000, 1000, "gemini")
    );
  });
});

describe("an unlisted model bills at its provider's highest listed rate", () => {
  it.each(Object.entries(TABLE) as [ProviderId, (typeof TABLE)[keyof typeof TABLE]][])("%s", (provider, { rows }) => {
    const maxIn = Math.max(...rows.map((r) => mc(r[1])));
    const maxOut = Math.max(...rows.map((r) => mc(r[2])));
    expect(costMicrocents("passcontrol-unlisted-zz", 1, 0, provider)).toBe(maxIn);
    expect(costMicrocents("passcontrol-unlisted-zz", 0, 1, provider)).toBe(maxOut);
  });
});

describe("azure has no price rows", () => {
  it("prices nothing, so a dollar limit refuses it rather than guessing", () => {
    expect(hasListedPrice("gpt-4o-mini", "azure")).toBe(false);
    expect(costMicrocents("gpt-4o-mini", 1, 1, "azure")).toBe(0);
  });
});

describe("local has no price rows", () => {
  // A model on the developer's own server. Pricing it at zero rather than at a
  // fallback rate is also what keeps a local call's budget estimate at zero, so
  // free calls do not accumulate a phantom "charged to cap" figure.
  it("prices nothing, and estimates nothing", () => {
    expect(hasListedPrice("llama3.2", "local")).toBe(false);
    expect(costMicrocents("llama3.2", 1_000, 1_000, "local")).toBe(0);
    expect(costMicrocents("gpt-4o-mini", 1_000, 1_000, "local")).toBe(0);
  });
});

describe("openrouter has no price rows: it is priced live", () => {
  // One model there runs on many endpoints at prices up to ~7x apart, chosen per
  // call, so no row could be right (DECISIONS 2026-10-07, OpenRouter).
  it("has no row and no fallback, and is the one provider priced per call", () => {
    expect(hasListedPrice("openai/gpt-5-mini", "openrouter")).toBe(false);
    expect(costMicrocents("openai/gpt-5-mini", 1_000, 1_000, "openrouter")).toBe(0);
    expect(isLivePricedProvider("openrouter")).toBe(true);
    expect(isLivePricedProvider("openai")).toBe(false);
  });
});
