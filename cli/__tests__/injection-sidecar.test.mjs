import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findingsFromHook } from "../injection-sidecar.mjs";
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

  it("skips leaves over 1 MB (UTF-8 bytes) without invoking the scanner", () => {
    let calls = 0;
    expect(findingsFromHook(batch(attack + "é".repeat(524288)), { scan: () => { calls++; return []; } })).toEqual([]);
    expect(calls).toBe(0);
  });

  it("fails closed to telemetry when the scanner throws", () => {
    expect(findingsFromHook(batch(attack), { scan: () => { throw new Error("scanner failed"); } })).toEqual([]);
    expect(findingsFromHook(batch([attack, attack + " second"]), { scan: (s) => {
      if (s.endsWith("second")) throw new Error("failed after a hit");
      return scanText(s);
    } })).toEqual([]);
  });

  it("omits unsafe tool names, masks unsafe path keys, and handles cycles without throwing", () => {
    expect(findingsFromHook(batch(attack, "bad/tool"))[0]).not.toHaveProperty("tool");
    expect(findingsFromHook(batch({ "bad/path": attack }))[0].path).toBe("tool_calls[0].tool_response.?");
    const cyclic = { text: attack }; cyclic.self = cyclic;
    expect(findingsFromHook(batch(cyclic))).toHaveLength(1);
  });
});
