// Local, best-effort tool-result scan. Only fixed metadata and a hash leave here.
import { createHash, randomBytes } from "node:crypto";
import { scanText, INJECTION_DETECTOR, INJECTION_NORMALIZATION, INJECTION_FAMILIES } from "./injection-scan.mjs";

// What one hook may scan, in UTF-8 bytes. Each leaf is scanned whole, never in chunks
// (a chunk boundary would split a fence or hidden-text span); 8 MB of hostile text scans
// in under half a second (measured 2026-10-31). Past it, the rest is a gap.
export const HOOK_SCAN_BUDGET = 8 * 1024 * 1024;
const MAX_FINDINGS = 20;
const MAX_SEEN = 1000;
const PATH = /^[A-Za-z0-9_.\[\]?-]{1,512}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,128}$/;

// Iterative traversal avoids a stack overflow on deeply nested responses. Objects
// are visited once, including if a non-JSON caller hands us a cycle.
function* stringLeaves(value, path) {
  const pending = [[value, path]];
  const visited = new WeakSet();
  while (pending.length) {
    const [node, place] = pending.pop();
    if (!PATH.test(place)) continue;
    if (typeof node === "string") {
      yield [node, place];
    } else if (node && typeof node === "object" && !visited.has(node)) {
      visited.add(node);
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        const segment = /^[A-Za-z0-9_-]{1,128}$/.test(key) ? key : "?";
        const suffix = Array.isArray(node) ? `[${segment}]` : `.${segment}`;
        // Unknown/overlong keys still get scanned; the path carries a placeholder.
        const next = place.length + suffix.length <= 512 ? place + suffix : `${place.slice(0, 510)}.?`;
        pending.push([node[key], next]);
      }
    }
  }
}

/** One `injection_incomplete` event for what went unread (1.7.1, external review P1):
 * where the first such leaf was, and a hash over the hashes of every one, so the same
 * output re-sent is the same gap and different unread output is a new one. */
function gapEvent(gap, unread, at) {
  const [first] = unread;
  const digest = createHash("sha256").update(`gap:${gap}:`);
  for (const leaf of unread) digest.update(leaf.hash);
  return {
    kind: "injection_incomplete", at, source: "tool_result", path: first.path,
    ...(first.tool ? { tool: first.tool } : {}),
    gap, detector: INJECTION_DETECTOR, normalization_version: INJECTION_NORMALIZATION, block_sha256: digest.digest("hex"),
  };
}

/** `seen` belongs to one sidecar; no text or hook input is retained. Never throws.
 * `scan` is injectable for failure tests. What could not be read (past the budget, or
 * where the scanner threw) is reported as a gap, never left out as if clean.
 */
export function findingsFromHook(input, { seen = new Set(), now = Date.now, scan = scanText } = {}) {
  const events = [];
  const found = new Set();
  const unread = { too_large: [], scan_failed: [] };
  let budget = HOOK_SCAN_BUDGET;
  try {
    let calls;
    if (input?.hook_event_name === "PostToolBatch" && Array.isArray(input.tool_calls)) {
      calls = input.tool_calls.map((call, i) => [call, call?.tool_response, `tool_calls[${i}].tool_response`]);
    } else if (input?.hook_event_name === "PostToolUse") {
      // Codex 0.163's embedded schema names tool_response. Accept aliases for
      // compatible clients; keep the actual field name in metadata paths.
      const field = ["tool_response", "tool_output", "output"].find((key) => input[key] != null);
      calls = field ? [[input, input[field], field]] : [];
    } else return [];
    // Every leaf is read; MAX_FINDINGS caps what is uploaded, strong findings first
    // (1.7.1: a cap that stopped the scan let twenty weak tells hide a strong one).
    for (const [call, response, root] of calls) {
      const tool = typeof call.tool_name === "string" && TOOL.test(call.tool_name) ? call.tool_name : undefined;
      for (const [text, path] of stringLeaves(response, root)) {
        const hash = createHash("sha256").update(text, "utf8").digest("hex");
        if (seen.has(hash) || found.has(hash)) continue;
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > budget) {
          unread.too_large.push({ path, tool, hash });
          continue;
        }
        budget -= bytes;
        let families, severity;
        try {
          const hits = scan(text);
          families = INJECTION_FAMILIES.filter((family) => hits.some((hit) => hit.family === family));
          severity = hits.some((hit) => hit.severity === "high") ? "high" : "low";
        } catch {
          unread.scan_failed.push({ path, tool, hash });
          continue;
        }
        if (!families.length) continue;
        events.push({
          kind: "injection_finding", at: now(), source: "tool_result", path,
          ...(tool ? { tool } : {}),
          families, severity,
          detector: INJECTION_DETECTOR, normalization_version: INJECTION_NORMALIZATION, block_sha256: hash,
        });
        found.add(hash);
      }
    }
    // Gaps first: at most one per kind, and the hold depends on them as on a strong tell.
    const gaps = Object.entries(unread).filter(([, leaves]) => leaves.length).map(([gap, leaves]) => gapEvent(gap, leaves, now()))
      .filter((e) => !seen.has(e.block_sha256));
    const kept = [...gaps, ...events.filter((e) => e.severity === "high"), ...events.filter((e) => e.severity !== "high")].slice(0, MAX_FINDINGS);
    // Only what is uploaded is seen: a block past the cap is found again by a later hook.
    for (const event of kept) seen.add(event.block_sha256);
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    return kept;
  } catch {
    // The hook as a whole went unread. Nothing identifies it, so the gap is new each
    // time: in hold mode that holds, the safe side for a failure this rare.
    try {
      const path = input.hook_event_name === "PostToolUse" ? "tool_response" : "tool_calls";
      return [gapEvent("scan_failed", [{ path, hash: randomBytes(32).toString("hex") }], Date.now())];
    } catch {
      return [];
    }
  }
}

const HOOK_NAME = /"hook_event_name"\s*:\s*"([A-Za-z]{1,64})"/;
// A tool's own fields. A name that comes after one may be inside the tool's output.
const TOOL_FIELD = /"(?:tool_response|tool_output|tool_calls|tool_input|output)"\s*:/;

/**
 * A hook body over the sidecar's limit is refused unread (cli/sidecar.mjs). Unless its
 * start plainly names a hook that carries no tool output, that output went unchecked:
 * one too_large gap, from the start of the body (`head`) and a SHA-256 of all of it.
 * Never throws.
 */
export function gapFromOversizedHook(head, bodySha256, { seen = new Set(), now = Date.now } = {}) {
  try {
    const match = HOOK_NAME.exec(head);
    const toolField = TOOL_FIELD.exec(head);
    // Claude Code and Codex both send the hook's name before the tool's fields.
    const name = match && !(toolField && toolField.index < match.index) ? match[1] : undefined;
    if (name && name !== "PostToolBatch" && name !== "PostToolUse") return null;
    const path = name === "PostToolBatch" ? "tool_calls" : name === "PostToolUse" ? "tool_response" : "hook_input";
    const event = gapEvent("too_large", [{ path, hash: bodySha256 }], now());
    if (seen.has(event.block_sha256)) return null;
    seen.add(event.block_sha256);
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    return event;
  } catch {
    return null;
  }
}
