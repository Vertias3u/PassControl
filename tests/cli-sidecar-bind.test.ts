import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CLI module, no types
import { assertBindHost } from "../cli/sidecar.mjs";

/**
 * `passcontrol sidecar --host 0.0.0.0` used to be accepted.
 *
 * That is not a formatting preference. The sidecar holds the passport and mints
 * a work-visa for whatever connects to it — no authentication of its own, by
 * design, because "the client needs no credential" is the entire feature. Bound
 * off-loopback it is an unauthenticated visa-issuing endpoint handing anyone who
 * can route to it the agent's scope and budget, spending the tenant's money
 * against the tenant's provider key.
 *
 * The `--host` flag was already wired to the listener (`bin/passcontrol.mjs`,
 * `sidecarCommand`), so this was reachable from the shipped CLI, not only from
 * a library caller.
 */
const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));

// Hermetic: an empty HOME/XDG_CONFIG_HOME so the developer's own profile cannot
// supply a passport and change which error the command reaches.
const EMPTY = mkdtempSync(join(tmpdir(), "pc-bind-"));

const run = (args: string[], env: Record<string, string> = {}) =>
  execFileAsync(process.execPath, [CLI, ...args], {
    cwd: EMPTY,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: EMPTY,
      XDG_CONFIG_HOME: EMPTY,
      NO_COLOR: "1",
      NODE_ENV: "test",
      PASSCONTROL_FORCE_INSTALLED: "1",
      PASSCONTROL_GATEWAY: "http://127.0.0.1:1",
      PASSPORT_ID: "x".repeat(43),
      PASSPORT_SECRET: "y".repeat(43),
      ...env,
    },
    timeout: 15000,
  }).catch((error) => error);

const output = (result: { stdout?: string; stderr?: string }) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`;

describe("the sidecar's bind guard", () => {
  // Nothing is bound in this test: the guard throws before `createSidecar` and
  // before `listen`, which is also why the command exits instead of running as
  // the foreground process it normally becomes.
  it.each(["0.0.0.0", "::", "192.168.1.10"])("refuses --host %s from the real binary", async (host) => {
    const result = await run(["sidecar", "--host", host]);

    expect(output(result)).toMatch(/loopback/i);
    expect((result as { code?: number }).code).toBe(1);
  });

  it("still starts on loopback without an opt-in", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "::1", "localhost"]) {
      expect(assertBindHost(host)).toBe(host);
    }
  });

  // Asserted at module level rather than through the binary on purpose: proving
  // the opt-in works by actually binding 0.0.0.0 would open a listener on every
  // interface of whatever machine runs the suite.
  it("accepts a non-loopback bind only when it is named explicitly", () => {
    expect(() => assertBindHost("0.0.0.0")).toThrow(/loopback/i);
    expect(assertBindHost("0.0.0.0", true)).toBe("0.0.0.0");
  });
});
