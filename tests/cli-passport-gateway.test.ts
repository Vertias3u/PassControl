import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CLI module, no types
import { bareGatewayOrigin, probeGatewayOrigin, requirePassportGateway } from "../cli/config.mjs";

// The control-plane half of this rule shipped first: `api()` validates before it
// puts a `pc_` key on the wire, and tests/cli-control-gateway.test.ts pins it.
// The PASSPORT half was left on the raw string, so the same binary refused a
// cleartext destination for one credential and accepted it for the other.
//
// What that cost, reproduced against the real binary before this suite existed:
// a project-local `.passcontrol` that overrides ONLY `PASSCONTROL_GATEWAY` —
// inheriting passport credentials from the global profile — sent a *verified*
// Ed25519 challenge signature to a plain-HTTP address on the LAN, then forwarded
// the minted visa there as a bearer token. A gateway carrying a path prefix was
// accepted too (`/tenant-a/api/auth/challenge`).
//
// The signed payload is `{passport_id, ts, nonce}` with no audience, and
// app/api/auth/challenge/route.ts allows `SKEW_MS = 90_000` of clock skew — so a
// captured signature replays against the REAL gateway for about ninety seconds,
// because the hostile gateway never claimed the nonce. That window is read from
// the route source; it is not demonstrated here, and there is no database in
// this suite to demonstrate it against.
//
// Note what did NOT happen, because it changes where the guard has to live: the
// deceptive `https://trusted.example@attacker.example` form did not deliver a
// signature on Node — undici refuses to construct a Request from a URL carrying
// credentials, and the CLI died with *its* error. That is a property of one
// runtime's fetch, not a control this project owns, so the rule below still
// covers userinfo rather than leaning on the accident.

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));

// A real, throwaway passport shape. Never used against anything but port 1.
const PASSPORT_ID = "x".repeat(43);
const PASSPORT_SECRET = "y".repeat(43);

// The CLI merges a global profile and a project `.passcontrol` into the
// environment at import time. Both are pointed at an empty directory here, or
// the developer's own `~/.config/passcontrol/config` supplies a real passport
// and the ordering test below silently stops testing ordering. (It did, first
// run: the "no passport" case reached the network on this machine.)
const EMPTY = mkdtempSync(join(tmpdir(), "pc-hermetic-"));

/**
 * Run the CLI with a hermetic environment.
 *
 * Every destination is port 1, where nothing listens. A PERMITTED gateway
 * therefore fails at the socket and a REFUSED one fails at the rule — which is
 * what lets these tests tell "validated before the request" apart from "the
 * request merely failed", without any listener and without leaving loopback.
 */
const run = (args: string[], env: Record<string, string>) =>
  execFileAsync(process.execPath, [CLI, ...args], {
    cwd: EMPTY,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: EMPTY,
      XDG_CONFIG_HOME: EMPTY,
      NO_COLOR: "1",
      NODE_ENV: "test",
      // Without it the CLI resolves THIS repo as the local stack checkout.
      PASSCONTROL_FORCE_INSTALLED: "1",
      ...env,
    },
    timeout: 15000,
  }).catch((error) => error);

const output = (result: { stdout?: string; stderr?: string }) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`;

describe("the passport path's gateway rule", () => {
  // Same helper, same message, same rule as the control plane — deliberately not
  // a second rule with a second vocabulary. The parity table in
  // tests/cli-control-gateway.test.ts already pins `bareGatewayOrigin` against
  // the SDK; this only has to prove the passport guard resolves to it.
  it("is the control plane's rule, not a looser one beside it", () => {
    for (const gateway of ["https://gw.example.com", "https://gw.example.com/", "http://127.0.0.1:8788"]) {
      expect(requirePassportGateway({ gateway })).toBe(bareGatewayOrigin(gateway));
    }
    for (const gateway of [
      "http://gw.example.com",
      "http://192.168.1.10:3000",
      "https://trusted.example@attacker.example",
      "https://gw.example.com/tenant-a",
      "https://gw.example.com/?token=x",
      "not a url",
      "",
    ]) {
      expect(() => requirePassportGateway({ gateway })).toThrow(/PASSCONTROL_GATEWAY/);
    }
  });
});

// `call` is the entrypoint that signs; `sidecar` and `mcp` hand the same
// credentials to a long-running process. `doctor --deep` and `try` mint through
// the same `mintVisa`/visa-client choke points and are covered by them — they
// are deliberately NOT driven here: `doctor --deep` runs local prerequisite
// checks that block on a Docker daemon, so a committed test for it would hang on
// any machine without one, and it catches the mint error and reports through
// `fail()` rather than exiting non-zero.
describe("passcontrol call — where the passport signature goes", () => {
  const withPassport = (gateway: string) => ({
    PASSCONTROL_GATEWAY: gateway,
    PASSPORT_ID,
    PASSPORT_SECRET,
  });

  it("refuses a non-loopback HTTP gateway instead of signing a challenge to it", async () => {
    const result = await run(["call", "hi"], withPassport("http://gw.example.com:1"));
    expect(result.stderr).toMatch(/PASSCONTROL_GATEWAY must be a bare HTTPS origin/);
    // The decisive assertion: no request was attempted at all.
    expect(output(result)).not.toMatch(/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i);
  }, 20000);

  it("refuses a gateway carrying a path prefix", async () => {
    const result = await run(["call", "hi"], withPassport("https://gw.example.com:1/tenant-a"));
    expect(result.stderr).toMatch(/PASSCONTROL_GATEWAY must be a bare HTTPS origin/);
    expect(output(result)).not.toMatch(/fetch failed|ECONNREFUSED/i);
  }, 20000);

  it("still allows loopback HTTP, which then fails at the socket rather than the rule", async () => {
    const result = await run(["call", "hi"], withPassport("http://127.0.0.1:1"));
    expect(result.stderr).not.toMatch(/must be a bare HTTPS origin/);
    expect(output(result)).toMatch(/fetch failed|ECONNREFUSED|connect/i);
  }, 20000);

  // Ordering, made observable. With BOTH a refused gateway and no passport, the
  // error that surfaces says which check ran first — and the destination must be
  // judged before the secret is read, let alone signed with.
  it("validates the destination before it reads the passport credentials", async () => {
    const result = await run(["call", "hi"], { PASSCONTROL_GATEWAY: "http://gw.example.com:1" });
    expect(result.stderr).toMatch(/PASSCONTROL_GATEWAY must be a bare HTTPS origin/);
    expect(output(result)).not.toMatch(/No passport configured/);
  }, 20000);

  // `call` announced its destination (`→ anthropic/… via <gateway>`) before it
  // validated anything, so a gateway carrying userinfo printed the password to
  // the terminal — and into any CI log scraping that output.
  it("never prints a credential embedded in the gateway", async () => {
    const result = await run(["call", "hi"], withPassport("https://admin:hunter2@gw.example.com"));
    expect(result.stderr).toMatch(/PASSCONTROL_GATEWAY must be a bare HTTPS origin/);
    expect(output(result)).not.toContain("hunter2");
    expect(output(result)).not.toContain("admin:");
  }, 20000);
});

// `try` signs with the SEEDED DEMO passport rather than the user's, so it needs
// no credentials in the environment — and it reaches the network faster than any
// other command. It also builds a `/api/control/v1/kill-switch` PUT from the
// gateway directly instead of going through the guarded `api()` helper, so it is
// the one entrypoint that puts both a passport signature and a control-plane
// bearer on the same unvalidated destination.
describe("passcontrol try — the demo passport takes the same route", () => {
  it("refuses a non-loopback HTTP gateway before signing or arming anything", async () => {
    const result = await run(["try"], { PASSCONTROL_GATEWAY: "http://gw.example.com:1" });
    expect(output(result)).toMatch(/PASSCONTROL_GATEWAY must be a bare HTTPS origin/);
    expect(output(result)).not.toMatch(/fetch failed|ECONNREFUSED|kill switch/i);
  }, 20000);
});

describe("the long-running passport entrypoints refuse before they start", () => {
  // Both would otherwise bind a port / attach a stdio transport and then mint on
  // demand, so a refusal has to land before the process settles into serving.
  it.each([
    ["sidecar", ["sidecar", "--port", "8797"]],
    ["mcp", ["mcp"]],
  ])("%s refuses a non-loopback HTTP gateway", async (_name, args) => {
    const result = await run(args, {
      PASSCONTROL_GATEWAY: "http://gw.example.com:1",
      PASSPORT_ID,
      PASSPORT_SECRET,
    });
    expect(result.stderr).toMatch(/PASSCONTROL_GATEWAY must be a bare HTTPS origin/);
    expect(output(result)).not.toMatch(/Listening on|fetch failed/);
  }, 20000);
});

// This finding was a missed sibling call site, not a missing idea — the rule
// already existed and one family of callers never used it. So the check that
// actually prevents a recurrence is structural: no credential-bearing request
// may be built from the unvalidated configuration string.
describe("no passport-path URL is built from the raw gateway string", () => {
  const CREDENTIAL_PATH_FILES = [
    "bin/passcontrol.mjs",
    "cli/visa-client.mjs",
    "cli/sidecar.mjs",
    "cli/mcp/gateway.mjs",
  ];

  // Provenance, not spelling. A name like `gateway` or `baseUrl` says nothing on
  // its own — `cli/mcp/gateway.mjs` used to call its raw value `baseUrl` because
  // it had passed through `trimSlash`, which tidies a string without judging the
  // destination. So each base expression is traced back to its assignment in the
  // same file, and every assignment must come from the rule.
  // probeGatewayOrigin is the credential-free member of this family: same
  // bareGatewayOrigin call, returning null instead of throwing, for reports
  // like `passcontrol version` that must not abort on a bad gateway.
  const VALIDATOR =
    /bareGatewayOrigin\(|requirePassportGateway\(|requireControlGateway\(|probeGatewayOrigin\(/;
  // The shape of the defect itself: the configuration string, or a cosmetic
  // tidy-up of it, standing in for a validated destination.
  const RAW_CONFIG = /config\.gateway|current\.gateway|trimSlash\(|opts\.gateway/;

  it.each(CREDENTIAL_PATH_FILES)("%s builds fetch URLs only from a validated origin", (file) => {
    const source = readFileSync(join(repo, file), "utf8");
    // The first interpolation in a fetch template is the base the request is
    // built on: `fetch(`${x}/api/…`)`.
    const bases = [...new Set(
      [...source.matchAll(/fetch\w*\(\s*`\$\{([^}]+)\}/g)].map((match) => (match[1] ?? "").trim())
    )];
    expect(bases.length).toBeGreaterThan(0);

    const unvalidated: string[] = [];
    for (const base of bases) {
      // A property read (`config.gateway`) can never be a validated local.
      if (!/^[A-Za-z_$][\w$]*$/.test(base)) {
        unvalidated.push(base);
        continue;
      }
      const assignments = [...source.matchAll(
        new RegExp(`(?:const|let|var)\\s+${base}\\s*=\\s*([^;\\n]+)`, "g")
      )].map((match) => match[1] ?? "");
      // Two conditions, because `bin/passcontrol.mjs` reuses the name `gateway`
      // in other functions for a health-check RESULT that is never a URL:
      // requiring *every* assignment to be a validated origin would fail on
      // those. So — the name must be produced by the rule somewhere, and must
      // never be produced from the configuration string, which is precisely the
      // regression this file exists to catch.
      const validated = assignments.some((rhs) => VALIDATOR.test(rhs));
      const fromRawConfig = assignments.some((rhs) => RAW_CONFIG.test(rhs));
      if (!validated || fromRawConfig) unvalidated.push(base);
    }
    expect(unvalidated).toEqual([]);
  });
});

describe("probeGatewayOrigin — the credential-free member of the family", () => {
  // `passcontrol version` reads an unauthenticated endpoint, so nothing secret
  // travels. It is still bound by the same origin rule, for two reasons that
  // are not about secrecy: a diagnostic that reports a stranger's build as your
  // gateway's is worse than one that reports nothing, and an unvalidated
  // destination makes the command a beacon a checked-in `.passcontrol` can aim.
  it("returns a bare origin for a legitimate gateway", () => {
    expect(probeGatewayOrigin({ gateway: "https://passcontrol.example.com" })).toBe(
      "https://passcontrol.example.com"
    );
    expect(probeGatewayOrigin({ gateway: "http://127.0.0.1:3000" })).toBe("http://127.0.0.1:3000");
  });

  it("refuses everything bareGatewayOrigin refuses, without throwing", () => {
    const hostile = [
      "http://attacker.example.com",            // plain HTTP off-loopback
      "https://trusted.example@attacker.example", // userinfo
      "https://attacker.example/path/prefix",   // path prefix
      "https://attacker.example/?x=1",          // query
      "https://attacker.example/#f",            // fragment
      "not-a-url",
      "",
      undefined,
    ];
    for (const gateway of hostile) {
      expect(probeGatewayOrigin({ gateway })).toBeNull();
    }
  });
});
