import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_CLI_PRESETS,
  GUI_PRESET_LABELS,
  INTEGRATIONS,
  MCP_PRESETS,
  SIDECAR_PRESETS,
  WRITABLE_INTEGRATIONS,
} from "../presets.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "bin/passcontrol.mjs");

let tmp = "";

// The MCP presets refuse to print anything without a passport in the GLOBAL
// config, so every fixture seeds one. Without it, `env cursor` fails for a
// reason that has nothing to do with preset resolution and the table below
// would pass for the wrong reason.
async function seedGlobalPassport(home) {
  const dir = path.join(home, ".config", "passcontrol");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "config"),
    ["PASSPORT_ID=test-passport-id", "PASSPORT_SECRET=test-passport-secret", ""].join("\n"),
    { mode: 0o600 }
  );
}

async function runCli(args, { expectFailure = false } = {}) {
  const home = path.join(tmp, "home");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NODE_ENV: "test",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    // See tests/cli.test.ts: without this the CLI resolves THIS repo as the
    // local stack checkout, and a stack command would act on the real stack.
    PASSCONTROL_FORCE_INSTALLED: "1",
  };
  let result;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: tmp,
      env,
      timeout: 15000,
    });
    result = { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    result = { code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? error.message}` };
  }
  // Asserted OUTSIDE the try: throwing inside it would be caught by its own
  // catch and silently turned into a "failed as expected" result.
  if (expectFailure && result.code === 0) {
    throw new Error(`expected \`${args.join(" ")}\` to exit non-zero, but it exited 0:\n${result.out}`);
  }
  if (!expectFailure && result.code !== 0) {
    throw new Error(`\`${args.join(" ")}\` failed (exit ${result.code}):\n${result.out}`);
  }
  return result;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pc-presets-"));
  await seedGlobalPassport(path.join(tmp, "home"));
});

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("integration presets", () => {
  // Direction 1: everything we advertise actually works.
  it.each(INTEGRATIONS)("`env %s` resolves to a real preset", async (preset) => {
    const { out } = await runCli(["env", preset]);
    expect(out.trim()).not.toBe("");
  });

  it.each(INTEGRATIONS)("`configure %s` resolves to a real preset", async (preset) => {
    const { out } = await runCli(["configure", preset]);
    expect(out.trim()).not.toBe("");
  });

  // Direction 2: everything that works is advertised. This is the half that was
  // broken — `configure`'s usage listed 7 of the 9 supported presets, so users
  // were told `litellm` and `generic` did not exist.
  it("`configure` with no argument advertises every supported integration", async () => {
    const { out } = await runCli(["configure"], { expectFailure: true });
    for (const preset of INTEGRATIONS) {
      expect(out, `configure usage omits "${preset}"`).toContain(preset);
    }
  });

  it("`env` with an unknown preset advertises every supported integration", async () => {
    const { out } = await runCli(["env", "definitely-not-a-preset"], { expectFailure: true });
    for (const preset of INTEGRATIONS) {
      expect(out, `env usage omits "${preset}"`).toContain(preset);
    }
  });

  // Help documents `env [integration]` as optional, so bare `env` must work.
  it("`env` with no argument falls back to the generic preset", async () => {
    const bare = await runCli(["env"]);
    const explicit = await runCli(["env", "generic"]);
    expect(bare.out).toBe(explicit.out);
    expect(bare.out.trim()).not.toBe("");
  });

  it("`--help` advertises every supported integration", async () => {
    const { out } = await runCli(["help"]);
    for (const preset of INTEGRATIONS) {
      expect(out, `help omits "${preset}"`).toContain(preset);
    }
  });

  // The two lists must stay disjoint and complete, or the dispatch in
  // printAgentPreset()/configureCommand() silently sends a preset down the
  // wrong branch.
  // GUI presets are dispatched by a lookup, not by a switch case, so a key that
  // is not also a sidecar preset would be unreachable — `env <it>` would reject
  // the name before the lookup ever ran.
  it("registers every GUI preset as a sidecar preset", () => {
    for (const preset of Object.keys(GUI_PRESET_LABELS)) {
      expect(SIDECAR_PRESETS, `"${preset}" is labelled but not advertised`).toContain(preset);
    }
  });

  it.each(Object.entries(GUI_PRESET_LABELS))(
    "`env %s` prints the three settings fields under its display name",
    async (preset, label) => {
      const { out } = await runCli(["env", preset]);
      expect(out).toContain(`# ${label} settings:`);
      for (const field of ["Base URL:", "API key:", "Model:"]) {
        expect(out, `${preset} preset omits "${field}"`).toContain(field);
      }
      // The key field is a placeholder the sidecar ignores. If a real-looking
      // key ever appears here, the preset is telling users to paste the thing
      // the sidecar exists to keep out of the client.
      expect(out).toMatch(/API key:\s+passcontrol$/m);
    }
  );

  it("splits sidecar, coding-agent and MCP presets without overlap", () => {
    expect(INTEGRATIONS).toEqual([...SIDECAR_PRESETS, ...AGENT_CLI_PRESETS, ...MCP_PRESETS]);
    expect(SIDECAR_PRESETS.filter((p) => MCP_PRESETS.includes(p))).toEqual([]);
    expect(AGENT_CLI_PRESETS.filter((p) => SIDECAR_PRESETS.includes(p) || MCP_PRESETS.includes(p))).toEqual([]);
    expect(new Set(INTEGRATIONS).size).toBe(INTEGRATIONS.length);
  });

  it("prints Hermes's current custom-provider YAML without a provider key", async () => {
    const { out } = await runCli(["env", "hermes", "--provider", "openai", "--model", "gpt-5-mini"]);
    expect(out).toContain("Hermes Agent custom provider");
    expect(out).toContain("provider: custom");
    expect(out).toContain('base_url: "http://127.0.0.1:8788/api/v1/openai/v1"');
    expect(out).toContain('api_key: "passcontrol"');
    expect(out).not.toContain("OPENAI_BASE_URL");
  });

  it("points a GitHub client at the governed service route, with no GitHub token", async () => {
    const { out } = await runCli(["env", "github", "--port", "9123"]);
    expect(out).toContain("export GITHUB_API_URL='http://127.0.0.1:9123/api/v1/svc/github'");
    expect(out).toContain("passcontrol sidecar --port 9123");
    expect(out).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|ghp_|github_pat_/);
  });

  it("no longer calls GitHub access read-only (writes ship in 1.1.0)", async () => {
    const { out } = await runCli(["env", "github"]);
    expect(out).not.toMatch(/read-only/i);
  });

  it("points a Telegram client at the governed service route, with no bot token", async () => {
    const { out } = await runCli(["env", "telegram", "--port", "9123"]);
    expect(out).toContain("export TELEGRAM_API_URL='http://127.0.0.1:9123/api/v1/svc/telegram'");
    expect(out).toContain("passcontrol sidecar --port 9123");
    // The bot token lives in PassControl; nothing here carries one or a bot<token> path.
    expect(out).not.toMatch(/TELEGRAM_BOT_TOKEN|\/bot[0-9]|api\.telegram\.org/);
  });

  it("rejects a non-numeric port before printing a copyable sidecar command", async () => {
    const { out } = await runCli(
      ["env", "hermes", "--provider", "openai", "--model", "gpt-5-mini", "--port", "8788; id"],
      { expectFailure: true }
    );
    expect(out).toContain("--port must be an integer from 1 to 65535");
    expect(out).not.toContain("Start the bridge first");
    expect(out).not.toContain("sidecar --port 8788; id");
  });
});

describe("configure --write", () => {
  it.each(WRITABLE_INTEGRATIONS)("`configure %s --write` is accepted", async (preset) => {
    // aider writes into cwd; the MCP targets write under the fixture HOME.
    const { out } = await runCli(["configure", preset, "--write"]);
    expect(out).toMatch(/wrote /);
  });

  // Since 2026-10-07 `configure claude-code` routes Claude Code's own model
  // calls through the sidecar by writing its settings (cli/claude-code.mjs).
  // The MCP chat tool stays a separate, optional command Claude Code owns.
  it("`configure claude-code` previews the settings and still names the MCP command", async () => {
    const { out } = await runCli(["configure", "claude-code"]);
    expect(out).toContain(".claude/settings.local.json");
    expect(out).toContain("ANTHROPIC_BASE_URL");
    expect(out).toContain("http://127.0.0.1:8788/api/v1/anthropic");
    expect(out).toContain("claude mcp add");
    expect(out).not.toMatch(/wrote /);
  });

  it("`configure claude-code --write` writes this project's settings, and --remove undoes it", async () => {
    const { out } = await runCli(["configure", "claude-code", "--write"]);
    expect(out).toMatch(/wrote .*\.claude\/settings\.local\.json/);
    const written = JSON.parse(await fs.readFile(path.join(tmp, ".claude", "settings.local.json"), "utf8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8788/api/v1/anthropic");
    const removed = await runCli(["configure", "claude-code", "--remove"]);
    expect(removed.out).toMatch(/removed/i);
    expect(JSON.parse(await fs.readFile(path.join(tmp, ".claude", "settings.local.json"), "utf8"))).toEqual({});
  });

  it("`configure claude-code --write --global` writes the user settings", async () => {
    const { out } = await runCli(["configure", "claude-code", "--write", "--global"]);
    expect(out).toMatch(/wrote .*home\/\.claude\/settings\.json/);
  });

  it("`env claude-code` prints the two variables", async () => {
    const { out } = await runCli(["env", "claude-code"]);
    expect(out).toContain("export ANTHROPIC_BASE_URL='http://127.0.0.1:8788/api/v1/anthropic'");
    expect(out).toContain("export ANTHROPIC_AUTH_TOKEN=");
  });

  // `configure codex` writes a Codex profile file (cli/codex.mjs), used with
  // `codex --profile passcontrol`; Codex's own config.toml is never touched.
  it("`configure codex` previews the profile and writes nothing", async () => {
    const { out } = await runCli(["configure", "codex"]);
    expect(out).toContain(".codex/passcontrol.config.toml");
    expect(out).toContain('base_url = "http://127.0.0.1:8788/api/v1/openai"');
    expect(out).toContain("codex --profile passcontrol");
    expect(out).not.toMatch(/wrote /);
  });

  it("`configure codex --write` writes the profile under ~/.codex, and --remove undoes it", async () => {
    const target = path.join(tmp, "home", ".codex", "passcontrol.config.toml");
    const { out } = await runCli(["configure", "codex", "--write", "--model", "gpt-5-mini"]);
    expect(out).toMatch(/wrote .*\.codex\/passcontrol\.config\.toml/);
    const written = await fs.readFile(target, "utf8");
    expect(written).toContain('wire_api = "responses"');
    expect(written).toContain('model = "gpt-5-mini"');
    const removed = await runCli(["configure", "codex", "--remove"]);
    expect(removed.out).toMatch(/removed/i);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("`configure codex` refuses a provider Codex cannot reach through PassControl", async () => {
    const { out } = await runCli(["configure", "codex", "--provider", "anthropic"], { expectFailure: true });
    expect(out).toMatch(/openai/i);
    expect(out).not.toMatch(/wrote /);
  });

  it("`env codex` prints the profile to save by hand", async () => {
    const { out } = await runCli(["env", "codex"]);
    expect(out).toContain("[model_providers.passcontrol]");
    expect(out).toContain("codex --profile passcontrol");
  });

  it.each(SIDECAR_PRESETS.filter((p) => !WRITABLE_INTEGRATIONS.includes(p)))(
    "`configure %s --write` refuses instead of silently doing nothing",
    async (preset) => {
      const { out } = await runCli(["configure", preset, "--write"], { expectFailure: true });
      expect(out).not.toMatch(/wrote /);
    }
  );
});

// Apps that only take OLLAMA_HOST point at the sidecar's Ollama listener
// (`passcontrol sidecar --ollama-port`, 11435 by default). `local` has no price,
// so the preset says to give the agent a token budget, not a dollar limit.
describe("the ollama preset", () => {
  it("`env ollama` prints OLLAMA_HOST and how to start the listener", async () => {
    const { out } = await runCli(["env", "ollama"]);
    expect(out).toContain("export OLLAMA_HOST='127.0.0.1:11435'");
    expect(out).toContain("sidecar --ollama-port");
    expect(out).toMatch(/token budget/);
  });

  it("follows --ollama-port", async () => {
    const { out } = await runCli(["env", "ollama", "--ollama-port", "11500"]);
    expect(out).toContain("export OLLAMA_HOST='127.0.0.1:11500'");
  });
});
