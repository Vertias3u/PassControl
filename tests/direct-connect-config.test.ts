import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { buildDirectConnectSetup, buildHermesCloudSetup, directClientModelIsUsable } from "@/lib/direct-connect-config";
import { PROVIDERS, type ProviderId } from "@/lib/providers";

const DIRECT_KEY = `pc_agent_${"A".repeat(43)}`;

function parseEnv(block: string): Record<string, string> {
  return Object.fromEntries(block.split("\n").map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_unavailable");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("Direct Agent setup output", () => {
  it("accepts only concrete single-token provider model identifiers", () => {
    expect(directClientModelIsUsable("gpt-5-mini")).toBe(true);
    expect(directClientModelIsUsable("openai/gpt-oss-20b")).toBe(true);
    expect(directClientModelIsUsable("claude-*")).toBe(false);
    expect(directClientModelIsUsable("gpt-5-mini\nINJECTED=value")).toBe(false);
    expect(directClientModelIsUsable("claude-haiku-4-5INJECTED=value")).toBe(false);
    expect(directClientModelIsUsable("two models")).toBe(false);
    expect(directClientModelIsUsable(" ")).toBe(false);
  });

  it("keeps one wizard but emits Anthropic-native variables and a concrete model", () => {
    const setup = buildDirectConnectSetup({
      origin: "https://passcontrol.example",
      provider: "anthropic",
      key: DIRECT_KEY,
      model: "claude-haiku-4-5",
    });
    expect(setup.family).toBe("anthropic");
    expect(setup.label).toBe("Anthropic SDK configuration");
    expect(parseEnv(setup.envBlock)).toEqual({
      ANTHROPIC_BASE_URL: "https://passcontrol.example/api/v1/anthropic",
      ANTHROPIC_API_KEY: DIRECT_KEY,
      ANTHROPIC_MODEL: "claude-haiku-4-5",
    });
    expect(setup.envBlock).not.toContain("OPENAI_");
    expect(setup.example).toContain('from "@anthropic-ai/sdk"');
    expect(setup.example).not.toContain("claude-*");
    expect(setup.smokeCommand).toContain("/api/v1/anthropic/v1/messages");
    expect(setup.smokeCommand).toContain('x-api-key: $ANTHROPIC_API_KEY');
    expect(setup.smokeCommand).not.toContain(DIRECT_KEY);
    expect(setup.smokeCommand).toContain("claude-haiku-4-5");
  });

  it("emits an SDK-correct /v1 base for every OpenAI-compatible provider", () => {
    for (const provider of PROVIDERS.filter((value) => value !== "anthropic")) {
      const setup = buildDirectConnectSetup({
        origin: "https://passcontrol.example/",
        provider,
        key: DIRECT_KEY,
        model: "callable-model",
      });
      expect(setup.family).toBe("openai");
      expect(parseEnv(setup.envBlock)).toEqual({
        OPENAI_BASE_URL: `https://passcontrol.example/api/v1/${provider}/v1`,
        OPENAI_API_KEY: DIRECT_KEY,
        OPENAI_MODEL: "callable-model",
      });
      expect(setup.envBlock).not.toContain("ANTHROPIC_");
      expect(setup.example).toContain('from "openai"');
      expect(setup.smokeCommand).toContain(`/api/v1/${provider}/v1/chat/completions`);
      expect(setup.smokeCommand).toContain("Authorization: Bearer $OPENAI_API_KEY");
      expect(setup.smokeCommand).not.toContain(DIRECT_KEY);
      expect(setup.smokeCommand).toContain("callable-model");
    }
  });

  it("emits current Hermes custom-provider YAML only for OpenAI-shaped routes", () => {
    const setup = buildHermesCloudSetup({
      origin: "https://passcontrol.example/",
      provider: "openai",
      key: DIRECT_KEY,
      model: "gpt-5-mini",
    });
    expect(setup).toEqual({
      version: "0.18.2",
      configPath: "~/.hermes/config.yaml",
      config: [
        "model:",
        '  default: "gpt-5-mini"',
        "  provider: custom",
        '  base_url: "https://passcontrol.example/api/v1/openai/v1"',
        `  api_key: "${DIRECT_KEY}"`,
      ].join("\n"),
    });
    expect(buildHermesCloudSetup({ origin: "https://passcontrol.example", provider: "anthropic", key: DIRECT_KEY, model: "claude-haiku-4-5" })).toBeNull();
  });
});

describe("vendor SDK smoke", () => {
  it("drives the displayed OpenAI values through the real SDK", async () => {
    let seen: { path?: string; authorization?: string; body?: string } = {};
    await withServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        seen = {
          path: request.url,
          authorization: request.headers.authorization,
          body,
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          id: "chatcmpl_canary",
          object: "chat.completion",
          created: 0,
          model: "gpt-canary",
          choices: [{ index: 0, message: { role: "assistant", content: "openai-ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    }, async (origin) => {
      const env = parseEnv(buildDirectConnectSetup({
        origin,
        provider: "openai",
        key: DIRECT_KEY,
        model: "gpt-canary",
      }).envBlock);
      const client = new OpenAI({
        baseURL: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        maxRetries: 0,
      });
      const response = await client.chat.completions.create({
        model: env.OPENAI_MODEL!,
        messages: [{ role: "user", content: "canary" }],
      });
      expect(response.choices[0]?.message.content).toBe("openai-ok");
    });
    expect(seen.path).toBe("/api/v1/openai/v1/chat/completions");
    expect(seen.authorization).toBe(`Bearer ${DIRECT_KEY}`);
    expect(JSON.parse(seen.body ?? "{}").model).toBe("gpt-canary");
  });

  it("drives the displayed Anthropic values through the real SDK", async () => {
    let seen: { path?: string; apiKey?: string; version?: string; body?: string } = {};
    await withServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        seen = {
          path: request.url,
          apiKey: request.headers["x-api-key"] as string | undefined,
          version: request.headers["anthropic-version"] as string | undefined,
          body,
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          id: "msg_canary",
          type: "message",
          role: "assistant",
          model: "claude-canary",
          content: [{ type: "text", text: "anthropic-ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    }, async (origin) => {
      const env = parseEnv(buildDirectConnectSetup({
        origin,
        provider: "anthropic",
        key: DIRECT_KEY,
        model: "claude-canary",
      }).envBlock);
      const client = new Anthropic({
        baseURL: env.ANTHROPIC_BASE_URL,
        apiKey: env.ANTHROPIC_API_KEY,
        maxRetries: 0,
      });
      const response = await client.messages.create({
        model: env.ANTHROPIC_MODEL!,
        max_tokens: 8,
        messages: [{ role: "user", content: "canary" }],
      });
      expect(response.content[0]?.type === "text" ? response.content[0].text : null).toBe("anthropic-ok");
    });
    expect(seen.path).toBe("/api/v1/anthropic/v1/messages");
    expect(seen.apiKey).toBe(DIRECT_KEY);
    expect(seen.version).toBeTruthy();
    expect(JSON.parse(seen.body ?? "{}").model).toBe("claude-canary");
  });
});
