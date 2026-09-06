import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "bin", "passcontrol.mjs");
const SCRIPT = "/usr/bin/script";
const children = new Set();
const temporary = new Set();

afterEach(() => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  temporary.clear();
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function launch(extraEnv = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "passcontrol-menu-pty-"));
  temporary.add(cwd);
  const args = process.platform === "darwin"
    ? ["-q", "/dev/null", process.execPath, CLI]
    : ["-qefc", `${shellQuote(process.execPath)} ${shellQuote(CLI)}`, "/dev/null"];
  const child = spawn(SCRIPT, args, {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      PASSCONTROL_NO_UPDATE_CHECK: "1",
      XDG_CONFIG_HOME: path.join(cwd, "config"),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  const collect = (chunk) => { output += String(chunk); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const waitFor = (text, timeoutMs = 15_000) => new Promise((resolve, reject) => {
    if (output.includes(text)) return resolve(output);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${JSON.stringify(text)}. Output:\n${output}`));
    }, timeoutMs);
    const onData = () => {
      if (!output.includes(text)) return;
      cleanup();
      resolve(output);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`PTY exited (${code}) before ${JSON.stringify(text)}. Output:\n${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
  return { child, waitFor, output: () => output };
}

async function runDarwinScenario(body, extraEnv = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "passcontrol-menu-pty-"));
  temporary.add(cwd);
  const program = `
    log_user 1
    set timeout 8
    cd $env(PTY_CWD)
    spawn ${SCRIPT} -q /dev/null $env(PTY_NODE) $env(PTY_CLI)
    ${body}
  `;
  const child = spawn("/usr/bin/expect", ["-c", program], {
    env: {
      ...process.env,
      NO_COLOR: "1",
      PASSCONTROL_NO_UPDATE_CHECK: "1",
      XDG_CONFIG_HOME: path.join(cwd, "config"),
      PTY_CWD: cwd,
      PTY_NODE: process.execPath,
      PTY_CLI: CLI,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`expect scenario timed out. Output:\n${output}`));
    }, 12_000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      setTimeout(() => resolve(status), 50);
    });
  });
  children.delete(child);
  if (code !== 0) throw new Error(`expect scenario exited ${code}. Output:\n${output}`);
  return output;
}

describe.skipIf(process.platform === "win32" || !fs.existsSync(SCRIPT))("real PTY settings browser", () => {
  it("waits for init's readline prompt before delivering provider input", async () => {
    if (process.platform === "darwin") {
      const output = await runDarwinScenario(`
        expect "Choose a group"
        send "\\r"
        expect "Approve this machine"
        send "j"
        expect "Write a project"
        send "\\r"
        expect "Provider"
        send "not-a-provider\\r"
        expect "Unknown provider"
        expect eof
        exit 0
      `);
      expect(output).toContain("PassControl init");
      return;
    }
    const pty = launch();
    await pty.waitFor("Choose a group");
    pty.child.stdin.write("\r"); // Setup & config
    await pty.waitFor("Configure by hand, no browser");
    pty.child.stdin.write("\x1b[B\r");
    await pty.waitFor("Provider [anthropic]:");
    pty.child.stdin.write("not-a-provider\r");
    const output = await pty.waitFor('Unknown provider "not-a-provider"');
    expect(output).toContain("PassControl init");
  }, 20_000);

  it("cycles raw menu → read-only command → line prompt → raw menu", async () => {
    if (process.platform === "darwin") {
      const output = await runDarwinScenario(`
        expect "Choose a group"
        send "jjjjjj\\r"
        expect "Show local configuration"
        send "\\r"
        expect "Press Enter to return to Settings"
        send "\\r"
        expect "Recent"
        send "q"
        expect eof
        exit 0
      `);
      expect(output.match(/Choose a group/g)?.length).toBeGreaterThanOrEqual(2);
      return;
    }
    const pty = launch();
    await pty.waitFor("Choose a group");
    pty.child.stdin.write("\x1b[B".repeat(6) + "\r"); // Status & tools
    await pty.waitFor("Show cockpit status");
    pty.child.stdin.write("\r");
    await pty.waitFor("Press Enter to return to Settings, or q to quit:");
    pty.child.stdin.write("\r");
    await pty.waitFor("Recent");
    pty.child.stdin.write("q");
    expect(pty.output().match(/Choose a group/g)?.length).toBeGreaterThanOrEqual(2);
  }, 25_000);
  it("hides the local-stack commands on an install with no checkout", async () => {
    // PASSCONTROL_FORCE_INSTALLED=1 is the CLI's own switch for "behave as if
    // installed from npm", which is the only way to see this from inside the
    // repo — the surrounding checkout would otherwise satisfy the capability.
    // Without it the menu offers `setup`, which clones and runs the whole
    // server, as the fifth thing a brand-new user sees.
    //
    // With the group gone the top level is seven rows, so Status & tools is
    // index 5 rather than 6. That shift is the point of the test as much as the
    // absent title is: it is what proves the rows were removed from the
    // navigable list and not merely painted out.
    const scenario = `
      expect "Choose a group"
      send "jjjjj\r"
      expect "Diagnose setup"
      send "q"
      expect eof
      exit 0
    `;
    const output = process.platform === "darwin"
      ? await runDarwinScenario(scenario, { PASSCONTROL_FORCE_INSTALLED: "1" })
      : await (async () => {
        const pty = launch({ PASSCONTROL_FORCE_INSTALLED: "1" });
        await pty.waitFor("Choose a group");
        pty.child.stdin.write("\x1b[B".repeat(5) + "\r");
        await pty.waitFor("Diagnose setup");
        pty.child.stdin.write("q");
        return pty.output();
      })();

    expect(output, `the local stack group was still offered:\n${output}`).not.toContain("Local stack");
    expect(output).not.toContain("Clone the app and start everything");
    expect(output, `doctor was not where the shifted index says it is:\n${output}`).toContain("Diagnose setup");
  }, 25_000);

  // A guide only GATHERS input. Its first act is a control-plane read, and an
  // unreachable gateway made that read throw straight past settingsCommand into
  // main()'s top-level catch — which calls process.exit(1). Selecting "Governed
  // call logs" on a machine whose gateway is down ended the whole session with a
  // bare "fetch failed", having written nothing. Reproduced in a pty before the
  // fix; nothing but a pty can see it, because the escape only happens once the
  // menu is the thing that called the command.
  const UNREACHABLE = {
    PASSCONTROL_GATEWAY: "http://127.0.0.1:9",
    PASSCONTROL_API_KEY: `pc_${"a".repeat(40)}`,
  };

  it("keeps the session when a guide's control-plane read fails", async () => {
    // The scenario uses expect(1)'s plain `expect "text"` form, like the two
    // above. Do not "harden" it into the brace form (`expect { pat {} timeout
    // {exit 3} }`): against this program that form matches nothing and falls
    // through after the full timeout with the timeout arm never running —
    // `exp_internal 1` prints `expect: timed out` and no action. A timed-out
    // plain `expect` also falls through, and the script still reaches `exit 0`,
    // so the scenario itself proves nothing either way — the JS assertion below
    // is the actual guard, and it fails with the whole transcript attached.
    const scenario = `
      expect "Choose a group"
      send "jjj\\r"
      expect "Governed call logs"
      send "j\\r"
      expect "Press Enter to return to Settings"
      send "\\r"
      expect "Choose a group"
      send "q"
      expect eof
      exit 0
    `;
    const output = process.platform === "darwin"
      ? await runDarwinScenario(scenario, UNREACHABLE)
      : await (async () => {
        const pty = launch(UNREACHABLE);
        await pty.waitFor("Choose a group");
        pty.child.stdin.write("\x1b[B".repeat(3) + "\r"); // Evidence
        await pty.waitFor("Governed call logs");
        pty.child.stdin.write("\x1b[B\r");
        await pty.waitFor("Press Enter to return to Settings, or q to quit:");
        pty.child.stdin.write("\r");
        await pty.waitFor("Choose a group");
        pty.child.stdin.write("q");
        return pty.output();
      })();

    // Counting frames proves nothing: the top level is redrawn on every arrow
    // key, so "Choose a group" already appears several times before the guide
    // runs. What has to be true is the ORDER — the guide is reached, it reports
    // a failure, and a menu frame is drawn AFTER it. Before the fix the process
    // exited at the failure. The anchors are all strings PassControl itself
    // prints; the underlying error text is Node's own wording for a refused
    // connection, so it is asserted only as "some failure was reported".
    const reached = output.indexOf("Governed call logs");
    const resumed = output.indexOf("Press Enter to return to Settings");
    expect(reached, `the guide was never reached:\n${output}`).toBeGreaterThan(-1);
    expect(resumed, `the session ended instead of returning to the menu:\n${output}`).toBeGreaterThan(reached);
    expect(output.slice(reached, resumed), "the guide's read was expected to fail").toContain("✗ ");
    expect(output.indexOf("Choose a group", resumed)).toBeGreaterThan(resumed);
  }, 25_000);
});
