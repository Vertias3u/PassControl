import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CLI module, no types
import { operatorEnv } from "../cli/config.mjs";

/**
 * `--allow-connect` is an egress control, so it must come from the operator.
 *
 * `bin/passcontrol.mjs` read `process.env.SIDECAR_ALLOW_CONNECT` as a fallback,
 * and `applyConfigSourcesToEnv` copies EVERY key out of a `.passcontrol` file
 * into the environment — not only the documented ones. So a project-local config
 * file, of the kind that arrives with a cloned repository, silently added tunnel
 * destinations to a sidecar the operator started with no flags at all. The
 * module's own rule said "hosts the operator named on the command line", and
 * PUBLIC_README.md tells users `--allow-connect <host>` names the exceptions;
 * neither was true.
 *
 * The blast radius was bounded — a CONNECT tunnel carries no visa, and the
 * provider refusal runs before the allowlist, so this could not un-govern a
 * provider call — but it turned a checked-in file into an egress relay.
 *
 * The sibling control four lines above already had this right:
 * `allowNonLoopback: Boolean(opts.allowNonLoopback)` takes no environment
 * fallback at all, so a config file can never widen the bind. This brings the
 * allowlist to the same standard, and prints the resolved list at startup so it
 * can never again be both widened and silent.
 */
const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const PASSPORT_ID = "x".repeat(43);
const PASSPORT_SECRET = "y".repeat(43);

/** Start the real CLI, capture its banner, and stop it. */
function banner(args: string[], configLines: string[], port: number): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "pc-ac-home-"));
  const project = mkdtempSync(join(tmpdir(), "pc-ac-proj-"));
  writeFileSync(join(project, ".passcontrol"), `${configLines.join("\n")}\n`);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "sidecar", "--port", String(port), ...args], {
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: home,
        NO_COLOR: "1",
        NODE_ENV: "test",
      },
    });
    let out = "";
    const done = () => {
      child.kill("SIGKILL");
      resolve(out);
    };
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("Listening on")) setTimeout(done, 250);
    });
    child.stderr.on("data", (d) => (out += d));
    setTimeout(done, 8000);
  });
}

const BASE = [
  "PASSCONTROL_GATEWAY=http://127.0.0.1:1",
  `PASSPORT_ID=${PASSPORT_ID}`,
  `PASSPORT_SECRET=${PASSPORT_SECRET}`,
];

describe("operatorEnv", () => {
  it("returns a value the operator's shell set", () => {
    expect(operatorEnv("SIDECAR_ALLOW_CONNECT", { env: { SIDECAR_ALLOW_CONNECT: "a.example" }, injected: new Set() }))
      .toBe("a.example");
  });

  it("withholds a value a config FILE injected", () => {
    expect(
      operatorEnv("SIDECAR_ALLOW_CONNECT", {
        env: { SIDECAR_ALLOW_CONNECT: "evil.example" },
        injected: new Set(["SIDECAR_ALLOW_CONNECT"]),
      })
    ).toBeUndefined();
  });

  it("does not disturb unrelated keys", () => {
    expect(operatorEnv("MODEL", { env: { MODEL: "claude-haiku-4-5" }, injected: new Set(["SIDECAR_ALLOW_CONNECT"]) }))
      .toBe("claude-haiku-4-5");
  });
});

describe("the CONNECT allowlist is the operator's, not a checked-in file's", () => {
  it("ignores SIDECAR_ALLOW_CONNECT set by a project .passcontrol", async () => {
    const out = await banner([], [...BASE, "SIDECAR_ALLOW_CONNECT=evil.example"], 8793);
    expect(out).toContain("Listening on");
    expect(out).not.toContain("evil.example");
    // Never both widened and silent: the resolved list is always announced.
    expect(out).toMatch(/CONNECT allowlist: none/i);
  }, 20000);

  it("honours the flag the operator actually typed", async () => {
    const out = await banner(["--allow-connect", "relay.example"], BASE, 8794);
    expect(out).toContain("Listening on");
    expect(out).toMatch(/CONNECT allowlist:.*relay\.example/i);
  }, 20000);
});
