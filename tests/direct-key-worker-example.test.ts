// F4 — the canonical integration example. It is the first thing an outside
// developer runs, so its report has to be exactly as honest as the dashboard:
// a refusal is claimed only when PassControl said blocked_scope, a forwarded
// call is never presented as a refusal, and the Direct Agent Key is never
// printed. Run as a real process against a stub gateway, because what matters
// is what the script prints and how it exits.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const KEY = "pc_agent_" + "k".repeat(35) + "Zz9_-Ab1";

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  model: string | undefined;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

let server: Server | null = null;

async function stubGateway(reply: (model: string | undefined) => Reply): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let model: string | undefined;
      try {
        model = JSON.parse(raw).model;
      } catch {}
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, model });
      const r = reply(model);
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["examples/direct-key-worker.mjs"], {
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const ok = (model: string | undefined): Reply => ({
  status: 200,
  headers: { "x-passcontrol-receipt-id": "rcpt-allowed" },
  body: {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "PassControl connected" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  },
});

describe("examples/direct-key-worker.mjs", () => {
  it("makes one forwarded call and one scope refusal, and reports each for what it was", async () => {
    const gw = await stubGateway((model) =>
      model === "allowed-model"
        ? ok(model)
        : { status: 403, headers: { "x-passcontrol-receipt-id": "rcpt-refused" }, body: { error: "blocked_scope" } }
    );
    const r = await run({
      OPENAI_BASE_URL: `${gw.origin}/api/v1/gemini/v1`,
      OPENAI_API_KEY: KEY,
      OPENAI_MODEL: "allowed-model",
      REFUSAL_MODEL: "not-granted",
    });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1\. allowed-model: allowed and forwarded/);
    expect(r.out).toContain("receipt: rcpt-allowed");
    expect(r.out).toMatch(/2\. not-granted: refused by PassControl — HTTP 403 blocked_scope/);
    expect(r.out).toContain("receipt: rcpt-refused");
    // The SDK's own route, with the key as Bearer — exactly what the Setup page configures.
    expect(gw.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /api/v1/gemini/v1/chat/completions",
      "POST /api/v1/gemini/v1/chat/completions",
    ]);
    expect(gw.seen.every((s) => s.authorization === `Bearer ${KEY}`)).toBe(true);
    // Never printed; only the suffix the dashboard also shows.
    expect(r.out).not.toContain(KEY);
    expect(r.out).toContain(`pc_agent_…${KEY.slice(-8)}`);
  });

  it("does not call a forwarded provider error a refusal", async () => {
    const gw = await stubGateway((model) =>
      model === "allowed-model"
        ? ok(model)
        : { status: 404, body: { error: { message: "model not found", type: "invalid_request_error" } } }
    );
    const r = await run({
      OPENAI_BASE_URL: `${gw.origin}/api/v1/gemini/v1`,
      OPENAI_API_KEY: KEY,
      OPENAI_MODEL: "allowed-model",
      REFUSAL_MODEL: "typo-model",
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NOT refused by PassControl — it was forwarded and the provider answered HTTP 404/);
    expect(r.out).not.toMatch(/2\. typo-model: refused by PassControl/);
  });

  it("does not call an admitted wildcard model a refusal", async () => {
    const gw = await stubGateway(ok);
    const r = await run({
      OPENAI_BASE_URL: `${gw.origin}/api/v1/openai/v1`,
      OPENAI_API_KEY: KEY,
      OPENAI_MODEL: "gpt-5-mini",
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/2\. passcontrol-refusal-demo: ALLOWED/);
  });

  it("names a different PassControl refusal by its code and does not retry it", async () => {
    const gw = await stubGateway(() => ({ status: 409, body: { error: "no_provider_key" } }));
    const r = await run({
      OPENAI_BASE_URL: `${gw.origin}/api/v1/openai/v1`,
      OPENAI_API_KEY: KEY,
      OPENAI_MODEL: "gpt-5-mini",
      REFUSAL_MODEL: "gpt-4o",
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/1\. gpt-5-mini: refused by PassControl — HTTP 409 no_provider_key/);
    expect(r.out).toMatch(/no stored credential for this provider/);
    // The SDK retries 409 by default; one governed attempt per call, not three.
    expect(gw.seen).toHaveLength(2);
  });

  it("refuses to run with the Setup page's placeholder or a provider key, before any request", async () => {
    const gw = await stubGateway(ok);
    for (const apiKey of ["PASTE_YOUR_DIRECT_AGENT_KEY", "sk-proj-not-a-passcontrol-key"]) {
      const r = await run({ OPENAI_BASE_URL: `${gw.origin}/api/v1/openai/v1`, OPENAI_API_KEY: apiKey, OPENAI_MODEL: "gpt-5-mini" });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/placeholder|not a Direct Agent Key/);
      expect(r.out).not.toContain("sk-proj-not-a-passcontrol-key");
    }
    expect(gw.seen).toHaveLength(0);
  });

  it("explains the missing variables instead of failing inside the SDK", async () => {
    const r = await run({});
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Set OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL/);
  });
});
