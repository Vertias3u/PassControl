// /passcontrol, answered on this machine.
//
// Claude Code runs this hook whenever a slash command expands. For any command but
// ours it exits silently, and the command runs as usual. For /passcontrol it runs
// `passcontrol statusline --panel`, the PassControl CLI's own view of this agent,
// and shows what it prints, stopping the command before it reaches the model. That
// is the point: when PassControl refuses this agent's calls, the model cannot
// answer, but this still can.
//
// It shows what the CLI prints and nothing else. All of PassControl's logic stays
// in the CLI: this file imports nothing but Node's own modules.
import { spawn } from "node:child_process";

// The session id Claude Code puts on every call, held to what the PassControl
// gateway accepts as one, so nothing else is ever passed on.
const SESSION = /^[A-Za-z0-9._:-]{1,128}$/;
const OURS = /^(passcontrol:)?passcontrol$/;
const TIMEOUT_MS = 8_000;

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function runCli(args) {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    let out = "";
    let child;
    try {
      // On Windows the npm shim is a .cmd, which only runs through a shell; every
      // argument is fixed here or held to SESSION above, so none can reach it as syntax.
      child = spawn(windows ? "passcontrol.cmd" : "passcontrol", args, {
        shell: windows,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ missing: true, out: "" });
      return;
    }
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ missing: error?.code === "ENOENT", out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A Windows shell reports a missing command as exit 1 with nothing printed.
      resolve({ missing: windows && code !== 0 && !out.trim(), out });
    });
  });
}

export async function answer(input) {
  if (!OURS.test(String(input?.command_name ?? ""))) return null;
  const args = ["statusline", "--panel"];
  if (typeof input.session_id === "string" && SESSION.test(input.session_id)) args.push("--session", input.session_id);
  const { missing, out } = await runCli(args);
  let text = out.trimEnd();
  if (missing) {
    text = ["PassControl · CLI not found", "", "  Install it with:  npm install -g passcontrol"].join("\n");
  } else if (!text) {
    text = "PassControl · no answer from the CLI";
  } else if (!text.includes("\n")) {
    // A CLI from before /passcontrol prints only the one-line status.
    text += "\n\n  For the full view, update the CLI:  npm install -g passcontrol@latest";
  }
  // `continue: false` ends the command here, so the model is never called.
  return { continue: false, stopReason: text };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("panel.mjs")) {
  try {
    const result = await answer(JSON.parse((await readStdin()) || "{}"));
    if (result) process.stdout.write(JSON.stringify(result));
  } catch {
    // Never in the way: on anything unexpected, the command runs as usual.
  }
}
