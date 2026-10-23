// Subscription mode for Codex (1.6.0, L5): PassControl's stops and tool rules reach a
// Codex session signed in with a ChatGPT plan, through Codex's command hooks.
//
// Three ways this fails OPEN without anyone seeing it, each pinned here:
//   * Codex's hooks.json is shared (Peras writes into it on this very machine), so
//     setup and removal touch only PassControl's own entries;
//   * on PreToolUse, Codex treats `continue`, `stopReason`, `suppressOutput` and
//     `permissionDecision: "ask"` as a FAILED hook and runs the tool. The sidecar's
//     answers are Claude Code's, which carry `continue: false` with every stop, so
//     the relay rebuilds Codex's answer from an allow-list;
//   * the relay never exits in a way Codex reads as a block it did not mean, and
//     prints nothing but its answer (plain stdout on a prompt becomes model context).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { afterEach, describe, expect, it } from "vitest";

import {
  codexHookAnswer,
  codexHookCommand,
  codexHookEntries,
  codexHooksPath,
  isPassControlCodexHook,
  probeCodexHookCommand,
  removeCodexHooks,
  runCodexHook,
  writeCodexHooks,
} from "../codex-hooks.mjs";
import { createSidecar } from "../sidecar.mjs";

const CLI_ENTRY = fileURLToPath(new URL("../../bin/passcontrol.mjs", import.meta.url));

const COMMAND = "passcontrol codex-hook --port 8791";
// The shape Peras writes (src/codex.mjs installCodex), with a neutral path.
const PERAS = "\"/usr/local/bin/node\" \"/Users/me/.peras/app/bin/peras.mjs\" codex-hook";
const perasFile = () => ({
  hooks: {
    PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: PERAS, timeout: 10 }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: PERAS, timeout: 10 }] }],
  },
});

const homes = [];
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-codex-hooks-"));
  homes.push(dir);
  return { CODEX_HOME: dir };
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("hooks.json: only PassControl's entries are ever touched", () => {
  it("writes a prompt hook and a tool hook, with timeouts the sidecar's waits fit inside", () => {
    const target = codexHooksPath({ env: home() });
    expect(writeCodexHooks({ target, command: COMMAND }).changed).toBe(true);
    expect(read(target)).toEqual(codexHookEntries(COMMAND));
    const { hooks } = read(target);
    expect(hooks.UserPromptSubmit[0].hooks[0]).toEqual({ type: "command", command: COMMAND, timeout: 5 });
    expect(hooks.PreToolUse[0]).toEqual({ matcher: ".*", hooks: [{ type: "command", command: COMMAND, timeout: 600 }] });
  });

  it("keeps Peras's hooks, and removal gives back exactly the file it found", () => {
    const target = codexHooksPath({ env: home() });
    fs.writeFileSync(target, JSON.stringify(perasFile(), null, 2));
    const original = read(target);
    writeCodexHooks({ target, command: COMMAND });
    const both = read(target);
    expect(both.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(both.hooks.UserPromptSubmit[0]).toEqual(original.hooks.UserPromptSubmit[0]);
    expect(both.hooks.PreToolUse).toHaveLength(2);
    expect(removeCodexHooks({ target }).changed).toBe(true);
    expect(read(target)).toEqual(original);
  });

  it("backs the file up once, the first time it writes into someone else's", () => {
    const target = codexHooksPath({ env: home() });
    fs.writeFileSync(target, JSON.stringify(perasFile()));
    const before = fs.readFileSync(target, "utf8");
    const first = writeCodexHooks({ target, command: COMMAND });
    expect(first.backupPath).toBe(`${target}.passcontrol-backup`);
    expect(fs.readFileSync(first.backupPath, "utf8")).toBe(before);
    expect(writeCodexHooks({ target, command: COMMAND.replace("8791", "8792") }).backupPath).toBeNull();
  });

  it("re-running it changes nothing, byte for byte: Codex trusts a hook by its hash", () => {
    const target = codexHooksPath({ env: home() });
    fs.writeFileSync(target, JSON.stringify(perasFile()));
    writeCodexHooks({ target, command: COMMAND });
    const once = fs.readFileSync(target, "utf8");
    expect(writeCodexHooks({ target, command: COMMAND }).changed).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(once);
  });

  it("a new port replaces PassControl's entry instead of adding a second one", () => {
    const target = codexHooksPath({ env: home() });
    writeCodexHooks({ target, command: COMMAND });
    writeCodexHooks({ target, command: COMMAND.replace("8791", "8792") });
    const { hooks } = read(target);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].hooks[0].command).toMatch(/--port 8792$/);
  });

  it("tells PassControl's hooks and Peras's apart, both ways", () => {
    expect(isPassControlCodexHook({ type: "command", command: COMMAND })).toBe(true);
    expect(isPassControlCodexHook({ type: "command", command: '"/usr/bin/node" "/x/bin/passcontrol.mjs" codex-hook --port 8788' })).toBe(true);
    expect(isPassControlCodexHook({ type: "command", command: PERAS })).toBe(false);
    expect(isPassControlCodexHook({ type: "command", command: "passcontrol statusline --port 8788" })).toBe(false);
    expect(isPassControlCodexHook({ type: "mcp_tool", command: COMMAND })).toBe(false);
    // Peras's own rule (src/codex.mjs `ours`) does not take ours for its own.
    expect(/peras\.mjs"? (codex-)?hook\b/.test(COMMAND)).toBe(false);
  });

  it("refuses a file that is not a hooks object, and writes nothing", () => {
    const target = codexHooksPath({ env: home() });
    fs.writeFileSync(target, "[1, 2]");
    expect(() => writeCodexHooks({ target, command: COMMAND })).toThrow(/not a hooks object/);
    expect(fs.readFileSync(target, "utf8")).toBe("[1, 2]");
    fs.writeFileSync(target, "{ not json");
    expect(() => writeCodexHooks({ target, command: COMMAND })).toThrow(/not a hooks object/);
  });

  it("removal leaves a file with no PassControl entry alone", () => {
    const target = codexHooksPath({ env: home() });
    fs.writeFileSync(target, JSON.stringify(perasFile()));
    const before = fs.readFileSync(target, "utf8");
    expect(removeCodexHooks({ target }).changed).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(removeCodexHooks({ target: path.join(path.dirname(target), "missing.json") }).changed).toBe(false);
  });
});

// Every answer the sidecar gives (cli/subscription-gate.mjs, cli/tool-gate.mjs), as Codex must get it.
describe("codexHookAnswer: the sidecar's answer, rebuilt for Codex", () => {
  const FORBIDDEN_ON_TOOL = ["continue", "stopReason", "suppressOutput", "decision", "reason"];
  const stop = (event, text) =>
    event === "PreToolUse"
      ? { continue: false, stopReason: text, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: text } }
      : { continue: false, stopReason: text, decision: "block", reason: text };
  const verdict = (permissionDecision, text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: text } });

  const toolCases = [
    ["the agent is stopped", stop("PreToolUse", "PassControl: this agent is stopped.")],
    ["a deny rule", verdict("deny", "PassControl: the agent's tool rules refuse this (rule 1: rm -rf).")],
    ["the owner said no, or did not answer", verdict("deny", "PassControl: the owner did not approve this.")],
    ["rules this build cannot read", verdict("deny", "PassControl: this agent's tool rules cannot be read here.")],
    ["an ask rule", verdict("ask", "PassControl: the agent's tool rules ask you to confirm this (rule 2: git push).")],
    ["a stop with no tool verdict", { continue: false, stopReason: "PassControl: stopped." }],
  ];

  it.each(toolCases)("PreToolUse, %s: a deny, and nothing Codex would read as a failed hook", (_name, out) => {
    const answer = codexHookAnswer("PreToolUse", out);
    expect(answer.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(/^PassControl/);
    for (const key of FORBIDDEN_ON_TOOL) expect(answer).not.toHaveProperty(key);
    expect(Object.keys(answer.hookSpecificOutput).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  });

  it("an ask rule says why Codex refuses it instead of asking", () => {
    const answer = codexHookAnswer("PreToolUse", verdict("ask", "PassControl: the agent's tool rules ask you to confirm this (rule 2: git push)."));
    expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(/Codex cannot ask here, so PassControl refuses it/);
  });

  it("a warning alone passes through as a warning, and the tool runs", () => {
    expect(codexHookAnswer("PreToolUse", { systemMessage: "PassControl could not read this agent's tool rules yet." })).toEqual({
      systemMessage: "PassControl could not read this agent's tool rules yet.",
    });
    expect(codexHookAnswer("PreToolUse", {})).toEqual({});
    expect(codexHookAnswer("PreToolUse", verdict("allow", "x"))).toEqual({});
  });

  it("a deny keeps its warning", () => {
    const answer = codexHookAnswer("PreToolUse", { ...verdict("deny", "PassControl: no."), systemMessage: "heads up" });
    expect(answer.systemMessage).toBe("heads up");
  });

  it("UserPromptSubmit: a stop blocks the prompt and ends the turn, in fields Codex supports there", () => {
    const text = "PassControl: this agent is stopped.";
    expect(codexHookAnswer("UserPromptSubmit", stop("UserPromptSubmit", text))).toEqual({ continue: false, stopReason: text, decision: "block", reason: text });
    expect(codexHookAnswer("UserPromptSubmit", { systemMessage: "warn", junk: 1, suppressOutput: true })).toEqual({ systemMessage: "warn" });
    expect(codexHookAnswer("UserPromptSubmit", {})).toEqual({});
  });

  it("no other event gets an answer", () => {
    expect(codexHookAnswer("Stop", stop("UserPromptSubmit", "x"))).toEqual({});
    expect(codexHookAnswer("PostToolUse", stop("PreToolUse", "x"))).toEqual({});
  });

  it("whatever the sidecar sends, nothing that is not a string gets through as a reason", () => {
    const answer = codexHookAnswer("PreToolUse", { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: { evil: 1 } } });
    expect(typeof answer.hookSpecificOutput.permissionDecisionReason).toBe("string");
    expect(codexHookAnswer("PreToolUse", null)).toEqual({});
    expect(codexHookAnswer("PreToolUse", "deny")).toEqual({});
  });
});

describe("runCodexHook: the relay Codex runs", () => {
  const servers = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  });
  async function sidecar(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ url: req.url, method: req.method, host: req.headers.host, body: Buffer.concat(chunks).toString("utf8") });
        handler(req, res);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return { port: server.address().port, seen };
  }
  const reply = (body, status = 200) => (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  it("hands Codex's input to the sidecar's hook endpoint and answers in Codex's terms", async () => {
    const { port, seen } = await sidecar(
      reply({ continue: false, stopReason: "PassControl: stopped.", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "PassControl: stopped." } })
    );
    const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
    const out = JSON.parse(await runCodexHook({ input, port }));
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "PassControl: stopped." } });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/_passcontrol/hook?t=600", host: `127.0.0.1:${port}` });
    expect(JSON.parse(seen[0].body).tool_name).toBe("Bash");
  });

  it("asks the prompt hook without a hold", async () => {
    const { port, seen } = await sidecar(reply({}));
    expect(await runCodexHook({ input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), port })).toBe("");
    expect(seen[0].url).toBe("/_passcontrol/hook");
  });

  it("with no sidecar, the action goes ahead with a warning: never a block, never a crash", async () => {
    const { port } = await sidecar(reply({}));
    await new Promise((r) => servers.pop().close(r));
    const out = JSON.parse(await runCodexHook({ input: JSON.stringify({ hook_event_name: "PreToolUse" }), port }));
    expect(out).toEqual({ systemMessage: expect.stringMatching(/sidecar/) });
  });

  it("a sidecar that refuses or answers nonsense is the same warning", async () => {
    for (const handler of [reply({ error: "hook_refused" }, 403), (_q, res) => res.end("not json")]) {
      const { port } = await sidecar(handler);
      const out = JSON.parse(await runCodexHook({ input: JSON.stringify({ hook_event_name: "UserPromptSubmit" }), port }));
      expect(out.systemMessage).toMatch(/PassControl/);
      expect(out).not.toHaveProperty("decision");
    }
  });

  it("gives up before Codex's own timeout on a prompt", async () => {
    const { port } = await sidecar(() => {}); // never answers
    const started = Date.now();
    const out = JSON.parse(await runCodexHook({ input: JSON.stringify({ hook_event_name: "UserPromptSubmit" }), port, promptTimeoutMs: 200 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.systemMessage).toMatch(/did not answer in time/);
  });

  it("an input that is not Codex's JSON, or another event, is answered with nothing and asks nobody", async () => {
    const { port, seen } = await sidecar(reply({ decision: "block" }));
    expect(await runCodexHook({ input: "not json", port })).toBe("");
    expect(await runCodexHook({ input: JSON.stringify({ hook_event_name: "Stop" }), port })).toBe("");
    expect(seen).toHaveLength(0);
  });
});

// The command Codex runs. A bare `passcontrol` failed both ways on the owner's Mac
// (2026-10-22): `command not found` under a GUI app's minimal PATH, and "Unknown
// command" from the 1.5.1 CLI still installed. Either is a failed hook, and a failed
// hook lets the tool run.
describe("the hook command", () => {
  it("names node and the CLI by absolute path, so PATH never decides whether it runs", () => {
    const command = codexHookCommand({ port: 8791, node: "/opt/node/bin/node", entry: "/opt/pc/bin/passcontrol.mjs" });
    expect(command).toBe('"/opt/node/bin/node" "/opt/pc/bin/passcontrol.mjs" codex-hook --port 8791');
    expect(isPassControlCodexHook({ type: "command", command })).toBe(true);
  });

  it("refuses a path the shell would read differently", () => {
    for (const entry of ['/x/"q/passcontrol.mjs', "/x/$HOME/passcontrol.mjs", "/x/`id`/passcontrol.mjs"]) {
      expect(() => codexHookCommand({ port: 1, node: "/n", entry })).toThrow(/cannot be quoted/);
    }
  });

  it("the probe passes this checkout's command under a bare PATH, and fails a bare `passcontrol`", () => {
    const good = codexHookCommand({ port: 1, node: process.execPath, entry: CLI_ENTRY });
    expect(probeCodexHookCommand(good)).toEqual({ ok: true });
    const bare = probeCodexHookCommand("passcontrol-not-installed-anywhere codex-hook --port 1");
    expect(bare.ok).toBe(false);
    expect(bare.why).toMatch(/exit|output/);
  });
});

// The relay against the REAL sidecar's hook endpoint, with a stand-in gateway. The
// stand-in sidecar above never checked who was calling; this one does (Host, Origin,
// loopback peer), so a relay it refused would show here as a warning, not a deny.
describe("runCodexHook through the real sidecar", () => {
  const servers = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) if (s.listening) await new Promise((r) => s.close(r));
  });
  const listen = async (server) => {
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return server.address().port;
  };
  const b64url = (bytes) => Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  async function sidecarWithSelf(selfAnswer) {
    const gateway = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const { status, body } =
          req.url === "/api/auth/challenge" ? { status: 200, body: { visa: "fake.visa.token", expires_in: 300 } } : selfAnswer(req);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    const gatewayPort = await listen(gateway);
    const secret = ed25519.utils.randomPrivateKey();
    const sidecar = createSidecar({
      gateway: `http://127.0.0.1:${gatewayPort}`,
      passportId: b64url(ed25519.getPublicKey(secret)),
      passportSecret: b64url(secret),
    });
    return listen(sidecar.server);
  }
  const FORBIDDEN = ["continue", "stopReason", "suppressOutput", "decision", "reason"];
  const tool = (command) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "019a0000-0000-7000-8000-000000000001", tool_name: "Bash", tool_input: { command }, cwd: "/repo" });

  it("a suspended agent's tool is denied, in Codex's terms", async () => {
    const port = await sidecarWithSelf(() => ({ status: 403, body: { error: "blocked_suspended" } }));
    const out = JSON.parse(await runCodexHook({ input: tool("ls"), port }));
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/stopped/);
    for (const key of FORBIDDEN) expect(out).not.toHaveProperty(key);
  });

  it("a suspended agent's prompt is blocked and the turn ends", async () => {
    const port = await sidecarWithSelf(() => ({ status: 403, body: { error: "blocked_suspended" } }));
    const out = JSON.parse(await runCodexHook({ input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "hi" }), port }));
    expect(out).toMatchObject({ continue: false, decision: "block" });
  });

  it("a Bash deny rule denies; a command no rule names goes ahead with nothing printed", async () => {
    const document = { rules: [{ tool: "Bash", command: "rm -rf *", effect: "deny" }] };
    const port = await sidecarWithSelf(() => ({ status: 200, body: { agent_id: "a", budget: {}, tool_rules: { state: "ok", document } } }));
    const denied = JSON.parse(await runCodexHook({ input: tool("rm -rf build"), port }));
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    for (const key of FORBIDDEN) expect(denied).not.toHaveProperty(key);
    expect(await runCodexHook({ input: tool("ls"), port })).toBe("");
  });
});
