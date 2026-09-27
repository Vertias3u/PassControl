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
import { costMicrocents, hasListedPrice } from "../lib/pricing";
import type { ProviderId } from "../lib/providers";

const mc = (usd: number) => Math.ceil(usd * 100 - 1e-9);
type Row = [id: string, inputUsd: number, outputUsd: number];

const TABLE: Record<ProviderId, { source: string; rows: Row[] }> = {
  anthropic: {
    source: "platform.claude.com/docs/en/about-claude/pricing (Base input, Output)",
    rows: [
      ["claude-fable-5-1", 10, 50], ["claude-fable-5", 10, 50],
      ["claude-opus-5-5", 4, 20], ["claude-opus-5", 5, 25],
      ["claude-opus-4-8", 5, 25], ["claude-opus-4-7", 5, 25], ["claude-opus-4-6", 5, 25], ["claude-opus-4-5", 5, 25],
      ["claude-opus-4-1", 15, 75], ["claude-opus-4", 15, 75],
      ["claude-sonnet-5", 2, 10], ["claude-sonnet-4-6", 3, 15], ["claude-sonnet-4-5", 3, 15], ["claude-sonnet-4", 3, 15],
      ["claude-haiku-4-5", 1, 5], ["claude-haiku-4-5-20251001", 1, 5], ["claude-3-5-haiku", 0.8, 4],
    ],
  },
  openai: {
    // Standard tier; input = max(input, cache write) and both at the long-context
    // rate where the page gives one.
    source: "developers.openai.com/api/docs/pricing (Standard pricing data)",
    rows: [
      ["gpt-6-astra", 25, 75], ["gpt-6-sol", 5, 15], ["gpt-6-luna", 0.25, 0.75],
      ["gpt-5.6-sol", 10, 30], ["gpt-5.6-terra", 5, 18], ["gpt-5.6-luna", 0.5, 1.8],
      ["gpt-5.6-cyber", 15.625, 75], ["gpt-5.5-cyber", 12.5, 75],
      ["gpt-5.5", 10, 45], ["gpt-5.5-pro", 60, 270],
      ["gpt-5.4", 5, 22.5], ["gpt-5.4-mini", 0.75, 4.5], ["gpt-5.4-nano", 0.2, 1.25], ["gpt-5.4-pro", 60, 270],
      ["gpt-5.2", 1.75, 14], ["gpt-5.2-pro", 21, 168], ["gpt-5.1", 1.25, 10],
      ["gpt-5", 1.25, 10], ["gpt-5-mini", 0.25, 2], ["gpt-5-nano", 0.05, 0.4], ["gpt-5-pro", 15, 120],
      ["gpt-4.1", 2, 8], ["gpt-4.1-mini", 0.4, 1.6], ["gpt-4.1-nano", 0.1, 0.4],
      ["gpt-4o", 2.5, 10], ["gpt-4o-2024-05-13", 5, 15], ["gpt-4o-2024-08-06", 2.5, 10], ["gpt-4o-mini", 0.15, 0.6],
      ["o1", 15, 60], ["o1-pro", 150, 600], ["o3-pro", 20, 80], ["o3", 2, 8], ["o4-mini", 1.1, 4.4], ["o3-mini", 1.1, 4.4],
      ["gpt-4-turbo-2024-04-09", 10, 30], ["gpt-4-0613", 30, 60],
      ["gpt-3.5-turbo", 0.5, 1.5], ["gpt-3.5-turbo-0125", 0.5, 1.5], ["gpt-3.5-turbo-1106", 1, 2],
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
};

describe.each(Object.entries(TABLE) as [ProviderId, (typeof TABLE)[ProviderId]][])(
  "%s prices",
  (provider, { source, rows }) => {
    it.each(rows)(`%s is $%s in / $%s out per 1M (${source})`, (id, inUsd, outUsd) => {
      expect(hasListedPrice(id, provider)).toBe(true);
      expect(costMicrocents(id, 1, 0, provider)).toBe(mc(inUsd));
      expect(costMicrocents(id, 0, 1, provider)).toBe(mc(outUsd));
    });
  }
);

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
  it.each(Object.entries(TABLE) as [ProviderId, (typeof TABLE)[ProviderId]][])("%s", (provider, { rows }) => {
    const maxIn = Math.max(...rows.map((r) => mc(r[1])));
    const maxOut = Math.max(...rows.map((r) => mc(r[2])));
    expect(costMicrocents("passcontrol-unlisted-zz", 1, 0, provider)).toBe(maxIn);
    expect(costMicrocents("passcontrol-unlisted-zz", 0, 1, provider)).toBe(maxOut);
  });
});
