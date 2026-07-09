#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { ed25519 } from "@noble/curves/ed25519";
import {
  CONFIG_FILE,
  OPENAI_SHAPE_PROVIDERS,
  PROVIDERS,
  config,
  configPathLabel,
  defaultModelForProvider,
  fail,
  formatChallengeError,
  formatProxyError,
  globalConfigPath,
  ok,
  redact,
  requireControlApiKey,
  requirePassport,
  step,
  writeConfigFile,
} from "../cli/config.mjs";
import { startSidecar } from "../cli/sidecar.mjs";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

function parseArgv(argv) {
  const opts = {};
  const rest = [];
  const optKey = (key) => key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--") {
      rest.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      opts[optKey(arg.slice(2, eq))] = arg.slice(eq + 1);
      continue;
    }

    const key = optKey(arg.slice(2));
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { opts, rest };
}

function cliPrefix() {
  return process.env.npm_lifecycle_event === "cli" ? "npm run cli --" : "passcontrol";
}

function cliCommand(args = "") {
  return args ? `${cliPrefix()} ${args}` : cliPrefix();
}

function usage() {
  const cmd = cliPrefix();
  return `PassControl

Usage:
  ${cmd}                         show cockpit status
  ${cmd} init [--global]          create a config profile
  ${cmd} status [--no-network]    show active config
  ${cmd} doctor [--deep]          check local setup
  ${cmd} call "hi"                mint a visa and call a model
  ${cmd} sidecar [--port 8788]    start the local agent bridge
  ${cmd} env [openhands]          print sidecar settings for agents
  ${cmd} agent list               list agents
  ${cmd} agent create <name>      create an agent passport
  ${cmd} agent suspend <id>       suspend an agent
  ${cmd} agent resume <id>        resume an agent
  ${cmd} agent revoke <id>        revoke an agent
  ${cmd} spend                    show fleet + per-agent spend
  ${cmd} audit [--limit 20]        show admin audit trail
  ${cmd} logs [--limit 20]         show gateway call logs
  ${cmd} kill on|off              toggle tenant kill switch
  ${cmd} open                     open the dashboard

Config:
  Env vars win, then nearest .passcontrol, then ~/.config/passcontrol/config.
`;
}

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Use one of: ${PROVIDERS.join(", ")}.`);
  }
}

function activeModel(provider, opts = {}) {
  if (opts.model) return opts.model;
  if (process.env.MODEL) return process.env.MODEL;
  if (provider === config.provider) return config.model;
  return defaultModelForProvider(provider);
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function gatewayStatus(noNetwork = false) {
  if (noNetwork) return { label: "not checked", ok: null };
  try {
    const res = await fetchWithTimeout(config.gateway, { method: "GET" });
    return { label: `online (${res.status})`, ok: true };
  } catch {
    return { label: "offline or unreachable", ok: false };
  }
}

async function printCockpit({ noNetwork = false } = {}) {
  const gateway = await gatewayStatus(noNetwork);
  const passportConfigured = Boolean(config.passportId && config.passportSecret);
  const adminConfigured = Boolean(config.apiKey);

  console.log("PassControl\n");
  console.log(`Gateway:  ${gateway.label}  ${config.gateway}`);
  console.log(`Config:   ${configPathLabel(config.sources)}`);
  console.log(`Provider: ${config.provider}`);
  console.log(`Model:    ${config.model}`);
  console.log(`Passport: ${passportConfigured ? redact(config.passportId) : "missing"}`);
  console.log(`Admin key: ${adminConfigured ? redact(config.apiKey, 6) : "missing"}`);
  console.log(`Sidecar:  foreground command (\`${cliCommand("sidecar")}\`)\n`);
  console.log("Next commands:");
  console.log(`  ${cliCommand("init")}              configure this project`);
  console.log(`  ${cliCommand('call "hi"')}         test a governed model call`);
  console.log(`  ${cliCommand("sidecar")}           start the local agent bridge`);
  console.log(`  ${cliCommand("agent list")}        list agents`);
  console.log(`  ${cliCommand("spend")}             show fleet spend`);
  console.log(`  ${cliCommand("env openhands")}     print agent settings`);
  console.log(`  ${cliCommand("doctor")}            check setup`);
  console.log(`  ${cliCommand("open")}              open dashboard`);
}

async function initCommand(opts) {
  if (!process.stdin.isTTY) {
    throw new Error("`passcontrol init` needs an interactive terminal. Or copy .passcontrol.example to .passcontrol and edit it.");
  }

  const target = opts.global ? globalConfigPath() : path.join(process.cwd(), CONFIG_FILE);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (fs.existsSync(target)) {
      const overwrite = await rl.question(`${target} already exists. Overwrite? [y/N]: `);
      if (!/^y(es)?$/i.test(overwrite.trim())) {
        ok("left existing config unchanged");
        return;
      }
    }

    console.log("PassControl init");
    if (opts.global) {
      console.log("Saving a global profile. Only do this on a machine you trust.\n");
    } else {
      console.log("Saving a project-local .passcontrol file.\n");
    }

    const ask = async (label, fallback = "") => {
      const suffix = fallback ? ` [${fallback}]` : "";
      const answer = await rl.question(`${label}${suffix}: `);
      return answer.trim() || fallback;
    };

    const provider = await ask("Provider", config.provider || "anthropic");
    assertProvider(provider);
    const modelFallback = provider === config.provider ? config.model : defaultModelForProvider(provider);
    const values = {
      PASSCONTROL_GATEWAY: await ask("Gateway URL", config.gateway),
      PASSPORT_ID: await ask("Passport ID", config.passportId),
      PASSPORT_SECRET: await ask("Passport Secret (input is visible)", config.passportSecret),
      PASSCONTROL_API_KEY: await ask("Control API key (optional, input is visible)", config.apiKey),
      PROVIDER: provider,
      MODEL: await ask("Model", modelFallback),
    };

    writeConfigFile(target, values);
    ok(`saved ${target}`);
  } finally {
    rl.close();
  }
}

async function mintVisa(current = config) {
  const { passportId, passportSecret } = requirePassport(current);
  const payloadObj = { passport_id: passportId, ts: Date.now(), nonce: crypto.randomUUID() };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(passportSecret)));
  const res = await fetch(`${current.gateway}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature }),
  });
  if (!res.ok) throw new Error(formatChallengeError(res.status, await res.text()));
  const data = await res.json();
  if (!data.visa) throw new Error("Challenge returned no visa.");
  return data;
}

function requestFor(provider, model, prompt) {
  if (provider === "anthropic") {
    return {
      path: "v1/messages",
      body: { model, max_tokens: 128, stream: true, messages: [{ role: "user", content: prompt }] },
    };
  }
  if (OPENAI_SHAPE_PROVIDERS.has(provider)) {
    return {
      path: "chat/completions",
      body: { model, stream: true, messages: [{ role: "user", content: prompt }] },
    };
  }
  throw new Error(`Provider ${provider} is not supported by the CLI call command yet.`);
}

function extractDelta(json) {
  return json?.delta?.text ?? json?.choices?.[0]?.delta?.content ?? "";
}

async function streamResponse(res) {
  if (!res.body) {
    console.log(await res.text());
    return;
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
        // Keep-alives and provider-specific comments can safely be ignored.
      }
    }
  }
  console.log("");
}

async function callCommand(rest, opts) {
  const provider = String(opts.provider || config.provider);
  assertProvider(provider);
  const model = activeModel(provider, opts);
  const prompt = rest.join(" ") || process.env.PROMPT || "Say hello in exactly 3 words.";
  requirePassport(config);
  step(`${provider}/${model} via ${config.gateway}`);
  step(`prompt: ${prompt}\n`);

  const { visa, expires_in } = await mintVisa(config);
  ok(`minted visa (expires in ${expires_in ?? 300}s)`);

  const { path: proxyPath, body } = requestFor(provider, model, prompt);
  const res = await fetch(`${config.gateway}/api/v1/${provider}/${proxyPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${visa}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(formatProxyError(res.status, await res.text()));
  await streamResponse(res);
  ok("done - check the dashboard audit log + spend for this call.");
}

async function api(method, pathPart, body) {
  const apiKey = requireControlApiKey(config);
  const res = await fetch(`${config.gateway}/api/control/v1${pathPart}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
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
    throw new Error(`${res.status} ${e.code ?? ""} ${e.message ?? ""} (req ${e.request_id ?? "?"})`);
  }
  return json.data;
}

function controlPath(pathPart, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  const suffix = qs.toString();
  return suffix ? `${pathPart}?${suffix}` : pathPart;
}

function usd(microcents) {
  return `$${(Number(microcents ?? 0) / 100_000_000).toFixed(6)}`;
}

function safeLimit(raw, fallback = 20) {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

async function agentCommand(rest, opts) {
  const [sub, ...args] = rest;
  switch (sub) {
    case "list": {
      const agents = await api("GET", "/agents");
      console.table(
        agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          tokens: a.spent_tokens,
          usd: a.spent_microcents === undefined ? undefined : usd(a.spent_microcents),
        }))
      );
      break;
    }
    case "create": {
      const name = args[0];
      if (!name) throw new Error("Usage: passcontrol agent create <name>");
      const provider = String(opts.provider || config.provider);
      assertProvider(provider);
      const scopeModel = String(opts.scope || (provider === "anthropic" ? "claude-*" : activeModel(provider, opts)));
      const priv = ed25519.utils.randomPrivateKey();
      const pub = ed25519.getPublicKey(priv);
      const passportId = b64url(pub);
      const created = await api("POST", "/agents", {
        name,
        passportPubkey: passportId,
        scopes: [{ provider, models: [scopeModel] }],
      });
      ok(`created agent ${created.id} (${created.name})`);
      step("Store these - the secret is shown once and is the agent's passport:");
      console.log(`  PASSPORT_ID=${passportId}`);
      console.log(`  PASSPORT_SECRET=${b64url(priv)}`);
      step("Paste them into .passcontrol, then run `passcontrol call \"hi\"`.");
      break;
    }
    case "suspend":
      if (!args[0]) throw new Error("Usage: passcontrol agent suspend <id>");
      console.log(await api("POST", `/agents/${encodeURIComponent(args[0])}/suspend`));
      break;
    case "resume":
      if (!args[0]) throw new Error("Usage: passcontrol agent resume <id>");
      console.log(await api("POST", `/agents/${encodeURIComponent(args[0])}/resume`));
      break;
    case "revoke":
      if (!args[0]) throw new Error("Usage: passcontrol agent revoke <id>");
      console.log(await api("DELETE", `/agents/${encodeURIComponent(args[0])}`));
      break;
    default:
      throw new Error("Usage: passcontrol agent list|create <name>|suspend <id>|resume <id>|revoke <id>");
  }
}

async function spendCommand() {
  const data = await api("GET", "/spend");
  console.log(`fleet: ${data.fleet.spent_tokens} tokens · ${usd(data.fleet.spent_microcents)}`);
  console.table(
    data.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      tokens: agent.spent_tokens,
      usd: usd(agent.spent_microcents),
    }))
  );
}

async function auditCommand(opts) {
  const events = await api("GET", controlPath("/audit", { limit: safeLimit(opts.limit) }));
  console.table(
    events.map((event) => ({
      at: event.created_at,
      action: event.action,
      target: event.target_id,
      request: event.request_id,
    }))
  );
}

async function logsCommand(opts) {
  const rows = await api(
    "GET",
    controlPath("/logs", {
      limit: safeLimit(opts.limit),
      agent_id: opts.agentId,
      status: opts.status,
    })
  );
  console.table(
    rows.map((row) => ({
      at: row.created_at,
      agent: row.agent_id,
      provider: row.provider,
      model: row.model,
      status: row.status,
      in: row.input_tokens,
      out: row.output_tokens,
      total: row.total_tokens,
      usd: usd(row.cost_microcents),
    }))
  );
}

async function killCommand(rest) {
  const mode = rest[0];
  if (mode !== "on" && mode !== "off") throw new Error("Usage: passcontrol kill on|off");
  const data = await api("PUT", "/kill-switch", { armed: mode === "on" });
  ok(`kill switch ${data.armed ? "armed" : "disarmed"} (${data.affected ?? 0} affected)`);
}

async function sidecarCommand(rest, opts) {
  if (rest[0] === "status") {
    step("The sidecar runs as a foreground process.");
    step("If it is running, your agent should point at http://127.0.0.1:8788/api/v1/anthropic or /api/v1/openai.");
    return;
  }

  const { passportId, passportSecret } = requirePassport(config);
  startSidecar({
    gateway: config.gateway,
    passportId,
    passportSecret,
    port: Number(opts.port ?? process.env.SIDECAR_PORT ?? 8788),
    host: String(opts.host ?? process.env.SIDECAR_HOST ?? "127.0.0.1"),
    refreshSkewSeconds: Number(opts.refreshSkewSeconds ?? process.env.REFRESH_SKEW_SECONDS ?? 30),
  });

  if (opts.for) {
    console.log("");
    printAgentPreset(String(opts.for), opts);
  }
}

function sidecarBaseUrl(opts = {}) {
  const provider = String(opts.provider || config.provider);
  assertProvider(provider);
  const host = String(opts.host ?? process.env.SIDECAR_HOST ?? "127.0.0.1");
  const port = Number(opts.port ?? process.env.SIDECAR_PORT ?? 8788);
  return {
    provider,
    model: activeModel(provider, opts),
    apiKey: "passcontrol",
    baseUrl: `http://${host}:${port}/api/v1/${provider}`,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function printExports(values) {
  for (const [key, value] of values) {
    console.log(`export ${key}=${shellQuote(value)}`);
  }
}

function printAgentPreset(name = "generic", opts = {}) {
  const preset = name.toLowerCase();
  const { provider, model, apiKey, baseUrl } = sidecarBaseUrl(opts);
  const modelWithProvider = `${provider}/${model}`;
  const sidecarStart = opts.port ? cliCommand(`sidecar --port ${opts.port}`) : cliCommand("sidecar");

  console.log(`# Start the bridge first: ${sidecarStart}`);
  switch (preset) {
    case "openhands":
      console.log("# OpenHands / LiteLLM-compatible starting point:");
      printExports([
        ["LLM_BASE_URL", baseUrl],
        ["LLM_API_KEY", apiKey],
        ["LLM_MODEL", modelWithProvider],
      ]);
      break;
    case "litellm":
      console.log("# LiteLLM-compatible starting point:");
      printExports([
        ["LITELLM_BASE_URL", baseUrl],
        ["LITELLM_API_KEY", apiKey],
        ["LITELLM_MODEL", modelWithProvider],
      ]);
      break;
    case "aider":
      console.log("# Aider OpenAI-compatible starting point:");
      printExports([
        ["OPENAI_API_BASE", baseUrl],
        ["OPENAI_API_KEY", apiKey],
        ["AIDER_MODEL", modelWithProvider],
      ]);
      break;
    case "cline":
    case "continue":
      console.log(`# ${preset} UI settings:`);
      console.log(`Base URL: ${baseUrl}`);
      console.log(`API key:  ${apiKey}`);
      console.log(`Model:    ${modelWithProvider}`);
      break;
    case "generic":
      console.log("# Generic sidecar settings:");
      printExports([
        ["PASSCONTROL_SIDECAR_BASE_URL", baseUrl],
        ["PASSCONTROL_SIDECAR_API_KEY", apiKey],
        ["PASSCONTROL_MODEL", modelWithProvider],
      ]);
      break;
    default:
      throw new Error("Usage: passcontrol env [generic|openhands|litellm|aider|cline|continue]");
  }
}

async function doctorCommand(opts = {}) {
  const gateway = await gatewayStatus(false);
  console.log("PassControl doctor\n");
  (gateway.ok ? ok : fail)(`Gateway ${gateway.label}: ${config.gateway}`);
  (config.passportId && config.passportSecret ? ok : fail)(
    `Passport ${config.passportId && config.passportSecret ? "configured" : "missing"}`
  );
  (config.apiKey ? ok : step)(`Control API key ${config.apiKey ? "configured" : "missing (needed only for agent/kill commands)"}`);
  step(`Config source: ${configPathLabel(config.sources)}`);

  if (!opts.deep) return;

  console.log("");
  step("Deep checks");
  if (config.passportId && config.passportSecret) {
    try {
      const visa = await mintVisa(config);
      ok(`Visa mint works (expires in ${visa.expires_in ?? 300}s)`);
    } catch (error) {
      fail(`Visa mint failed: ${error.message}`);
    }
  } else {
    step("Skipping visa mint check: no passport configured.");
  }

  if (config.apiKey) {
    try {
      const kill = await api("GET", "/kill-switch");
      ok(`Control API works (kill switch ${kill.armed ? "armed" : "off"})`);
    } catch (error) {
      fail(`Control API check failed: ${error.message}`);
    }
  } else {
    step("Skipping control API check: no PASSCONTROL_API_KEY configured.");
  }
}

function openDashboard() {
  const url = config.gateway;
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => step(`Open this URL: ${url}`));
  child.unref();
  ok(`opening ${url}`);
}

async function main() {
  const { opts, rest } = parseArgv(process.argv.slice(2));
  const [command, ...commandRest] = rest;

  if (opts.help || command === "help") {
    console.log(usage());
    return;
  }
  if (opts.version || command === "version") {
    console.log("passcontrol 0.1.0");
    return;
  }

  switch (command) {
    case undefined:
    case "status":
      await printCockpit({ noNetwork: Boolean(opts.noNetwork) });
      break;
    case "init":
      await initCommand(opts);
      break;
    case "doctor":
      await doctorCommand(opts);
      break;
    case "call":
      await callCommand(commandRest, opts);
      break;
    case "sidecar":
      await sidecarCommand(commandRest, opts);
      break;
    case "env":
      printAgentPreset(commandRest[0] || "generic", opts);
      break;
    case "agent":
    case "fleet":
      await agentCommand(commandRest, opts);
      break;
    case "spend":
      await spendCommand();
      break;
    case "audit":
      await auditCommand(opts);
      break;
    case "logs":
      await logsCommand(opts);
      break;
    case "kill":
      await killCommand(commandRest);
      break;
    case "open":
      openDashboard();
      break;
    default:
      throw new Error(`Unknown command "${command}". Run \`passcontrol help\`.`);
  }
}

main().catch((error) => {
  fail(error.message);
  process.exit(1);
});
