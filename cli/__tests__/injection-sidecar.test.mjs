import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findingsFromHook, gapFromOversizedHook } from "../injection-sidecar.mjs";
import { INJECTION_DETECTOR, INJECTION_NORMALIZATION, scanText } from "../injection-scan.mjs";

const fixture = JSON.parse(readFileSync(new URL("../../tests/fixtures/claude-code/post-tool-batch.json", import.meta.url), "utf8"));
const attack = fixture.tool_calls[0].tool_response;
const hash = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const batch = (response, tool = "Read") => ({ hook_event_name: "PostToolBatch", tool_calls: [{ tool_name: tool, tool_response: response }] });

describe("metadata-only hook findings", () => {
  it("scans the real string response without leaking its contents", () => {
    const events = findingsFromHook(fixture, { seen: new Set(), now: () => 123 });
    expect(events).toEqual([{
      kind: "injection_finding", at: 123, source: "tool_result", path: "tool_calls[0].tool_response", tool: "Read",
      families: ["instruction_override", "exfil_directive", "hidden_text"], severity: "high",
      detector: INJECTION_DETECTOR, normalization_version: INJECTION_NORMALIZATION, block_sha256: hash(attack),
    }]);
    const wire = JSON.stringify(events);
    for (const secret of [attack, "Ignore all previous instructions", "evil.test", fixture.tool_calls[0].tool_input.file_path]) expect(wire).not.toContain(secret);
  });

  it("walks lists and nested objects, and ignores clean batches and other hooks", () => {
    expect(findingsFromHook(batch([{ type: "text", text: attack }]))[0].path).toBe("tool_calls[0].tool_response[0].text");
    expect(findingsFromHook(batch({ result: { body: attack } }))[0].path).toBe("tool_calls[0].tool_response.result.body");
    expect(findingsFromHook(batch("A clean tool result."))).toEqual([]);
    expect(findingsFromHook({ ...fixture, hook_event_name: "PreToolUse" })).toEqual([]);
  });

  it("caps each batch at 20 and deduplicates across hooks in a bounded set", () => {
    const seen = new Set();
    expect(findingsFromHook(batch(Array.from({ length: 30 }, (_, i) => `${attack} ${i}`)), { seen })).toHaveLength(20);
    expect(findingsFromHook(batch(attack), { seen })).toHaveLength(1);
    expect(findingsFromHook(batch(attack), { seen })).toEqual([]);
    for (let i = 0; i < 1100; i++) findingsFromHook(batch(`${attack} unique ${i}`), { seen });
    expect(seen.size).toBeLessThanOrEqual(1000);
    expect(findingsFromHook(batch(attack), { seen })).toHaveLength(1);
  });

  it("keeps scanning past the cap: a strong tell after twenty weak ones is still found, and kept", () => {
    // 1.7.1 (external review): the cap limits what is uploaded, never what is read.
    const weak = Array.from({ length: 25 }, (_, i) => `The doc quotes "ignore previous instructions" as an example, ${i}.`);
    expect(scanText(weak[0]).every((hit) => hit.severity === "low")).toBe(true);
    const events = findingsFromHook(batch([...weak, attack]));
    expect(events).toHaveLength(20);
    expect(events[0]).toMatchObject({ severity: "high", block_sha256: hash(attack) });
    expect(events.filter((e) => e.severity === "low")).toHaveLength(19);
  });

  it("a block past the cap is not marked seen, so a later hook can still upload it", () => {
    const seen = new Set();
    const many = Array.from({ length: 21 }, (_, i) => `${attack} ${i}`);
    expect(findingsFromHook(batch(many), { seen })).toHaveLength(20);
    expect(findingsFromHook(batch(many), { seen })).toHaveLength(1);
  });

  // 1.7.1 (external review P1, P3): what was not read is a gap, never clean. Leaves are
  // scanned whole up to an 8 MB budget per hook; past it, and wherever the scanner throws,
  // one injection_incomplete event per kind says so, with a hash of what went unread.
  const MB = 1024 * 1024;
  const gapOf = (events, gap) => events.find((e) => e.kind === "injection_incomplete" && e.gap === gap);

  it("scans a leaf whole up to the budget: a tell at the end of 7 MB is found", () => {
    const events = findingsFromHook(batch("lorem ipsum ".repeat((7 * MB) / 12) + attack));
    expect(events).toEqual([expect.objectContaining({ kind: "injection_finding", severity: "high" })]);
  });

  it("past the budget: the rest is a too_large gap, with no text and no families, and the scanner is not called on it", () => {
    let calls = 0;
    const big = "é".repeat(4.5 * MB); // 9 MB of UTF-8
    const events = findingsFromHook(batch([attack, big]), { now: () => 7, scan: (t) => (calls++, scanText(t)) });
    expect(calls).toBe(1);
    expect(events).toHaveLength(2);
    expect(gapOf(events, "too_large")).toEqual({
      kind: "injection_incomplete", at: 7, source: "tool_result", path: "tool_calls[0].tool_response[1]", tool: "Read", gap: "too_large",
      detector: INJECTION_DETECTOR, normalization_version: INJECTION_NORMALIZATION, block_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(gapOf(events, "too_large").block_sha256).not.toBe(hash(big));
    expect(JSON.stringify(events)).not.toContain("éé");
  });

  it("the budget is per hook: many leaves that fit one by one still stop at 8 MB in total", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(2 * MB));
    const events = findingsFromHook(batch(leaves));
    expect(events).toEqual([expect.objectContaining({ gap: "too_large", path: "tool_calls[0].tool_response[4]" })]);
  });

  it("a scanner that throws is a scan_failed gap; what it did scan still counts", () => {
    const events = findingsFromHook(batch([attack, `${attack} second`]), { scan: (t) => {
      if (t.endsWith("second")) throw new Error("failed after a hit");
      return scanText(t);
    } });
    expect(events.map((e) => e.kind)).toEqual(["injection_incomplete", "injection_finding"]);
    expect(gapOf(events, "scan_failed")).toMatchObject({ path: "tool_calls[0].tool_response[1]", gap: "scan_failed" });
    expect(gapOf(events, "scan_failed")).not.toHaveProperty("families");
  });

  it("a gap is uploaded ahead of the 20-finding cap, and the same gap is reported once", () => {
    const seen = new Set();
    const input = batch([...Array.from({ length: 25 }, (_, i) => `${attack} ${i}`), "x".repeat(9 * MB)]);
    const first = findingsFromHook(input, { seen });
    expect(first).toHaveLength(20);
    expect(first[0]).toMatchObject({ kind: "injection_incomplete", gap: "too_large" });
    const again = findingsFromHook(input, { seen });
    expect(again.some((e) => e.kind === "injection_incomplete")).toBe(false);
  });

  it("the gap's hash follows what went unread: a different unread tail is a new gap", () => {
    const one = gapOf(findingsFromHook(batch(["a".repeat(9 * MB)])), "too_large");
    const two = gapOf(findingsFromHook(batch(["b".repeat(9 * MB)])), "too_large");
    expect(one.block_sha256).not.toBe(two.block_sha256);
  });

  it("a scanner that returns nonsense fails that leaf only", () => {
    const events = findingsFromHook(batch(["one", attack]), { scan: (t) => (t === "one" ? undefined : scanText(t)) });
    expect(events.map((e) => e.kind)).toEqual(["injection_incomplete", "injection_finding"]);
    expect(events[0]).toMatchObject({ gap: "scan_failed", path: "tool_calls[0].tool_response[0]" });
  });

  it("a failure outside any one leaf is still a scan_failed gap, never silence", () => {
    const events = findingsFromHook(batch(attack), { now: () => { throw new Error("clock"); } });
    expect(events).toEqual([expect.objectContaining({ kind: "injection_incomplete", gap: "scan_failed", path: "tool_calls" })]);
    expect(findingsFromHook({ hook_event_name: "PreToolUse", tool_input: {} }, { now: () => { throw new Error("clock"); } })).toEqual([]);
  });

  it("8 MB of hostile text scans in well under the hook's time", () => {
    const hostile = Array.from({ length: 8 * MB / attack.length }, (_, i) => (i % 7 ? "<!-- x -->" : attack)).join("").slice(0, 8 * MB - 1);
    const started = performance.now();
    findingsFromHook(batch(hostile));
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("omits unsafe tool names, masks unsafe path keys, and handles cycles without throwing", () => {
    expect(findingsFromHook(batch(attack, "bad/tool"))[0]).not.toHaveProperty("tool");
    expect(findingsFromHook(batch({ "bad/path": attack }))[0].path).toBe("tool_calls[0].tool_response.?");
    const cyclic = { text: attack }; cyclic.self = cyclic;
    expect(findingsFromHook(batch(cyclic))).toHaveLength(1);
  });
});

describe("an oversized hook body", () => {
  const sha = "ab".repeat(32);
  it("names the hook from its start: a post-tool body is a gap, another hook is not", () => {
    expect(gapFromOversizedHook('{"session_id":"s","hook_event_name":"PostToolBatch","tool_calls":[', sha)).toMatchObject({ gap: "too_large", path: "tool_calls" });
    expect(gapFromOversizedHook('{"session_id":"s","hook_event_name":"PreToolUse","tool_input":{', sha)).toBeNull();
  });

  it("a name inside the tool's own output does not count: it is still a gap", () => {
    // A structured tool_response with a real key, serialised before the hook's own name.
    expect(gapFromOversizedHook('{"tool_response":{"hook_event_name":"PreToolUse"},"hook_event_name":"PostToolUse"', sha)).toMatchObject({ gap: "too_large" });
    // An escaped string cannot fake the key at all.
    expect(gapFromOversizedHook('{"tool_response":"{\\"hook_event_name\\":\\"PreToolUse\\"}"', sha)).toMatchObject({ path: "hook_input" });
  });
});
