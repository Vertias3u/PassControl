import { describe, it, expect, vi, beforeEach } from "vitest";
import { ControlClient, ControlApiError } from "../sdk/control";

// Mock transport recording calls; configurable response per test.
let next: { status: number; body: unknown } = { status: 200, body: { data: null } };
const calls: { url: string; method: string; headers: Headers; body?: string }[] = [];
const fetchMock = vi.fn(async (url: string, init: any = {}) => {
  calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
  return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
});

const pc = () => new ControlClient({ gateway: "https://gw.example.com/", apiKey: "pc_" + "a".repeat(40), fetch: fetchMock as any });

beforeEach(() => {
  calls.length = 0;
  next = { status: 200, body: { data: null } };
});

describe("ControlClient — request shaping", () => {
  it("targets /api/control/v1, sends the bearer key, and unwraps `data`", async () => {
    next = { status: 200, body: { data: [{ id: "a1" }] } };
    const out = await pc().agents.list({ status: "active", limit: 10 });
    expect(out).toEqual([{ id: "a1" }]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://gw.example.com/api/control/v1/agents?status=active&limit=10");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer pc_" + "a".repeat(40));
  });

  it("omits undefined query params", async () => {
    next = { status: 200, body: { data: [] } };
    await pc().logs.list({ agent_id: "ag1" }); // status/limit omitted
    expect(calls[0]!.url).toBe("https://gw.example.com/api/control/v1/logs?agent_id=ag1");
  });

  it("POSTs create with a JSON body and Idempotency-Key", async () => {
    next = { status: 201, body: { data: { id: "a9", name: "bot" } } };
    const out = await pc().agents.create(
      { name: "bot", passportPubkey: "pk", scopes: [{ provider: "anthropic", models: ["claude-*"] }] },
      { idempotencyKey: "op-1" }
    );
    expect(out).toEqual({ id: "a9", name: "bot" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.headers.get("idempotency-key")).toBe("op-1");
    expect(JSON.parse(calls[0]!.body!).name).toBe("bot");
  });

  it("PATCH update sends the partial body", async () => {
    next = { status: 200, body: { data: { id: "a1" } } };
    await pc().agents.update("a1", { budget_tokens: 1000 });
    expect(calls[0]!.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ budget_tokens: 1000 });
  });

  it("suspend / resume / revoke hit the right method + path", async () => {
    next = { status: 200, body: { data: { id: "a1", status: "suspended" } } };
    await pc().agents.suspend("a1");
    expect(calls[0]!).toMatchObject({ method: "POST", url: "https://gw.example.com/api/control/v1/agents/a1/suspend" });
    await pc().agents.revoke("a1");
    expect(calls[1]!).toMatchObject({ method: "DELETE", url: "https://gw.example.com/api/control/v1/agents/a1" });
  });

  it("killSwitch.set PUTs { armed }", async () => {
    next = { status: 200, body: { data: { armed: true, affected: 2 } } };
    const out = await pc().killSwitch.set(true, { idempotencyKey: "k1" });
    expect(out).toEqual({ armed: true, affected: 2 });
    expect(calls[0]!.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ armed: true });
    expect(calls[0]!.headers.get("idempotency-key")).toBe("k1");
  });
});

describe("ControlClient — errors", () => {
  it("throws ControlApiError with code + status + requestId on non-2xx", async () => {
    next = { status: 403, body: { error: { code: "insufficient_scope", message: "need write", request_id: "req-42" } } };
    await expect(pc().agents.create({ name: "x", passportPubkey: "p", scopes: [] })).rejects.toMatchObject({
      name: "ControlApiError",
      status: 403,
      code: "insufficient_scope",
      requestId: "req-42",
    });
  });

  it("ControlApiError is an Error subclass", async () => {
    next = { status: 404, body: { error: { code: "not_found", message: "nope" } } };
    const err = await pc().agents.get("missing").catch((e) => e);
    expect(err).toBeInstanceOf(ControlApiError);
    expect(err).toBeInstanceOf(Error);
  });
});
