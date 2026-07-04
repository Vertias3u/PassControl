// PassControl — STARTER AGENT (be user #1).
//
// A real tool-using agent: it mints a visa, then runs a think→call-tool→think loop
// THROUGH your gateway. Every model round-trip is a proxied call, so you can watch
// the audit log fill, budget burn, and (if you arm it) the kill switch bite — i.e.
// you get to *experience* the product the way your users will.
//
// Run (after: provider key added in the dashboard + a passport issued):
//   PASSCONTROL_GATEWAY=http://localhost:3000 \
//   PASSPORT_ID=<base64url pubkey> PASSPORT_SECRET=<base64url privkey> \
//   node examples/starter-agent.mjs
//
// Get PASSPORT_ID/SECRET from the dashboard "Issue passport" modal, or:
//   node examples/fleet-admin.mjs create my-first-agent
import { ed25519 } from "@noble/curves/ed25519";

const GATEWAY = (process.env.PASSCONTROL_GATEWAY ?? "http://localhost:3000").replace(/\/+$/, "");
const PASSPORT_ID = process.env.PASSPORT_ID;
const PASSPORT_SECRET = process.env.PASSPORT_SECRET;
const MODEL = process.env.MODEL ?? "claude-haiku-4-5";
const MAX_TURNS = 6;

if (!PASSPORT_ID || !PASSPORT_SECRET) {
  console.error("Set PASSPORT_ID and PASSPORT_SECRET (from the dashboard / fleet-admin create).");
  process.exit(1);
}

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

// ── 1. Mint a work-visa (sign a challenge with the passport) ──────────────────
async function mintVisa() {
  const obj = { passport_id: PASSPORT_ID, ts: Date.now(), nonce: crypto.randomUUID() };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(PASSPORT_SECRET)));
  const res = await fetch(`${GATEWAY}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 && body.includes("agent_not_active")) {
      throw new Error(
        "this agent is suspended or revoked — re-enable it in the dashboard (or `node examples/fleet-admin.mjs resume <id>`)."
      );
    }
    throw new Error(`challenge failed: ${res.status} ${body}`);
  }
  return (await res.json()).visa;
}

// ── 2. The agent's tools (run locally; the model decides when to call them) ───
const tools = [
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "calculate",
    description: "Evaluate a basic arithmetic expression, e.g. '240 * 0.18'.",
    input_schema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
];

function runTool(name, input) {
  if (name === "get_weather") {
    // Mock — a real agent would hit a weather API here.
    const temps = { sofia: "21°C, clear", london: "13°C, drizzle", tokyo: "26°C, humid" };
    return temps[String(input.city ?? "").toLowerCase()] ?? "18°C, partly cloudy";
  }
  if (name === "calculate") {
    const expr = String(input.expression ?? "");
    if (!/^[0-9+\-*/(). %]+$/.test(expr)) return "refused: unsafe expression";
    try {
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${expr.replace(/%/g, "/100")})`)();
      // Trim binary-float noise (43.199999999999996 -> 43.2) without forcing decimals.
      return typeof result === "number" ? String(Math.round(result * 1e6) / 1e6) : String(result);
    } catch {
      return "error: could not evaluate";
    }
  }
  return "unknown tool";
}

// ── 3. Call the model THROUGH PassControl (visa as the key) ───────────────────
async function callModel(visa, messages) {
  const res = await fetch(`${GATEWAY}/api/v1/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${visa}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 512, tools, messages }),
  });
  if (res.status === 402) throw new Error("BUDGET — the gateway blocked this call (402). Your budget cap works!");
  if (res.status === 403) throw new Error("BLOCKED — kill switch / suspended / scope (403). Revocation works!");
  if (!res.ok) throw new Error(`proxy ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── 4. The agent loop: think → (maybe) call tools → think → … → answer ────────
async function main() {
  console.log(`PassControl starter agent → ${MODEL} via ${GATEWAY}\n`);
  const visa = await mintVisa();
  console.log("✓ visa minted\n");

  const messages = [
    {
      role: "user",
      content:
        "You are a helpful assistant with tools. What's the weather in Sofia, and what's an 18% tip on a 240 lev bill? Use your tools, then give one short summary.",
    },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const reply = await callModel(visa, messages);
    messages.push({ role: "assistant", content: reply.content });

    const toolUses = (reply.content ?? []).filter((b) => b.type === "tool_use");
    const text = (reply.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text) console.log(`🤖 ${text}\n`);

    if (reply.stop_reason !== "tool_use" || toolUses.length === 0) {
      console.log("✓ agent finished.");
      break;
    }

    const results = [];
    for (const tu of toolUses) {
      const out = runTool(tu.name, tu.input);
      console.log(`🔧 ${tu.name}(${JSON.stringify(tu.input)}) → ${out}`);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    console.log("");
    messages.push({ role: "user", content: results });
  }

  console.log("\nNow open the dashboard — you should see the audit rows + spend from this run.");
  console.log("Try it again after arming the kill switch (fleet-admin.mjs kill on) to watch it get blocked.");
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
