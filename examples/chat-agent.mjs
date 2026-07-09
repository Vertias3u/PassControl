// PassControl test agent — DATA PLANE.
//
// Exercises the full agent path end-to-end: signs a challenge with its passport,
// mints a short-lived visa, then calls a model THROUGH the gateway (which injects
// the real provider key and logs the call). Use this to generate real audit/spend
// rows and confirm the proxy works.
//
// Run:
//   cp .passcontrol.example .passcontrol   # fill PASSPORT_ID/PASSPORT_SECRET
//   node examples/chat-agent.mjs "Say hello in 3 words"
//
// Optional env: PROVIDER=anthropic|openai  MODEL=...  (sensible defaults below).
// Get a PASSPORT_ID/SECRET from the dashboard "Issue passport" modal (the private
// key is shown once), or mint one with fleet-admin.mjs `create`.
import { ed25519 } from "@noble/curves/ed25519";
import { config, fail, formatChallengeError, formatProxyError, ok, requirePassport, resolveModel, step } from "./_config.mjs";

const GATEWAY = config.gateway;
const { passportId: PASSPORT_ID, passportSecret: PASSPORT_SECRET } = requirePassport();
const PROVIDER = config.provider;
const MODEL = resolveModel(PROVIDER);
const PROMPT = process.argv.slice(2).join(" ") || process.env.PROMPT || "Say hello in exactly 3 words.";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

async function mintVisa() {
  const payloadObj = { passport_id: PASSPORT_ID, ts: Date.now(), nonce: crypto.randomUUID() };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(PASSPORT_SECRET)));
  const res = await fetch(`${GATEWAY}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(formatChallengeError(res.status, body));
  }
  const { visa, expires_in } = await res.json();
  ok(`minted visa (expires in ${expires_in}s)`);
  return visa;
}

function buildRequest() {
  if (PROVIDER === "openai") {
    return {
      path: "v1/chat/completions",
      body: { model: MODEL, stream: true, messages: [{ role: "user", content: PROMPT }] },
    };
  }
  return {
    path: "v1/messages",
    body: { model: MODEL, max_tokens: 128, stream: true, messages: [{ role: "user", content: PROMPT }] },
  };
}

// Pull the human-readable text out of either provider's SSE stream.
function extractDelta(json) {
  return (
    json?.delta?.text ?? // anthropic content_block_delta
    json?.choices?.[0]?.delta?.content ?? // openai
    ""
  );
}

async function main() {
  step(`${PROVIDER}/${MODEL} via ${GATEWAY}`);
  step(`prompt: ${PROMPT}\n`);
  const visa = await mintVisa();
  const { path, body } = buildRequest();

  const res = await fetch(`${GATEWAY}/api/v1/${PROVIDER}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${visa}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(formatProxyError(res.status, await res.text()));
  }

  process.stdout.write("\nresponse: ");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m || m[1] === "[DONE]") continue;
      try {
        process.stdout.write(extractDelta(JSON.parse(m[1])));
      } catch {
        /* keep-alive / non-JSON line */
      }
    }
  }
  console.log("");
  ok("done - check the dashboard audit log + spend for this call.");
}

main().catch((e) => {
  fail(e.message);
  process.exit(1);
});
