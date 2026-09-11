// `keygen instance --retire <seed>` through the REAL binary.
//
// This file exists because the unit test underneath it passed while the command
// did not work at all. `retiredKeyEntry` was correct and covered; the command
// read its flag out of the positional array, which `parseArgv` has already
// emptied of every `--flag`. So the branch never ran and the command fell
// through to GENERATING A NEW KEY — printing a fresh `INSTANCE_SIGNING_KEY=…`
// under a success tick, in response to being handed a live deployment's seed.
// An operator following the rotation instructions would have pasted a brand new
// key nothing had signed with into their key history and believed the old
// receipts were preserved.
//
// The helper being right is not evidence the command is. Only running it is.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { bytesToBase64url } from "@/lib/encoding";
import { publicJwk } from "@/lib/crypto/instanceKey";

const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "bin/passcontrol.mjs");

const SEED_BYTES = new Uint8Array(32).fill(11);
const SEED = bytesToBase64url(SEED_BYTES);
const JWK = publicJwk(ed25519.getPublicKey(SEED_BYTES));

const run = (args: string[]) =>
  execFileAsync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PASSCONTROL_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
  });

describe("passcontrol keygen instance --retire", () => {
  it("prints the kid:public pair for the seed it was given", async () => {
    const { stdout } = await run(["keygen", "instance", "--retire", SEED]);

    expect(stdout).toContain(`${JWK.kid}:${JWK.x}`);
    expect(stdout).toContain("INSTANCE_SIGNING_KEY_HISTORY");
  });

  // The failure mode that got past the unit test: a fall-through to keygen.
  it("does not generate a new key, and never echoes the seed it was handed", async () => {
    const { stdout } = await run(["keygen", "instance", "--retire", SEED]);

    expect(stdout).not.toContain("INSTANCE_SIGNING_KEY=");
    expect(stdout).not.toContain("Generated an Ed25519");
    expect(stdout).not.toContain(SEED);
  });

  it("accepts the --retire=<seed> spelling too", async () => {
    const { stdout } = await run(["keygen", "instance", `--retire=${SEED}`]);
    expect(stdout).toContain(`${JWK.kid}:${JWK.x}`);
  });

  it.each([["nope"], [bytesToBase64url(new Uint8Array(16))]])(
    "refuses %j rather than printing a pair for it",
    async (bad) => {
      await expect(run(["keygen", "instance", "--retire", bad])).rejects.toThrow(
        /32 bytes|Usage/
      );
    }
  );

  it("refuses the flag with no seed after it", async () => {
    await expect(run(["keygen", "instance", "--retire"])).rejects.toThrow(/Usage/);
  });

  // Plain keygen must keep working exactly as before.
  it("still generates a key when --retire is absent", async () => {
    const { stdout } = await run(["keygen", "instance"]);
    expect(stdout).toContain("INSTANCE_SIGNING_KEY=");
    expect(stdout).toContain("keygen instance --retire");
  });
});
