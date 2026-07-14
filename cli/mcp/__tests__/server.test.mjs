import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../server.mjs";

const GATEWAY = "https://gateway.test";
const PASSPORT_ID = Buffer.alloc(32, 3).toString("base64url");
const PASSPORT_SECRET = Buffer.alloc(32, 7).toString("base64url");
const CLI = path.join(process.cwd(), "bin/passcontrol.mjs");
const SCOPE = [
  { provider: "anthropic", models: ["claude-*"] },
  { provider: "openai", models: ["gpt-4o-mini"] },
];

const openConnections = [];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwtWithScope(scope = SCOPE) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ scope })}.test-signature`;
}

async function connect(fetchMock) {
  const server = createMcpServer({
    gateway: GATEWAY,
    passportId: PASSPORT_ID,
    passportSecret: PASSPORT_SECRET,
    fetch: fetchMock,
    now: () => 1_700_000_000_000,
    randomUUID: () => "nonce-for-test",
  });
  const client = new Client({ name: "passcontrol-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push({ client, server });
  return client;
}

async function connectCli() {
  const client = new Client({ name: "passcontrol-cli-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: "/tmp/passcontrol-mcp-test-home",
      XDG_CONFIG_HOME: "/tmp/passcontrol-mcp-test-config",
      NODE_ENV: "test",
      PASSCONTROL_GATEWAY: GATEWAY,
      PASSPORT_ID,
      PASSPORT_SECRET,
    },
  });

  await client.connect(transport);
  openConnections.push({ client, server: null });
  return client;
}

function challengeThen(fetchMock, response) {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ visa: jwtWithScope(), expires_in: 300 }))
    .mockResolvedValueOnce(response);
}

afterEach(async () => {
  const closers = openConnections
    .splice(0)
    .flatMap(({ client, server }) => [client.close(), ...(server ? [server.close()] : [])]);
  await Promise.allSettled(closers);
});

describe("PassControl MCP server", () => {
  it("lists the chat and list_models tools", async () => {
    const client = await connectCli();

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(["chat", "list_models"]);
  }, 10000);

  it("mints a visa and sends Anthropic chat input to the governed proxy path", async () => {
    const fetchMock = vi.fn();
    challengeThen(
      fetchMock,
      jsonResponse({
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " governed" },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      })
    );
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "chat",
      arguments: {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Say hello." },
        ],
        max_tokens: 42,
        temperature: 0.2,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${GATEWAY}/api/auth/challenge`);
    const challenge = JSON.parse(fetchMock.mock.calls[0][1].body);
    const payload = JSON.parse(Buffer.from(challenge.payload, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ passport_id: PASSPORT_ID, nonce: "nonce-for-test" });
    expect(challenge.signature).toBeTruthy();

    expect(fetchMock.mock.calls[1][0]).toBe(`${GATEWAY}/api/v1/anthropic/v1/messages`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: `Bearer ${jwtWithScope()}`,
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 42,
      messages: [{ role: "user", content: "Say hello." }],
      system: "Be concise.",
      temperature: 0.2,
    });
    expect(result.content).toEqual([{ type: "text", text: "Hello governed" }]);
    expect(result.structuredContent).toEqual({
      text: "Hello governed",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });

  it("uses the OpenAI chat-completions shape for compatible providers", async () => {
    const fetchMock = vi.fn();
    challengeThen(
      fetchMock,
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "Hello from Groq" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      })
    );
    const client = await connect(fetchMock);
    const messages = [{ role: "user", content: "Say hello." }];

    const result = await client.callTool({
      name: "chat",
      arguments: { provider: "groq", model: "llama-3.1-8b-instant", messages },
    });

    expect(fetchMock.mock.calls[1][0]).toBe(`${GATEWAY}/api/v1/groq/chat/completions`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      model: "llama-3.1-8b-instant",
      messages,
    });
    expect(result.content).toEqual([{ type: "text", text: "Hello from Groq" }]);
  });

  it.each([
    [402, { error: "budget_exceeded" }, /402.*budget/is],
    [403, { error: "scope_denied" }, /403.*scope.*kill switch/is],
  ])("maps gateway %s responses to MCP tool errors", async (status, body, message) => {
    const fetchMock = vi.fn();
    challengeThen(fetchMock, jsonResponse(body, status));
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: "chat",
      arguments: {
        provider: "openai",
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(message) });
  });

  it("lists model patterns from the gateway-issued visa scope without exposing the visa", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ visa: jwtWithScope(), expires_in: 300 })
    );
    const client = await connect(fetchMock);

    const result = await client.callTool({ name: "list_models", arguments: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({
      models: [
        { provider: "anthropic", model: "claude-*" },
        { provider: "openai", model: "gpt-4o-mini" },
      ],
    });
    expect(result.content[0].text).not.toContain(jwtWithScope());
  });
});
