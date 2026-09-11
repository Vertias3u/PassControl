import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs CLI module, no types
import { createPassportCredentialStore, migratePassportKey, runProcess } from "../cli/passport-key-store.mjs";

/**
 * Integration test against the REAL OS credential helper — no injected `run` seam.
 *
 * The seam-based tests in passport-key-store.test.ts model a helper that returns
 * status 0 and echoes a readback. `security(1)` does neither on the failing path:
 * `add-generic-password -w` with no argv value runs an interactive double prompt
 * ("password data for new item: retype password for new item:"), consumes one line
 * of stdin, hits EOF on the retype, and then STORES AN EMPTY PASSWORD AND EXITS 0.
 * A fake runner cannot express that, so the whole tier 1 feature was green in CI and
 * broken on every Mac. This test is the only thing in the suite that can see it.
 *
 * Skipped off-darwin: there is no Linux/Windows runner on this machine to test
 * against, and asserting a helper that is not installed proves nothing.
 */
const onMac = process.platform === "darwin";

describe.skipIf(!onMac)("macOS Keychain, against the real security(1) binary", () => {
  // Unique per run so a parallel or interrupted run cannot collide or leak state.
  const passportId = `pc-test-${process.pid}-${Date.now()}`;
  const secret = "private-key-material-that-must-survive-a-round-trip";

  it("stores a key that reads back byte-for-byte", () => {
    const store = createPassportCredentialStore();
    try {
      expect(store.write(passportId, secret)).toMatchObject({ ok: true });

      const readback = store.read(passportId);
      expect(readback.ok).toBe(true);
      // The bug produced ok:true with an empty string here.
      expect(readback.secret).toBe(secret);
    } finally {
      store.delete(passportId);
    }
  });

  it("migrates and then deletes, leaving no item behind", () => {
    const store = createPassportCredentialStore();
    let fileRemoved = false;
    try {
      const result = migratePassportKey({
        passportId,
        secret,
        store,
        removeFileSecret: () => { fileRemoved = true; },
      });

      expect(result).toMatchObject({ ok: true, tier: 1 });
      expect(fileRemoved).toBe(true);
    } finally {
      expect(store.delete(passportId)).toMatchObject({ ok: true });
      // logout must leave nothing recoverable.
      expect(store.read(passportId).ok).toBe(false);
    }
  });
});

/**
 * The seam tests above model a hung helper as `{ timedOut, sawPasswordPrompt }`.
 * That shape is only worth anything if the REAL runner produces it, which is the
 * same trap as the original bug: a fake agreed with itself while `security(1)`
 * did something else. So this drives a genuine subprocess that stalls, once with
 * the prompt on stderr and once silent, and checks the two bits come back.
 *
 * `/bin/sh` stands in for `security` deliberately — the point under test is
 * runProcess's timeout accounting, not the Keychain, and a script can stall on
 * demand where the real binary cannot be made to.
 */
describe.skipIf(process.platform === "win32")("runProcess, against a subprocess that really stalls", () => {
  const stall = (before: string) =>
    runProcess("/bin/sh", ["-c", `${before}; sleep 30`], { input: "key\n", timeoutMs: 750 });

  it("reports a hang as a timeout, not as a helper that failed to start", () => {
    const result = stall(":");
    expect(result).toMatchObject({ timedOut: true, failedToStart: false });
    expect(result.status).not.toBe(0);
  });

  it("sees the password prompt on stderr, and its absence, without returning either", () => {
    expect(stall("printf 'password data for new item: ' >&2")).toMatchObject({
      timedOut: true,
      sawPasswordPrompt: true,
    });
    expect(stall("printf 'something else entirely' >&2")).toMatchObject({
      timedOut: true,
      sawPasswordPrompt: false,
    });
  });

  it("never hands stderr itself back to a caller", () => {
    const result = stall("printf 'password data for new item: secret-leak' >&2");
    expect(JSON.stringify(result)).not.toContain("secret-leak");
  });
});

/**
 * The same round-trip, under a REAL CONTROLLING TERMINAL.
 *
 * Everything above this point passes on broken code, and did for months. Vitest,
 * CI and every agent shell run without a controlling tty, and `security(1)` only
 * reaches for one when it has one: given a tty it opens /dev/tty for its double
 * prompt and IGNORES the stdin pipe entirely, so the write hangs until the helper
 * timeout and the key never lands. Without a tty it falls back to stdin and the
 * exact same code works. The feature was therefore green everywhere it was ever
 * measured and broken in the only place it is ever used — a human's terminal.
 *
 * A pty is the only instrument that can tell those two apart, so the test owns
 * one instead of inheriting whatever the runner happened to have.
 */
describe.skipIf(!onMac)("macOS Keychain, from a terminal that has a controlling tty", () => {
  const ptyRunner = resolve(process.cwd(), "tests/fixtures/keychain-round-trip.mjs");

  it("stores and reads back a key when a controlling tty is present", () => {
    // python3 ships with the Xcode command line tools, which this project already
    // requires to build. If it is genuinely absent, say so rather than skipping:
    // a silent skip here restores the exact blind spot this block exists to close.
    const havePython = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" });
    expect(
      havePython.status,
      "python3 with the pty module is required to allocate a controlling terminal for this test"
    ).toBe(0);

    const result = spawnSync(
      "python3",
      ["-c", "import pty,sys; sys.exit(pty.spawn([sys.argv[1], sys.argv[2]]))", process.execPath, ptyRunner],
      { encoding: "utf8", timeout: 60_000 }
    );

    const out = String(result.stdout ?? "").replace(/\r/gu, "");
    // The failing shape is specific and worth asserting by name: security(1)
    // printing its prompt is proof it went to the tty instead of stdin.
    expect(out, out).not.toContain("password data for new item");
    expect(out, out).toContain("ROUND_TRIP_OK");
  });
});
