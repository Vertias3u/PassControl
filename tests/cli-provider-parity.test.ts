// The CLI keeps its OWN copy of the provider list, and nothing compared the two.
//
// `cli/config.mjs` is plain .mjs — published and run as-is, so it cannot import
// `lib/providers.ts` and the compiler cannot check it. It therefore re-declares
// `PROVIDERS` and `OPENAI_SHAPE_PROVIDERS` by hand. Add a provider to
// lib/providers.ts and forget cli/config.mjs and EVERY test still passes, while
// `passcontrol call --provider <new>` dies with `Unknown provider` and the MCP
// server's `z.enum(PROVIDERS)` (cli/mcp/server.mjs:47) rejects it. The reverse
// is worse and quieter: `OPENAI_SHAPE_PROVIDERS` disagreeing with
// `usesOpenAiUsageShape` means the CLI sends one request shape while the gateway
// bills against the other's usage fields.
//
// tests/cli-provider-hosts.test.ts already guards cli/proxy-policy.mjs this way.
// This is the same guard for the other CLI copy. Read as text and regex-matched
// for the same reason as tests/cli-schema-words.test.ts: a .mjs file cannot
// import a TS union, so the declaration is compared, not the type.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, usesOpenAiUsageShape } from "../lib/providers";

const repo = process.cwd();

function cliSource(): string {
  return readFileSync(join(repo, "cli/config.mjs"), "utf8");
}

function cliProviders(): string[] {
  const match = /export const PROVIDERS = \[([^\]]*)\]/u.exec(cliSource());
  if (!match) throw new Error("PROVIDERS is no longer declared where this test looks");
  return [...match[1]!.matchAll(/"([a-z0-9-]+)"/gu)].map((m) => m[1]!);
}

function cliOpenAiShapeProviders(): string[] {
  const match = /export const OPENAI_SHAPE_PROVIDERS = new Set\(\[([^\]]*)\]\)/u.exec(cliSource());
  if (!match) {
    throw new Error("OPENAI_SHAPE_PROVIDERS is no longer declared where this test looks");
  }
  return [...match[1]!.matchAll(/"([a-z0-9-]+)"/gu)].map((m) => m[1]!);
}

describe("the CLI's provider list", () => {
  it("finds both declarations", () => {
    expect(cliProviders().length).toBeGreaterThan(0);
    expect(cliOpenAiShapeProviders().length).toBeGreaterThan(0);
  });

  it("matches lib/providers.ts exactly", () => {
    expect(cliProviders().sort()).toEqual([...PROVIDERS].sort());
  });

  it("agrees with usesOpenAiUsageShape about which providers are OpenAI-shaped", () => {
    const expected = PROVIDERS.filter(usesOpenAiUsageShape).sort();
    expect(cliOpenAiShapeProviders().sort()).toEqual([...expected]);
  });

  it("has a default model for every provider", () => {
    // cli/config.mjs's defaultModelForProvider is a switch with a `default:`
    // arm returning a Claude model — so a missing case does not throw, it
    // silently sends a Claude model name to a non-Anthropic provider.
    const source = cliSource();
    const body = /function defaultModelForProvider\([^)]*\) \{([\s\S]*?)\n\}/u.exec(source);
    if (!body) throw new Error("defaultModelForProvider is no longer declared where this test looks");
    const cased = [...body[1]!.matchAll(/case "([a-z0-9-]+)":/gu)].map((m) => m[1]!);
    const missing = PROVIDERS.filter((p) => !cased.includes(p));
    expect(
      missing,
      `defaultModelForProvider in cli/config.mjs falls through to the default arm for: ${missing.join(", ")}`
    ).toEqual([]);
  });
});
