// Local models (1.2.0): asking a local server which models it has, for the
// dashboard's "Use Ollama" setup and the agent wizard's suggestions.
//
// This is the dashboard reaching an address the developer chose, so it answers
// to the same operator gate the gateway does: off (hosted Cloud) sends nothing.
import { describe, expect, it, vi } from "vitest";

import { OLLAMA_ENDPOINT, listLocalModels } from "@/lib/providers/local-server";

const ok = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

describe("listing a local server's models", () => {
  it("names Ollama's OpenAI-compatible base", () => {
    expect(OLLAMA_ENDPOINT).toBe("http://localhost:11434/v1");
  });

  it("sends nothing where the operator gate is off", async () => {
    const fetchImpl = ok({ data: [] });
    expect(await listLocalModels(OLLAMA_ENDPOINT, { kind: "off" }, fetchImpl)).toEqual({ state: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an address the gate would not admit, without sending", async () => {
    const fetchImpl = ok({ data: [] });
    const result = await listLocalModels("http://user:pw@localhost:11434/v1", { kind: "selfhost" }, fetchImpl);
    expect(result).toEqual({ state: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the model ids from the OpenAI-shaped listing", async () => {
    const fetchImpl = ok({ object: "list", data: [{ id: "qwen2.5:0.5b" }, { id: "llama3.2:latest" }] });
    const result = await listLocalModels(OLLAMA_ENDPOINT, { kind: "selfhost" }, fetchImpl);
    expect(result).toEqual({ state: "ok", models: ["qwen2.5:0.5b", "llama3.2:latest"] });
  });

  it("asks at <base>/models, never following a redirect, with no credential", async () => {
    const fetchImpl = ok({ data: [] });
    await listLocalModels(`${OLLAMA_ENDPOINT}/`, { kind: "selfhost" }, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/models");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("drops ids that could not be sent as a model, and duplicates", async () => {
    const fetchImpl = ok({ data: [{ id: "good:1b" }, { id: "has space" }, { id: 7 }, { id: "good:1b" }, {}] });
    const result = await listLocalModels(OLLAMA_ENDPOINT, { kind: "selfhost" }, fetchImpl);
    expect(result).toEqual({ state: "ok", models: ["good:1b"] });
  });

  it("keeps at most 50", async () => {
    const fetchImpl = ok({ data: Array.from({ length: 80 }, (_, i) => ({ id: `m${i}` })) });
    const result = await listLocalModels(OLLAMA_ENDPOINT, { kind: "selfhost" }, fetchImpl);
    expect(result.state === "ok" && result.models.length).toBe(50);
  });

  it("reports a server that answered with an error", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    expect(await listLocalModels(OLLAMA_ENDPOINT, { kind: "selfhost" }, fetchImpl)).toEqual({
      state: "refused",
      status: 401,
    });
  });

  it("reports a redirect as a refusal rather than following it", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://elsewhere/" } }));
    expect(await listLocalModels(OLLAMA_ENDPOINT, { kind: "selfhost" }, fetchImpl)).toEqual({
      state: "refused",
      status: 302,
    });
  });

  it("reports a server that is not running", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await listLocalModels(OLLAMA_ENDPOINT, { kind: "selfhost" }, fetchImpl)).toEqual({ state: "unreachable" });
  });

  it("reports a body that is not a model listing as unreachable", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await listLocalModels(OLLAMA_ENDPOINT, { kind: "selfhost" }, fetchImpl)).toEqual({ state: "unreachable" });
  });
});
