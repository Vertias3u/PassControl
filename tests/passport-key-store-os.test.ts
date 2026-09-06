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
