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
import { scopeAllows } from "../lib/scope";
import {
  DEFAULT_ALLOWED_MODELS as SHARED_ALLOWED_MODELS,
  DEFAULT_CLIENT_MODELS as SHARED_CLIENT_MODELS,
  defaultAllowedModelForProvider,
} from "../cli/integration-defaults.mjs";
// @ts-expect-error — plain .mjs CLI module, no types
import { defaultModelForProvider } from "../cli/config.mjs";
import {
  DEFAULT_ALLOWED_MODELS as DASHBOARD_ALLOWED_MODELS,
  DEFAULT_CLIENT_MODELS as DASHBOARD_CLIENT_MODELS,
} from "../lib/agent-connect";

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

  it.each(PROVIDERS)("authorises the concrete %s default through the real scope matcher", (provider) => {
    const allowed = defaultAllowedModelForProvider(provider);
    const model = defaultModelForProvider(provider);
    expect(model).toBe(SHARED_CLIENT_MODELS[provider]);
    expect(allowed).toBe(SHARED_ALLOWED_MODELS[provider]);
    expect(scopeAllows([{ provider, models: [allowed] }], provider, model)).toBe(true);
  });

  it("exports the exact same maps to dashboard issuance and Direct Agent Key creation", () => {
    expect(DASHBOARD_ALLOWED_MODELS).toBe(SHARED_ALLOWED_MODELS);
    expect(DASHBOARD_CLIENT_MODELS).toBe(SHARED_CLIENT_MODELS);
  });
});
