import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The local stack's Redis bridge must not be reachable from the network.
 *
 * `lib/state/redis.ts` talks to Upstash over REST, so a local install cannot use
 * a plain TCP Redis — docker/compose.yml runs serverless-redis-http in front of
 * one. SRH authenticates with a FIXED development token that is committed to
 * this repository, which is fine for a bridge only the machine itself can reach
 * and not fine for anything else. Docker publishes a port on all interfaces by
 * default, so `docker compose up` on a laptop joined to a café or office network
 * handed every other host on it an authenticated Redis: the kill switch, every
 * nonce, and every budget counter, readable and writable by anyone who reads
 * this file. Docker also writes its own iptables rules on Linux, so a host
 * firewall is not reliably in the way.
 *
 * The fix is one line of publication syntax, which is exactly why it needs a
 * test: nothing else in the suite would notice it being undone, and the failure
 * is invisible from the machine doing the exposing.
 *
 * Scope: this file asserts what the committed configuration DECLARES. Proof
 * that the running container actually binds that way is a `docker` observation
 * and belongs in the session's recorded evidence, not in a unit test that has
 * to pass on a machine with no Docker.
 */
const ROOT = new URL("..", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");

const compose = read("docker/compose.yml");

/** The `ports:` entries of one service block, in declaration order. */
function publishedPorts(service: string): string[] {
  const block = compose.split(/^ {2}(?=\S)/m).find((s) => s.startsWith(`${service}:`));
  if (!block) throw new Error(`docker/compose.yml has no '${service}' service`);
  // Everything indented under `ports:` until the next key at the same level.
  // Comment lines are skipped rather than tolerated by accident: the entry this
  // file exists to protect carries a long explanation directly above it.
  const ports = block.match(/^ {4}ports:\n((?: {6}\S.*\n)+)/m);
  if (!ports) return [];
  const body = ports[1] ?? "";
  return [...body.matchAll(/^ {6}- "?([^"\n]+?)"?$/gm)].map((m) => (m[1] ?? "").trim());
}

describe("the local Redis bridge is not published to the network", () => {
  it("binds the SRH port to IPv4 loopback", () => {
    const ports = publishedPorts("srh");
    expect(ports).toHaveLength(1);
    // Defaulted rather than asserted non-null: an empty string fails the match
    // below, so a missing entry is still a failure and never a silent pass.
    const [srh = ""] = ports;
    // A published port with no host address is every interface. Naming the
    // address is the whole fix; asserting the prefix rather than the exact
    // string leaves the port and the variable free to change.
    expect(srh).toMatch(/^127\.0\.0\.1:/);
  });

  it("never publishes Redis itself", () => {
    // SRH reaches Redis over the compose network. Publishing 6379 as well would
    // expose an UNAUTHENTICATED Redis beside the authenticated bridge, which is
    // strictly worse than the bug this file is about.
    expect(publishedPorts("redis")).toEqual([]);
  });

  it("keeps the port overridable, so a second stack does not need a fork", () => {
    // `scripts/dev-stack.sh` computes 8079 + PASSCONTROL_PORT_OFFSET and the CLI's
    // `setup --port-offset` does the same; both pass a bare integer, which is why
    // a host address can be prefixed in front of the variable at all.
    const [srh = ""] = publishedPorts("srh");
    expect(srh).toContain("${PASSCONTROL_SRH_PORT:-8079}");
  });

  it("keeps the default the CLI reads out of this file", () => {
    // bin/passcontrol.mjs does not hardcode 8079: localRedisPort() recovers the
    // compose default by regex so the two cannot drift. That coupling is
    // invisible from either file alone, so it is pinned here with the LITERAL
    // pattern the CLI uses. If this fails, `passcontrol start` is about to bring
    // compose up on one port while the dashboard reads another — a Redis that is
    // healthy in `docker ps` and unreachable from the app.
    const cli = read("bin/passcontrol.mjs");
    expect(cli).toContain("PASSCONTROL_SRH_PORT:-(\\d+)");
    expect(compose.match(/PASSCONTROL_SRH_PORT:-(\d+)/)?.[1]).toBe("8079");
  });

  it("documents the loopback URL rather than a hostname that could resolve off-box", () => {
    // `localhost` is correct and is what the templates say. This pins that no
    // one "helpfully" rewrites it to a LAN address or 0.0.0.0 when the binding
    // starts refusing those.
    for (const rel of ["docker/compose.yml", ".env.docker.example"]) {
      const urls = [...read(rel).matchAll(/UPSTASH_REDIS_REST_URL=(\S+)/g)].map((m) => m[1] ?? "");
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(new URL(url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    }
  });
});
