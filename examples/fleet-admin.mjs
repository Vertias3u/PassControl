// PassControl test agent — CONTROL PLANE.
//
// Drives the developer API (/api/control/v1) with a `pc_` API key: list/create/
// suspend/resume/revoke agents, read spend/audit, toggle the kill switch. Use this
// to set up test agents and exercise the control plane.
//
// Run:
//   cp .passcontrol.example .passcontrol   # fill PASSCONTROL_API_KEY
//   node examples/fleet-admin.mjs <command> [args]
//
// Commands:
//   list                      list agents
//   spend                     per-agent + fleet spend (micro-cents)
//   audit                     recent admin actions
//   create <name>            issue a NEW passport + create the agent (prints the
//                            private key ONCE — that's the new agent's passport)
//   suspend <id> | resume <id> | revoke <id>
//   kill on | kill off       arm/disarm the per-tenant master kill switch
//
// A `create`d agent's printed PASSPORT_ID/SECRET feed straight into chat-agent.mjs.
import { ed25519 } from "@noble/curves/ed25519";
import { config, die, fail, ok, requireControlApiKey, step } from "./_config.mjs";

const GATEWAY = config.gateway;
const API_KEY = requireControlApiKey();
const BASE = `${GATEWAY}/api/control/v1`;

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function usage() {
  return "Usage: node examples/fleet-admin.mjs list|spend|audit|create <name>|suspend <id>|resume <id>|revoke <id>|kill on|off";
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      ...(body ? { "content-type": "application/json" } : {}),
      // A stable Idempotency-Key per logical op makes retries safe.
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: { message: text || "non-JSON response" } };
  }
  if (!res.ok) {
    const e = json.error ?? {};
    const hint =
      res.status === 401 || res.status === 403
        ? " Check PASSCONTROL_API_KEY permissions, then retry."
        : res.status === 429
          ? " Wait for the rate limit window, then retry."
          : "";
    throw new Error(`${res.status} ${e.code ?? ""} ${e.message ?? ""} (req ${e.request_id ?? "?"}).${hint}`);
  }
  return json.data;
}

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "list": {
      const agents = await api("GET", "/agents");
      console.table(agents.map((a) => ({ id: a.id, name: a.name, status: a.status, tokens: a.spent_tokens })));
      break;
    }
    case "spend": {
      const s = await api("GET", "/spend");
      console.log(`fleet: ${s.fleet.spent_tokens} tokens · $${(s.fleet.spent_microcents / 1e8).toFixed(6)}`);
      console.table(s.agents.map((a) => ({ name: a.name, tokens: a.spent_tokens, usd: (a.spent_microcents / 1e8).toFixed(6) })));
      break;
    }
    case "audit": {
      const events = await api("GET", "/audit?limit=20");
      console.table(events.map((e) => ({ at: e.created_at, action: e.action, target: e.target_id })));
      break;
    }
    case "create": {
      const name = args[0];
      if (!name) throw new Error("Usage: node examples/fleet-admin.mjs create <name>");
      // Generate the passport IN THIS PROCESS; only the public key leaves.
      const priv = ed25519.utils.randomPrivateKey();
      const pub = ed25519.getPublicKey(priv);
      const passportId = b64url(pub);
      const created = await api("POST", "/agents", {
        name,
        passportPubkey: passportId,
        scopes: [{ provider: "anthropic", models: ["claude-*"] }],
      });
      ok(`created agent ${created.id} (${created.name})`);
      step("Store these - the secret is shown once and is the agent's passport:");
      console.log(`  PASSPORT_ID=${passportId}`);
      console.log(`  PASSPORT_SECRET=${b64url(priv)}`);
      step('Next: add them to .passcontrol, then run `node examples/chat-agent.mjs "hi"`.');
      break;
    }
    case "suspend":
      console.log(await api("POST", `/agents/${args[0]}/suspend`));
      break;
    case "resume":
      console.log(await api("POST", `/agents/${args[0]}/resume`));
      break;
    case "revoke":
      console.log(await api("DELETE", `/agents/${args[0]}`));
      break;
    case "kill": {
      const on = args[0] === "on";
      if (args[0] !== "on" && args[0] !== "off") throw new Error("usage: kill on|off");
      console.log(await api("PUT", "/kill-switch", { armed: on }));
      break;
    }
    default:
      die(`Unknown or missing command. ${usage()}`);
  }
}

main().catch((e) => {
  fail(e.message);
  process.exit(1);
});
