import http from "node:http";
import { once } from "node:events";
import Anthropic from "@anthropic-ai/sdk";
import { ed25519 } from "@noble/curves/ed25519";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { PassControl } from "@/sdk/passcontrol";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

async function withGateway(run: (input: {
  origin: string;
  seen: Array<{ path: string; authorization?: string; apiKey?: string; body: string }>;
}) => Promise<void>) {
  const seen: Array<{ path: string; authorization?: string; apiKey?: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
        body,
      });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/auth/challenge") {
        response.end(JSON.stringify({ visa: "signed-five-minute-visa", token_type: "Bearer", expires_in: 300, jti: "visa-jti" }));
      } else if (request.url?.includes("messages")) {
        response.end(JSON.stringify({
          id: "msg_passport",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "anthropic-passport-ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      } else {
        response.end(JSON.stringify({
          id: "chatcmpl_passport",
          object: "chat.completion",
          created: 0,
          model: "gpt-5-mini",
          choices: [{ index: 0, message: { role: "assistant", content: "openai-passport-ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback gateway did not bind");
    await run({ origin: `http://127.0.0.1:${address.port}`, seen });
  } finally {
    server.close();
    await once(server, "close");
  }
}

function passport(origin: string) {
  const secret = ed25519.utils.randomPrivateKey();
  return {
    secret: b64url(secret),
    client: new PassControl({
      gateway: origin,
      passportId: b64url(ed25519.getPublicKey(secret)),
      passportSecret: b64url(secret),
    }),
  };
}

describe("published Passport SDK provider wrapping", () => {
  it("drives the official OpenAI SDK through challenge and the Cloud gateway", async () => {
    await withGateway(async ({ origin, seen }) => {
      const { client: passcontrol, secret } = passport(origin);
      const openai = new OpenAI({ ...passcontrol.clientOptions("openai"), maxRetries: 0 });
      const response = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "canary" }],
      });
      expect(response.choices[0]?.message.content).toBe("openai-passport-ok");
      expect(seen.map((call) => call.path)).toEqual([
        "/api/auth/challenge",
        "/api/v1/openai/chat/completions",
      ]);
      expect(seen[0]?.body).not.toContain(secret);
      expect(seen[1]).toMatchObject({ authorization: "Bearer signed-five-minute-visa" });
      expect(seen[1]?.apiKey).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain("passcontrol-visa");
    });
  });

  it("drives the official Anthropic SDK without leaking x-api-key", async () => {
    await withGateway(async ({ origin, seen }) => {
      const { client: passcontrol, secret } = passport(origin);
      const anthropic = new Anthropic({ ...passcontrol.clientOptions("anthropic"), maxRetries: 0 });
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "canary" }],
      });
      expect(response.content[0]).toMatchObject({ type: "text", text: "anthropic-passport-ok" });
      expect(seen.map((call) => call.path)).toEqual([
        "/api/auth/challenge",
        "/api/v1/anthropic/v1/messages",
      ]);
      expect(seen[0]?.body).not.toContain(secret);
      expect(seen[1]).toMatchObject({ authorization: "Bearer signed-five-minute-visa" });
      expect(seen[1]?.apiKey).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain("passcontrol-visa");
    });
  });
});
