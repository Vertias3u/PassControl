// The sidecar's tripwire checks (idea 12). Local, digest-only: the sidecar reads the
// manifest `configure tripwires` wrote (digests, never decoys), so nothing it sends can
// carry a decoy, and nothing it holds is one.
//
//   * Used: a request the sidecar relays carries a planted decoy in a credential header.
//     The sidecar strips credentials before forwarding (that is its job), so this is the
//     only place such a decoy can be seen. The request is refused locally with the same 401
//     an unknown key gets, and reported; the gateway stops the decoy's agent and this one.
//   * Seen: a planted decoy appears in tool output a PostToolBatch/PostToolUse hook hands
//     the model (subscription mode, where the gateway never sees model traffic).
//   * Heartbeat: the scan is running, at most once per HEARTBEAT_MS (coverage, not safety).
import { createHash } from "node:crypto";
import { candidatesInJson, credentialHeaderTexts } from "./tripwire-scan.mjs";

export const TRIPWIRE_PATH = "/api/v1/tripwire";
export const TRIPWIRE_SOURCE = "passcontrol-sidecar";
export const HEARTBEAT_MS = 10 * 60 * 1000;
const DECOY = /pc_agent_[A-Za-z0-9_-]{43}/g;

const digest = (value) => createHash("sha256").update(value, "utf8").digest("base64url");

/** The planted digest a credential-bearing header carries, or null. */
export function decoyInHeaders(headers, digests, isCredentialHeader) {
  if (!digests || digests.size === 0) return null;
  for (const [name, raw] of Object.entries(headers ?? {})) {
    if (!isCredentialHeader(name)) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      // Basic auth is decoded first: `pc_agent_` is not visible in its base64 (R12-10).
      for (const text of credentialHeaderTexts(value)) {
        if (!text.includes("pc_agent_")) continue;
        for (const m of text.matchAll(DECOY)) {
          const d = digest(m[0]);
          if (digests.has(d)) return d;
        }
      }
    }
  }
  return null;
}

/** Planted digests that appear in the tool output of a hook input. Never throws. */
export function decoysInHook(input, digests) {
  try {
    if (!digests || digests.size === 0) return [];
    let outputs = [];
    if (input?.hook_event_name === "PostToolBatch" && Array.isArray(input.tool_calls)) outputs = input.tool_calls.map((c) => c?.tool_response);
    else if (input?.hook_event_name === "PostToolUse") outputs = [input.tool_response ?? input.tool_output ?? input.output];
    else return [];
    const hits = new Set();
    for (const c of candidatesInJson(outputs).candidates) {
      const d = digest(c);
      if (digests.has(d)) hits.add(d);
    }
    return [...hits];
  } catch {
    return [];
  }
}

/**
 * Sends reports through the sidecar's authenticated path. `send(body)` posts JSON to
 * TRIPWIRE_PATH with the sidecar's visa and returns { status }. `used` is awaited so the
 * stop has happened (or is known to have failed) before the relayed request is answered.
 */
export function createTripwireReporter({ send, now = Date.now }) {
  let lastBeat = 0;
  const post = async (reports) => {
    try {
      return await send({ source: TRIPWIRE_SOURCE, reports });
    } catch {
      return { status: 0 };
    }
  };
  return {
    used: (digestValue, tools = []) => post([{ kind: "used", digest: digestValue, tools: tools.slice(-5) }]),
    seen: (digests) => (digests.length ? post(digests.slice(0, 20).map((d) => ({ kind: "seen", digest: d }))) : Promise.resolve({ status: 204 })),
    heartbeat: () => {
      if (now() - lastBeat < HEARTBEAT_MS) return Promise.resolve({ status: 204 });
      lastBeat = now();
      return post([{ kind: "heartbeat" }]);
    },
  };
}
