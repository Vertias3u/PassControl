// The canonical PassControl integration: an existing worker that uses the
// official OpenAI SDK, pointed at PassControl with a Direct Agent Key.
//
// Nothing in the worker changes except two environment variables. The Setup
// page in the dashboard (agent → Setup) writes exactly the file this reads:
//
//   OPENAI_BASE_URL=https://<your PassControl>/api/v1/<provider>/v1
//   OPENAI_API_KEY=pc_agent_…            ← the Direct Agent Key, not a provider key
//   OPENAI_MODEL=<a model this agent is allowed to call>
//
// Run it from a checkout (the `openai` package is already a dev dependency):
//
//   set -a; . ./passcontrol.env; set +a
//   node examples/direct-key-worker.mjs
//
// It does two things and says exactly what came back:
//   1. One governed call with OPENAI_MODEL — the provider answers, PassControl
//      injects the real provider key and records the call.
//   2. One call with REFUSAL_MODEL, a model this agent is NOT allowed to call —
//      PassControl refuses it before anything reaches the provider.
//
// Every model call goes through PassControl; this script never holds the
// provider key and never prints the Direct Agent Key.
//
// Optional: REFUSAL_MODEL (default "passcontrol-refusal-demo"), PROMPT.
// Other providers' OpenAI-compatible routes work the same way; for native
// Anthropic use the Anthropic SDK variant the Setup page shows.
import OpenAI from "openai";

const baseURL = process.env.OPENAI_BASE_URL?.trim();
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim();
const refusalModel = process.env.REFUSAL_MODEL?.trim() || "passcontrol-refusal-demo";
const prompt = process.env.PROMPT?.trim() || "Reply with: PassControl connected";

const DIRECT_AGENT_KEY = /^pc_agent_[A-Za-z0-9_-]{43}$/;

function stop(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!baseURL || !apiKey || !model) {
  stop(
    "Set OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL. The agent's Setup page in the " +
      "PassControl dashboard gives you the file: save it as passcontrol.env, then run " +
      "`set -a; . ./passcontrol.env; set +a`."
  );
}
if (!DIRECT_AGENT_KEY.test(apiKey)) {
  stop(
    apiKey === "PASTE_YOUR_DIRECT_AGENT_KEY"
      ? "OPENAI_API_KEY is still the placeholder. Paste the Direct Agent Key you saved when the agent was created."
      : "OPENAI_API_KEY is not a Direct Agent Key (pc_agent_…). Use the key PassControl issued for this agent, not a provider key."
  );
}
if (!/\/api\/v1\/[a-z0-9-]+(\/|$)/.test(new URL(baseURL).pathname)) {
  stop("OPENAI_BASE_URL should be your PassControl origin followed by /api/v1/<provider>/v1, as the Setup page shows.");
}
if (refusalModel === model) {
  stop("REFUSAL_MODEL must be a model this agent is NOT allowed to call, so it cannot equal OPENAI_MODEL.");
}

// No automatic retries: the SDK retries 409 and 5xx by default, and a retried
// governed call is a second call against the agent's caps.
const client = new OpenAI({ baseURL, apiKey, maxRetries: 0 });

/** A PassControl decision carries a string code; a provider error carries an object. */
function describeFailure(error) {
  if (!(error instanceof OpenAI.APIError) || !error.status) {
    return { source: "network", text: `could not reach ${baseURL} (${error?.message ?? error})` };
  }
  const receipt = error.headers?.get?.("x-passcontrol-receipt-id") ?? null;
  if (typeof error.error === "string") {
    return { source: "passcontrol", status: error.status, code: error.error, receipt };
  }
  return { source: "provider", status: error.status, text: error.message, receipt };
}

const HINTS = {
  invalid_credential: "PassControl did not accept the key (wrong, revoked or expired). No call record is written for it.",
  blocked_scope: "the model is outside this agent's allowed access.",
  blocked_suspended: "the agent is suspended.",
  blocked_killed: "the workspace kill switch is armed.",
  blocked_budget: "the agent's cumulative cap would be exceeded.",
  no_provider_key: "this workspace has no stored credential for this provider.",
};

console.log(`PassControl gateway: ${new URL(baseURL).origin}`);
console.log(`Agent key:           pc_agent_…${apiKey.slice(-8)}\n`);

// 1 — the governed call.
let allowedOk = false;
try {
  const { data, response } = await client.chat.completions
    .create({ model, messages: [{ role: "user", content: prompt }] })
    .withResponse();
  const receipt = response.headers.get("x-passcontrol-receipt-id");
  const reply = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage ? `${data.usage.prompt_tokens} in / ${data.usage.completion_tokens} out` : "not reported";
  console.log(`1. ${model}: allowed and forwarded`);
  console.log(`   reply:   ${JSON.stringify(reply.slice(0, 120))}`);
  console.log(`   usage:   ${usage} (as the provider reported it)`);
  console.log(`   receipt: ${receipt ?? "no receipt ID returned"}`);
  allowedOk = true;
} catch (error) {
  const f = describeFailure(error);
  if (f.source === "passcontrol") {
    console.log(`1. ${model}: refused by PassControl — HTTP ${f.status} ${f.code}`);
    if (HINTS[f.code]) console.log(`   ${HINTS[f.code]}`);
  } else if (f.source === "provider") {
    console.log(`1. ${model}: forwarded, and the provider answered with an error — HTTP ${f.status}`);
    console.log(`   ${f.text}`);
  } else {
    console.log(`1. ${model}: ${f.text}`);
  }
}

// 2 — the deliberate refusal.
let refusedOk = false;
try {
  await client.chat.completions.create({ model: refusalModel, messages: [{ role: "user", content: prompt }] });
  // Admitted: this agent's access covers REFUSAL_MODEL (a wildcard grant, say).
  // That is not a refusal, and this script does not pretend it was one.
  console.log(`\n2. ${refusalModel}: ALLOWED — this agent's access includes it, so nothing was refused.`);
  console.log("   Set REFUSAL_MODEL to a model outside the agent's allowed models to see a refusal.");
} catch (error) {
  const f = describeFailure(error);
  if (f.source === "passcontrol" && f.code === "blocked_scope") {
    console.log(`\n2. ${refusalModel}: refused by PassControl — HTTP ${f.status} blocked_scope`);
    console.log("   Outside this agent's allowed access. Nothing was sent to the provider.");
    console.log(`   receipt: ${f.receipt ?? "no receipt ID returned"}`);
    refusedOk = true;
  } else if (f.source === "passcontrol") {
    console.log(`\n2. ${refusalModel}: refused by PassControl, but not for its access — HTTP ${f.status} ${f.code}`);
    if (HINTS[f.code]) console.log(`   ${HINTS[f.code]}`);
  } else if (f.source === "provider") {
    // Forwarded: the grant admitted it and the provider rejected the name.
    console.log(`\n2. ${refusalModel}: NOT refused by PassControl — it was forwarded and the provider answered HTTP ${f.status}.`);
    console.log("   This agent's access admits that model name. Narrow the allowed models, or pick another REFUSAL_MODEL.");
  } else {
    console.log(`\n2. ${refusalModel}: ${f.text}`);
  }
}

console.log(
  allowedOk && refusedOk
    ? "\n✓ Both calls are in the dashboard's call history for this agent: one forwarded, one refused."
    : "\n✗ Not the expected pair (one forwarded, one refused by allowed access). See the lines above."
);
process.exit(allowedOk && refusedOk ? 0 : 1);
