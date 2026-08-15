import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CLI module, no types
import { bareGatewayOrigin, requireControlGateway } from "../cli/config.mjs";
import { requireGatewayOrigin } from "../sdk/gateway";

// The CLI ships in the same tarball as the SDK and sends the same credential:
// `bin/passcontrol.mjs`'s `api()` puts `Authorization: Bearer <pc_ key>` on
// `${gateway}/api/control/v1…`, where the gateway was `PASSCONTROL_GATEWAY` with
// nothing but a trailing-slash trim applied. Fixing `ControlClient` and leaving
// this would have closed the library door and left the CLI door open on the same
// key — `passcontrol spend` against `http://gw.example.com` was a cleartext send.
//
// The rule is deliberately the SAME rule, and the parity block below is what
// keeps it that way. It cannot be the same *code*: `cli/` is plain .mjs run
// straight from the repository, while `sdk/gateway.ts` only exists as JavaScript
// after `tsc`, so an import across that line works in the built package and
// breaks every CLI invocation in this checkout. Two implementations, one pinned
// contract.

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const FAKE_KEY = `pc_${"f".repeat(40)}`;

// Bare origins, and the normalized value each validator must settle on.
const ACCEPTED: [string, string][] = [
  ["https://gw.example.com", "https://gw.example.com"],
  ["https://gw.example.com/", "https://gw.example.com"],
  ["https://gw.example.com:8443", "https://gw.example.com:8443"],
  ["https://gw.example.com:443", "https://gw.example.com"],
  ["http://localhost:3000", "http://localhost:3000"],
  ["http://127.0.0.1:8788", "http://127.0.0.1:8788"],
  ["http://[::1]:3000", "http://[::1]:3000"],
  ["https://LOCALHOST", "https://localhost"],
  ["http://127.1", "http://127.0.0.1"],
  ["http://[0:0:0:0:0:0:0:1]:3000", "http://[::1]:3000"],
];

const REJECTED = [
  "http://gateway.example",
  "HTTP://gateway.example",
  "http://192.168.1.10:3000",
  "http://10.0.0.5",
  "http://passcontrol:3000",
  "http://host.docker.internal:3000",
  "http://localhost.example",
  "http://notlocalhost",
  "http://localhost.",
  "http://127.0.0.1.attacker.example",
  "http://[::2]:3000",
  "/api/control/v1",
  "//gw.example.com",
  "gw.example.com",
  "not a url",
  "",
  "https://trusted.example@attacker.example",
  "https://admin:hunter2@gw.example.com",
  "https://gw.example.com/control",
  "https://gw.example.com/api/control/v1/",
  "https://gw.example.com//",
  "https://gw.example.com/?token=x",
  "https://gw.example.com/#frag",
  "ftp://gw.example.com",
  "javascript:alert(1)",
  "data:text/plain,hi",
];

describe("the CLI's control-plane gateway rule", () => {
  it.each(ACCEPTED)("accepts %s and normalizes it to %s", (gateway, origin) => {
    expect(bareGatewayOrigin(gateway)).toBe(origin);
    // The config-shaped guard `api()` actually calls, not just the helper.
    expect(requireControlGateway({ gateway })).toBe(origin);
  });

  it.each(REJECTED)("refuses %s", (gateway) => {
    expect(() => bareGatewayOrigin(gateway)).toThrow(/PASSCONTROL_GATEWAY/);
    expect(() => requireControlGateway({ gateway })).toThrow(/PASSCONTROL_GATEWAY/);
  });

  it("never quotes the refused value — a gateway URL can itself carry credentials", () => {
    for (const gateway of ["https://admin:hunter2@gw.example.com", "https://trusted.example@attacker.example"]) {
      const error = (() => {
        try {
          bareGatewayOrigin(gateway);
          return null;
        } catch (thrown) {
          return thrown as Error;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect(`${error!.message}${error!.stack ?? ""}`).not.toContain("hunter2");
      expect(error!.message).not.toContain("attacker.example");
    }
  });
});

// Two implementations of one rule is a drift risk by construction, so the
// agreement is asserted rather than assumed — every row, both directions.
describe("CLI and SDK enforce the identical rule", () => {
  it.each(ACCEPTED)("both accept %s as %s", (gateway, origin) => {
    expect(bareGatewayOrigin(gateway)).toBe(origin);
    expect(requireGatewayOrigin("ControlClient", gateway)).toBe(origin);
  });

  it.each(REJECTED.filter((value) => value !== ""))("both refuse %s", (gateway) => {
    expect(() => bareGatewayOrigin(gateway)).toThrow();
    expect(() => requireGatewayOrigin("ControlClient", gateway)).toThrow();
  });
});

// The behaviour, end to end, through the real binary. Both cases use port 1,
// where nothing listens: a permitted gateway therefore produces a *connection*
// failure, and a refused one must produce the refusal instead — which is how
// these two runs distinguish "validated before the request" from "the request
// merely failed". Neither leaves the loopback interface.
describe("passcontrol spend — the control key's destination", () => {
  const run = (gateway: string) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NO_COLOR: "1",
      NODE_ENV: "test",
      // Without it the CLI resolves THIS repo as the local stack checkout.
      PASSCONTROL_FORCE_INSTALLED: "1",
      PASSCONTROL_GATEWAY: gateway,
      PASSCONTROL_API_KEY: FAKE_KEY,
    };
    return execFileAsync(process.execPath, [CLI, "spend"], { env, timeout: 10000 });
  };

  it("refuses a non-loopback HTTP gateway instead of sending the key to it", async () => {
    const failure = await run("http://gw.example.com:1").catch((error) => error);
    expect(failure.stderr).toMatch(/PASSCONTROL_GATEWAY must be a bare HTTPS origin/);
    // Not a network failure: the request was never attempted.
    expect(failure.stderr).not.toMatch(/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i);
    expect(`${failure.stdout}${failure.stderr}`).not.toContain(FAKE_KEY);
  }, 15000);

  it("still allows loopback HTTP, which then fails at the socket rather than the rule", async () => {
    const failure = await run("http://127.0.0.1:1").catch((error) => error);
    expect(failure.stderr).not.toMatch(/must be a bare HTTPS origin/);
    expect(failure.stderr).toMatch(/fetch failed|ECONNREFUSED|connect/i);
  }, 15000);

  it("keeps embedded credentials out of the terminal", async () => {
    const failure = await run("https://admin:hunter2@gw.example.com").catch((error) => error);
    expect(failure.stderr).toMatch(/PASSCONTROL_GATEWAY must be a bare HTTPS origin/);
    expect(`${failure.stdout}${failure.stderr}`).not.toContain("hunter2");
  }, 15000);
});
