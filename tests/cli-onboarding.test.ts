import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Two guards on the same surface: what the CLI tells a person who has just
// installed it and has nothing else set up. Both failures below were silent —
// the suite was green through each, because neither is about a wrong result. A
// first run that dead-ends is a person who does not come back, and nothing in a
// unit test notices that.

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));

/**
 * A PATH carrying node (for the shebang) and `which` (the CLI probes with it,
 * bin/passcontrol.mjs:529) and NOTHING else — so every prerequisite check fails
 * in the same run.
 *
 * This used to be `[dirname(process.execPath), "/usr/bin", "/bin"]`, which only
 * excluded docker by accident of where each host installs it. On GitHub's
 * ubuntu runners docker IS `/usr/bin/docker`, so the premise "neither is on
 * PATH" was false and `setup` correctly never mentioned Docker — the assertion
 * below failed, on a run where nothing was wrong with the product. It was
 * equally fragile locally: `dirname(process.execPath)` is `/usr/local/bin` on a
 * Homebrew node, which is exactly where Docker Desktop symlinks on macOS.
 *
 * A directory we build ourselves is the only PATH whose contents we know. The
 * premise is then asserted rather than assumed — see the check below, because a
 * test that silently loses its own precondition passes for the wrong reason.
 */
const BARE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), "passcontrol-bare-bin-"));
for (const tool of ["which", "where"]) {
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    const real = path.join(dir, tool);
    if (fs.existsSync(real)) {
      fs.symlinkSync(real, path.join(BARE_BIN, tool));
      break;
    }
  }
}
fs.symlinkSync(process.execPath, path.join(BARE_BIN, path.basename(process.execPath)));
afterAll(() => fs.rmSync(BARE_BIN, { recursive: true, force: true }));

const BARE_PATH = BARE_BIN;

/** Resolve a command the same way the CLI does, against the bare PATH only. */
function resolvableOnBarePath(command: string): boolean {
  return fs
    .readdirSync(BARE_BIN)
    .some((entry) => entry === command || entry === `${command}.exe`);
}

/**
 * An empty config home, because "a machine with nothing set up" has to mean the
 * DEVELOPER'S machine too.
 *
 * These tests spawn the real CLI, and the CLI reads a global config from
 * `XDG_CONFIG_HOME` or `~/.config` (cli/config.mjs:129, bin:438,
 * cli/update-check.mjs:29). Passing the real HOME therefore let the machine
 * running the suite decide what the CLI saw. That was survivable while nobody's
 * global config existed — and it stopped being survivable the moment
 * `passcontrol login` shipped, because writing that file is the whole point of
 * the command. After one Cloud login, `setup` refused with "only manages local
 * gateways" before it ever reached a prerequisite check, and this test failed on
 * the maintainer's machine while passing in CI.
 *
 * Isolating the config home rather than pinning PASSCONTROL_GATEWAY is
 * deliberate: it also keeps the run from touching the remembered app checkout in
 * `app.json` and the update-check cache, both of which resolve from the same
 * base and are real files belonging to whoever ran `npm test`.
 */
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "passcontrol-onboarding-"));
afterAll(() => fs.rmSync(CONFIG_HOME, { recursive: true, force: true }));

async function runCli(args: string[], env: Record<string, string | undefined>): Promise<string> {
  const result = await execFileAsync(process.execPath, [CLI, ...args], {
    // A deliberately minimal env: the point is a machine with nothing set up.
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PATH: BARE_PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: CONFIG_HOME,
      ...env,
    },
    timeout: 60_000,
  }).catch((error: { stdout?: string; stderr?: string }) => error);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

// `passcontrol setup` computed all five prerequisite results and then threw on
// `results.find(r => !r.ok)` — the FIRST one only. Someone with neither Docker nor
// the Supabase CLI installed therefore learned about them one at a time: install
// Docker (a multi-gigabyte download and a restart), re-run, and only then find out
// a second install is needed. Three sittings to reach a dashboard, and every one
// of them a chance to give up.
//
// The full list was already sitting in `results`; only the reporting was lossy.
// `doctor` printed all five the whole time, which is why this stayed invisible —
// the complete list existed, just not on the path a first-time user takes.
describe("setup reports every missing prerequisite at once", () => {
  it("names both Docker and the Supabase CLI when neither is on PATH", async () => {
    // The premise, asserted. If docker or supabase were reachable on this PATH
    // the run below would rightly not mention them, and the assertion that
    // follows would fail while nothing was wrong with the product. That is
    // exactly how this test broke in CI, so the precondition is now checked
    // rather than trusted.
    expect(
      resolvableOnBarePath("docker"),
      "the bare PATH leaked a docker binary, so this test can no longer prove what it claims",
    ).toBe(false);
    expect(
      resolvableOnBarePath("supabase"),
      "the bare PATH leaked a supabase binary, so this test can no longer prove what it claims",
    ).toBe(false);

    const output = await runCli(["setup", "--no-open"], {});

    // Non-vacuity: an empty or crashed run must not read as a pass.
    expect(output).toMatch(/Docker/);
    expect(
      output,
      `setup reported Docker but never mentioned the Supabase CLI, so a second install is still hidden:\n${output}`,
    ).toMatch(/Supabase CLI/);
  }, 70_000);
});

// `passcontrol try` was removed in 0.8.0, and the dead-end it used to have is
// gone by construction: `login` defaults to Cloud, so a machine with nothing set
// up is no longer sent to `passcontrol setup` (Docker + the Supabase CLI) to see
// anything work.
//
// What replaces that test is this one. `try` is named in the help text and README
// of every published release up to 0.8.0, so people are following pages that
// still list it — and a removed command that answers `Unknown command` reads as a
// broken install rather than a changelog.
describe("a removed command still points somewhere", () => {
  it("names its replacement instead of answering `Unknown command`", async () => {
    const output = await runCli(["try"], {});
    expect(output, "the removal must name what to run instead").toMatch(/passcontrol login/u);
    expect(output, "and must not read as an unrecognised command").not.toMatch(/Unknown command/u);
  }, 70_000);
});
