// Local, best-effort tool-result scan. Only fixed metadata and a hash leave here.
import { createHash } from "node:crypto";
import { scanText, INJECTION_DETECTOR, INJECTION_NORMALIZATION, INJECTION_FAMILIES } from "./injection-scan.mjs";

const MAX_LEAF_BYTES = 1024 * 1024;
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

/** `seen` belongs to one sidecar; no text or hook input is retained. Never throws.
 * `scan` is injectable for failure tests. Failed scans emit nothing and do not
 * consume hashes, allowing a later hook to retry.
 */
export function findingsFromHook(input, { seen = new Set(), now = Date.now, scan = scanText } = {}) {
  const events = [];
  const found = new Set();
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
    for (const [call, response, root] of calls) {
      if (events.length >= MAX_FINDINGS) break;
      for (const [text, path] of stringLeaves(response, root)) {
        if (Buffer.byteLength(text, "utf8") > MAX_LEAF_BYTES) continue;
        const hash = createHash("sha256").update(text, "utf8").digest("hex");
        if (seen.has(hash) || found.has(hash)) continue;
        const hits = scan(text);
        const families = INJECTION_FAMILIES.filter((family) => hits.some((hit) => hit.family === family));
        if (!families.length) continue;
        events.push({
          kind: "injection_finding", at: now(), source: "tool_result", path,
          ...(typeof call.tool_name === "string" && TOOL.test(call.tool_name) ? { tool: call.tool_name } : {}),
          families, severity: hits.some((hit) => hit.severity === "high") ? "high" : "low",
          detector: INJECTION_DETECTOR, normalization_version: INJECTION_NORMALIZATION, block_sha256: hash,
        });
        found.add(hash);
        if (events.length >= MAX_FINDINGS) break;
      }
    }
    for (const hash of found) seen.add(hash);
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    return events;
  } catch {
    return [];
  }
}
