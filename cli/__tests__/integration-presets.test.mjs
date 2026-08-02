import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
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

  it("splits sidecar and MCP presets without overlap", () => {
    expect(INTEGRATIONS).toEqual([...SIDECAR_PRESETS, ...MCP_PRESETS]);
    expect(SIDECAR_PRESETS.filter((p) => MCP_PRESETS.includes(p))).toEqual([]);
    expect(new Set(INTEGRATIONS).size).toBe(INTEGRATIONS.length);
  });
});

describe("configure --write", () => {
  it.each(WRITABLE_INTEGRATIONS)("`configure %s --write` is accepted", async (preset) => {
    // aider writes into cwd; the MCP targets write under the fixture HOME.
    const { out } = await runCli(["configure", preset, "--write"]);
    expect(out).toMatch(/wrote /);
  });

  // Claude Code owns its own MCP registry, so there is no file for us to merge
  // into. `--write` used to be accepted here and silently do nothing useful.
  it("`configure claude-code --write` refuses instead of silently doing nothing", async () => {
    const { out } = await runCli(["configure", "claude-code", "--write"], { expectFailure: true });
    expect(out).toContain("claude mcp add");
    expect(out).not.toMatch(/wrote /);
  });

  it.each(SIDECAR_PRESETS.filter((p) => !WRITABLE_INTEGRATIONS.includes(p)))(
    "`configure %s --write` refuses instead of silently doing nothing",
    async (preset) => {
      const { out } = await runCli(["configure", preset, "--write"], { expectFailure: true });
      expect(out).not.toMatch(/wrote /);
    }
  );
});
