import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The local stack's Redis keeps its data across a restart.
 *
 * It used to run with `--save "" --appendonly no`: memory only. Redis holds the
 * gateway's running state (budget counters and holds, the kill switch, nonces),
 * and a dollar-limited agent whose budget state is gone fails CLOSED with
 * `blocked_budget_state` until its budget is rebuilt through the control API. So
 * every Docker restart wedged every agent with a limit, and since F1 that is
 * every new dashboard agent (reproduced 2026-10-10). `passcontrol stop` also
 * told the user "Local data kept" while Redis was being emptied.
 *
 * The fix: an append-only file on a NAMED volume. Named, because `compose down`
 * (what `passcontrol stop` runs) keeps a named volume but leaves an anonymous one
 * behind, so the next `up` would start empty. `down -v` (`passcontrol reset
 * --local`) still removes it, which is what a reset is for.
 *
 * Scope: what the committed configuration DECLARES. That a running container
 * actually survives a restart is a `docker` observation, recorded in TEAMSHARE.
 */
const ROOT = new URL("..", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");
const compose = read("docker/compose.yml");

/** One top-level service's block, or a top-level key's block. */
function block(name: string, indent: number): string {
  const pad = " ".repeat(indent);
  const parts = compose.split(new RegExp(`^${pad}(?=\\S)`, "m"));
  const found = parts.find((part) => part.startsWith(`${name}:`));
  if (!found) throw new Error(`docker/compose.yml has no '${name}' block`);
  return found;
}

const redis = block("redis", 2);

describe("local Redis persistence", () => {
  it("writes an append-only file", () => {
    const command = redis.match(/^ {4}command:\s*(\[.*\])\s*$/m)?.[1];
    expect(command, "redis has a command array").toBeDefined();
    const args = JSON.parse(command ?? "[]") as string[];
    const at = args.indexOf("--appendonly");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("yes");
  });

  it("keeps /data on a named volume, declared at the top level", () => {
    const mount = redis.match(/^ {6}- "?([A-Za-z0-9_-]+):\/data"?\s*$/m)?.[1];
    expect(mount, "redis mounts a named volume at /data").toBeDefined();
    const volumes = block("volumes", 0);
    expect(volumes).toMatch(new RegExp(`^ {2}${mount}:`, "m"));
  });

  it("`passcontrol stop` keeps the volume and `reset --local` removes it", () => {
    const cli = read("bin/passcontrol.mjs");
    expect(cli).toContain('["compose", "-f", "docker/compose.yml", "down"],');
    expect(cli).toContain('["compose", "-f", "docker/compose.yml", "down", "-v"]');
    expect(cli).toContain("Local data kept");
  });
});
