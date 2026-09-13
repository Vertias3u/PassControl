import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CLI module, no types
import { bareGatewayOrigin, shellQuotingHint } from "../cli/config.mjs";

// `cmd.exe` has no single-quote quoting. A Windows operator who copies a POSIX
// invocation out of a README —
//
//   passcontrol passport import --global --gateway 'http://localhost:3000' --id '…'
//
// — hands the CLI an argv entry with the quotes still attached, and every
// validator downstream then refuses a value that looks perfectly correct on the
// line they typed. The message they got was "--gateway must be an absolute URL",
// which is true of the string that arrived and says nothing about why.
//
// This repo has already paid for the same trap once: `npm run dev:docker` used
// to be a bash one-liner in single quotes, npm ran it through cmd, and bash
// received `'set` as its entire command. See scripts/dev-docker.mjs's header.
//
// The fix is NOT to strip the quotes. bareGatewayOrigin exists to keep stray
// material out of a URL the control key is then sent to, and lenient
// normalization upstream of a deliberately strict rule is the wrong direction.
// Validation stays exactly as strict; the message learns to name the cause.

const ROOT = path.resolve(import.meta.dirname, "..");

describe("the quoted-argument hint", () => {
  it("fires on a value wrapped in single quotes, and names cmd.exe", () => {
    const hint = shellQuotingHint("'http://localhost:3000'");
    expect(hint).toMatch(/single quote/);
    expect(hint).toMatch(/cmd\.exe/);
  });

  it("fires on double quotes too, without blaming cmd — cmd strips those", () => {
    const hint = shellQuotingHint('"http://localhost:3000"');
    expect(hint).toMatch(/double quote/);
    expect(hint).not.toMatch(/cmd\.exe/);
  });

  it("stays silent on everything that is not wrapped in one quote character", () => {
    for (const value of [
      "http://localhost:3000",
      "",
      "'",
      '"',
      "'unterminated",
      "unopened'",
      "'mixed\"",
      "it's fine",
    ]) {
      expect(shellQuotingHint(value), JSON.stringify(value)).toBe("");
    }
  });

  // Same rule as the refusal it is appended to: a gateway URL or a passport id
  // can itself be a credential, so the hint describes the shape and never the
  // value. tests/cli-control-gateway.test.ts pins the other half of this.
  it("never echoes the value", () => {
    const hint = shellQuotingHint("'https://admin:hunter2@gw.example.com'");
    expect(hint).not.toContain("hunter2");
    expect(hint).not.toContain("gw.example.com");
  });
});

describe("the validators that operators hit it through", () => {
  it("explains a quoted --gateway instead of only refusing it", () => {
    expect(() => bareGatewayOrigin("'http://localhost:3000'", "--gateway")).toThrow(/cmd\.exe/);
  });

  it("still refuses it — the hint is an explanation, not a repair", () => {
    expect(() => bareGatewayOrigin("'http://localhost:3000'", "--gateway")).toThrow();
    // The unquoted form is the one that works, and it is unchanged.
    expect(bareGatewayOrigin("http://localhost:3000", "--gateway")).toBe("http://localhost:3000");
  });

  it("explains a quoted --id, which fails its own encoding check", () => {
    const cli = readFileSync(path.join(ROOT, "bin/passcontrol.mjs"), "utf8");
    const from = cli.indexOf("async function passportCommand");
    const body = cli.slice(from, cli.indexOf("\nasync function ", from + 1));
    expect(body).toMatch(/--id must be a 32-byte Ed25519 public key/);
    expect(body, "the id rejection must carry the hint too").toContain("shellQuotingHint(");
  });
});
