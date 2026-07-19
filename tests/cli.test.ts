import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "bin/passcontrol.mjs");

let tmp = "";

async function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const home = path.join(tmp, "home");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NODE_ENV: "test",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    ...opts.env,
  };
  return execFileAsync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? tmp,
    env,
    timeout: 10000,
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "passcontrol-cli-"));
  await fs.mkdir(path.join(tmp, "home"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("passcontrol CLI", () => {
  it("runs the styled help and status commands without ANSI when NO_COLOR is set", async () => {
    const help = await runCli(["help"], { env: { NO_COLOR: "1" } });
    const status = await runCli(["status", "--no-network"], {
      env: { NO_COLOR: "1" },
    });
    const output = `${help.stdout}\n${status.stdout}`;

    expect(output).toContain("PassControl");
    expect(output).toContain("Usage:");
    expect(output).toContain("Gateway:");
    expect(output).not.toMatch(/\x1b\[/);
  }, 10000);

  it("prints command help", async () => {
    const { stdout } = await runCli(["help"]);
    expect(stdout).toContain("passcontrol sidecar");
    expect(stdout).toContain("passcontrol start");
    expect(stdout).toContain("passcontrol stop");
    expect(stdout).toContain("passcontrol restart");
    expect(stdout).toContain("passcontrol local-logs");
    expect(stdout).toContain("passcontrol reset --local --confirm RESET");
    expect(stdout).toContain("passcontrol setup [--no-open] [--port-offset N]");
    expect(stdout).toContain("[--app-dir DIR]");
    expect(stdout).toContain("passcontrol configure <integration>");
    expect(stdout).toContain("passcontrol doctor [--deep] [--fix]");
    expect(stdout).toContain("passcontrol call \"hi\"");
    expect(stdout).toContain("passcontrol spend");
    expect(stdout).toContain("passcontrol env [openhands]");
  }, 10000);

  it("shows status without network access", async () => {
    const { stdout } = await runCli(["status", "--no-network"]);
    expect(stdout).toContain("Gateway:   not checked  http://localhost:3000");
    expect(stdout).toContain("Dashboard: local server not checked");
    expect(stdout).toContain("Passport:  missing");
    expect(stdout).toContain("passcontrol spend");
  }, 10000);

  it("does not manage a remote gateway as a local dashboard", async () => {
    await expect(
      runCli(["start"], { env: { PASSCONTROL_GATEWAY: "https://passcontrol.example.com" } })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("only manages local gateways"),
    });
  }, 10000);

  // When the CLI is installed globally (no surrounding repo checkout), the local
  // stack lives in a cloned app dir. PASSCONTROL_FORCE_INSTALLED=1 simulates that.
  // Exercised via `start`, which hits ensureAppRoot's clone logic directly without
  // the setup prerequisite gate — so this stays deterministic on CI runners that
  // lack Docker/Supabase (the gate itself is covered by the PATH="" test below).
  it("asks to clone the app when installed globally without a checkout", async () => {
    await expect(
      runCli(["start"], { env: { PASSCONTROL_FORCE_INSTALLED: "1" } })
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/interactive terminal.*--yes|--yes.*clone/s),
    });
  }, 10000);

  it("reports a missing Docker binary before setup attempts to clone", async () => {
    await expect(
      runCli(["setup", "--no-open"], {
        env: {
          PATH: "",
          PASSCONTROL_FORCE_INSTALLED: "1",
        },
      })
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/Docker.*not installed.*install Docker Desktop/is),
    });
  }, 10000);

  it("lists local prerequisites in doctor --deep", async () => {
    const { stdout, stderr } = await runCli(["doctor", "--deep"]);
    const output = `${stdout}\n${stderr}`;
    expect(output).toContain("Local prerequisites");
    expect(output).toContain("Docker CLI");
    expect(output).toContain("Docker daemon");
    expect(output).toContain("Supabase CLI");
    expect(output).toContain("Node.js");
    expect(output).toContain("Local stack ports");
  }, 10000);

  it("refuses to clone the app into a non-empty directory", async () => {
    const dir = path.join(tmp, "occupied");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "keep.txt"), "x");
    await expect(
      runCli(["start", "--yes", "--app-dir", dir], {
        env: { PASSCONTROL_FORCE_INSTALLED: "1" },
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("already exists and is not empty"),
    });
  }, 10000);

  it("points a checkout-less reset at setup instead of destroying nothing", async () => {
    await expect(
      runCli(["reset", "--local", "--confirm", "RESET"], { env: { PASSCONTROL_FORCE_INSTALLED: "1" } })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("passcontrol setup"),
    });
  }, 10000);

  it("reports the app checkout as not set up when installed globally", async () => {
    const { stdout } = await runCli(["status", "--no-network"], {
      env: { PASSCONTROL_FORCE_INSTALLED: "1" },
    });
    expect(stdout).toContain("App:");
    expect(stdout).toContain("not set up");
  }, 10000);

  it("uses PASSCONTROL_APP_ROOT as an explicit checkout override", async () => {
    const { stdout } = await runCli(["status", "--no-network"], {
      env: { PASSCONTROL_APP_ROOT: process.cwd() },
    });
    expect(stdout).toContain(`App:       ${process.cwd()}`);
  }, 10000);

  it("does not run local setup against a remote gateway", async () => {
    await expect(
      runCli(["setup", "--no-open"], { env: { PASSCONTROL_GATEWAY: "https://passcontrol.example.com" } })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("only manages local gateways"),
    });
  }, 10000);

  it("rejects an invalid local stack port offset before starting services", async () => {
    await expect(runCli(["setup", "--port-offset", "bad"])).rejects.toMatchObject({
      stderr: expect.stringContaining("--port-offset must be an integer"),
    });
  }, 10000);

  it("reports when there is no CLI-managed dashboard to stop", async () => {
    const { stdout } = await runCli(["stop"]);
    expect(stdout).toContain("No CLI-managed local dashboard is running.");
  }, 10000);

  it("prints the local dashboard log without needing a control-plane API key", async () => {
    const logDir = path.join(tmp, "home", ".config", "passcontrol");
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, "local-dashboard.log"), "dashboard started\n");

    const { stdout } = await runCli(["local-logs"]);
    expect(stdout).toContain("dashboard started");
  }, 10000);

  it("refuses a local reset without the explicit confirmation token", async () => {
    await expect(runCli(["reset", "--local"])).rejects.toMatchObject({
      stderr: expect.stringContaining("refuses to delete local data"),
    });
  }, 10000);

  it("loads nearest .passcontrol and lets env vars win", async () => {
    await fs.mkdir(path.join(tmp, "project", "nested"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "project", ".passcontrol"),
      [
        "PASSCONTROL_GATEWAY=http://from-file.test",
        "PASSPORT_ID=file-passport-id",
        "PASSPORT_SECRET=file-passport-secret",
        "PASSCONTROL_API_KEY=pc_filekey123456",
        "PROVIDER=openai",
        "MODEL=file-model",
        "",
      ].join("\n")
    );

    const { stdout } = await runCli(["status", "--no-network"], {
      cwd: path.join(tmp, "project", "nested"),
      env: {
        PASSCONTROL_GATEWAY: "http://from-env.test",
        MODEL: "env-model",
      },
    });

    expect(stdout).toContain("Gateway:   not checked  http://from-env.test");
    expect(stdout).toContain("Provider:  openai");
    expect(stdout).toContain("Model:     env-model");
    expect(stdout).toContain("Passport:  configured");
    expect(stdout).toContain(path.join(tmp, "project", ".passcontrol"));
  }, 10000);

  it("fails call clearly when no passport is configured", async () => {
    await expect(runCli(["call", "hi"])).rejects.toMatchObject({
      stderr: expect.stringContaining("No passport configured."),
    });
  }, 10000);

  it("prints sidecar env presets for OpenHands", async () => {
    const { stdout } = await runCli(["env", "openhands", "--provider", "anthropic", "--model", "claude-haiku-4-5"]);
    expect(stdout).toContain("passcontrol sidecar");
    expect(stdout).toContain("export LLM_BASE_URL='http://127.0.0.1:8788/api/v1/anthropic'");
    expect(stdout).toContain("export LLM_API_KEY='passcontrol'");
    expect(stdout).toContain("export LLM_MODEL='anthropic/claude-haiku-4-5'");
  }, 10000);

  it("previews an Aider configuration without writing it", async () => {
    const { stdout } = await runCli(["configure", "aider", "--provider", "anthropic", "--model", "claude-haiku-4-5"]);
    expect(stdout).toContain("Preview: .aider.conf.yml");
    expect(stdout).toContain("openai-api-base: http://127.0.0.1:8788/api/v1/anthropic");
    await expect(fs.access(path.join(tmp, ".aider.conf.yml"))).rejects.toBeTruthy();
  }, 10000);

  it("writes an Aider configuration only with --write", async () => {
    await runCli(["configure", "aider", "--write"]);
    const file = await fs.readFile(path.join(tmp, ".aider.conf.yml"), "utf8");
    expect(file).toContain("Generated by PassControl");
    expect(file).toContain("openai-api-key: passcontrol");
  }, 10000);

  it("fails read commands clearly when no control API key is configured", async () => {
    await expect(runCli(["spend"])).rejects.toMatchObject({
      stderr: expect.stringContaining("No control-plane API key configured."),
    });
  }, 10000);
});
