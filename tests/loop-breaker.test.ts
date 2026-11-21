// 1.9.0, the runaway-agent package, part 1: the loop breaker. An agent stuck sending the
// same request over and over spends a little on every call, so no budget line trips until
// the money is gone. The owner opts in per agent with `loop_breaker: { repeats }` in its
// policy; the gateway then pauses the agent's model calls when one request repeats that
// many times inside the window. These are the pure halves: the policy key, the
// fingerprint that decides "the same request", and the words a person reads.
import { describe, expect, it } from "vitest";

import { agentPolicyForDisplay, loopBreakerRepeats, policyIsWellFormed } from "@/lib/scope";
import { LOOP_PAUSE_S, LOOP_WINDOW_S, loopFingerprint, loopPausedMessage } from "@/lib/runaway";
// @ts-expect-error — plain .mjs CLI module, no types
import { formatProxyError } from "../cli/config.mjs";

describe("the loop_breaker policy key", () => {
  it("is off when absent, and reads the owner's repeat count when set", () => {
    expect(loopBreakerRepeats(null)).toBeNull();
    expect(loopBreakerRepeats({})).toBeNull();
    expect(loopBreakerRepeats({ loop_breaker: { repeats: 5 } })).toBe(5);
    expect(agentPolicyForDisplay({ loop_breaker: { repeats: 5 } })).toMatchObject({ valid: true, loopBreakerRepeats: 5 });
    expect(agentPolicyForDisplay(null)).toMatchObject({ loopBreakerRepeats: null });
  });

  it.each([
    ["a count below 3", { repeats: 2 }],
    ["a count above 100", { repeats: 101 }],
    ["a fraction", { repeats: 4.5 }],
    ["a string", { repeats: "5" }],
    ["an extra field", { repeats: 5, window: 60 }],
    ["a bare number", 5],
  ])("refuses %s as a malformed policy, never as off", (_label, loop_breaker) => {
    expect(policyIsWellFormed({ loop_breaker })).toBe(false);
    expect(loopBreakerRepeats({ loop_breaker })).toBeNull();
  });

  it("accepts both bounds", () => {
    expect(policyIsWellFormed({ loop_breaker: { repeats: 3 } })).toBe(true);
    expect(policyIsWellFormed({ loop_breaker: { repeats: 100 } })).toBe(true);
  });
});

describe("loopFingerprint: what counts as the same request", () => {
  const base = { provider: "anthropic", method: "POST", path: "/v1/messages" };
  const turn = (text: string, id = "toolu_1") => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });

  it("matches a retry of the identical body", async () => {
    const body = { model: "claude-haiku-4-5", messages: [turn("error: file not found")] };
    expect(await loopFingerprint({ ...base, body })).toBe(await loopFingerprint({ ...base, body: structuredClone(body) }));
  });

  it("matches the same last turn while the history grows, which is what a stuck agent sends", async () => {
    const a = { model: "m", messages: [turn("start"), turn("error: file not found")] };
    const b = { model: "m", messages: [turn("start"), { role: "assistant", content: "retrying" }, turn("error: file not found")] };
    expect(await loopFingerprint({ ...base, body: a })).toBe(await loopFingerprint({ ...base, body: b }));
  });

  it("ignores the fresh ids a client stamps on every tool call", async () => {
    const a = { model: "m", messages: [turn("same output", "toolu_aaa")] };
    const b = { model: "m", messages: [turn("same output", "toolu_bbb")] };
    expect(await loopFingerprint({ ...base, body: a })).toBe(await loopFingerprint({ ...base, body: b }));
  });

  it("tells apart a different last turn, model, path or provider", async () => {
    const body = { model: "m", messages: [turn("one")] };
    const fp = await loopFingerprint({ ...base, body });
    expect(await loopFingerprint({ ...base, body: { model: "m", messages: [turn("two")] } })).not.toBe(fp);
    expect(await loopFingerprint({ ...base, body: { ...body, model: "n" } })).not.toBe(fp);
    expect(await loopFingerprint({ ...base, path: "/v1/messages/count_tokens", body })).not.toBe(fp);
    expect(await loopFingerprint({ ...base, provider: "openai", body })).not.toBe(fp);
  });

  it("reads the last turn of OpenAI chat, Responses and Gemini shapes", async () => {
    const chat = (t: string) => ({ model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: t }] });
    const responses = (t: string) => ({ model: "m", input: [{ role: "user", content: "x" }, { type: "function_call_output", call_id: "c" + t.length, output: t }] });
    const gemini = (t: string) => ({ contents: [{ role: "user", parts: [{ text: t }] }] });
    for (const shape of [chat, responses, gemini]) {
      expect(await loopFingerprint({ ...base, body: shape("a") })).toBe(await loopFingerprint({ ...base, body: shape("a") }));
      expect(await loopFingerprint({ ...base, body: shape("a") })).not.toBe(await loopFingerprint({ ...base, body: shape("b") }));
    }
  });

  // Review 2026-11-21 (Codex): an id that NAMES the content is content, not a lap counter.
  it("tells apart the same instruction on different uploaded images or files", async () => {
    const ask = (file: string, type = "input_image") => ({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_text", text: "Describe this." }, { type, file_id: file }] }],
    });
    expect(await loopFingerprint({ ...base, body: ask("file-A") })).not.toBe(await loopFingerprint({ ...base, body: ask("file-B") }));
    expect(await loopFingerprint({ ...base, body: ask("file-A", "input_file") })).not.toBe(await loopFingerprint({ ...base, body: ask("file-B", "input_file") }));
  });

  it("reads a whole embeddings input, not its last token or its last document", async () => {
    const emb = (input: unknown) => ({ model: "text-embedding-3-small", input });
    const fp = (input: unknown) => loopFingerprint({ ...base, path: "/v1/embeddings", body: emb(input) });
    expect(await fp([100, 200, 198])).not.toBe(await fp([300, 400, 198]));
    expect(await fp(["first doc", "same last doc"])).not.toBe(await fp(["second doc", "same last doc"]));
    expect(await fp([[1, 2, 9], [3, 9]])).not.toBe(await fp([[4, 5, 9], [3, 9]]));
    expect(await fp([100, 200, 198])).toBe(await fp([100, 200, 198]));
  });

  it("has no fingerprint for a body that is not a JSON object, so it is never counted", async () => {
    expect(await loopFingerprint({ ...base, body: "text" })).toBeNull();
    expect(await loopFingerprint({ ...base, body: [1, 2] })).toBeNull();
    expect(await loopFingerprint({ ...base, body: null })).toBeNull();
  });

  it("has no fingerprint for a document nested past any real request, rather than recursing", async () => {
    let deep: unknown = "x";
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(await loopFingerprint({ ...base, body: { model: "m", messages: [{ role: "user", content: deep }] } })).toBeNull();
  });

  it("is a 64-character hex digest: no request text reaches a Redis key", async () => {
    const fp = await loopFingerprint({ ...base, body: { model: "m", messages: [turn("secret text")] } });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("what a person reads", () => {
  it("the refusal says what happened, for how long, and that nothing else was stopped", () => {
    const message = loopPausedMessage(5, 600);
    expect(message).toMatch(/same request 5 times/);
    expect(message).toMatch(/10 minutes/);
    expect(message).toMatch(/paused .*model calls/);
    expect(LOOP_WINDOW_S).toBe(600);
    expect(LOOP_PAUSE_S).toBe(900);
  });

  it("the CLI explains blocked_loop instead of printing the bare code", () => {
    const out = formatProxyError(429, JSON.stringify({ error: "blocked_loop", message: "m" }));
    expect(out).toMatch(/loop/i);
    expect(out).toMatch(/Fix:/);
  });
});
