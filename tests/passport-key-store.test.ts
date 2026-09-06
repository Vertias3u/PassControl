import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — plain .mjs CLI module, no types
import { createPassportCredentialStore, migratePassportKey, resolvePassportKey } from "../cli/passport-key-store.mjs";
// @ts-expect-error — plain .mjs CLI module, no types
import { mergeConfigFile, writeConfigFile } from "../cli/config.mjs";

const PASSPORT_ID = "passport-public-id";
const SECRET = "private-key-material-that-must-never-enter-argv";

function successfulRunner(readback = SECRET) {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  const run = (command: string, args: string[], options: { input?: string } = {}) => {
    calls.push({ command, args, input: options.input });
    const reads = args.includes("find-generic-password") || args.includes("lookup") ||
      args.some((arg) => arg.includes("ConvertTo-SecureString"));
    return { status: 0, stdout: reads ? readback : "", stderr: "" };
  };
  return { calls, run };
}

describe.each(["darwin", "linux", "win32"] as const)("%s passport credential store", (platform) => {
  it("passes the private key on stdin and never in an argv array", () => {
    const fake = successfulRunner();
    const store = createPassportCredentialStore({
      platform,
      run: fake.run,
      env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
      ensureDirectory: vi.fn(),
    });

    expect(store.write(PASSPORT_ID, SECRET)).toMatchObject({ ok: true });
    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(fake.calls[0]?.args)).not.toContain(SECRET);
    expect(fake.calls[0]?.input).toContain(SECRET);
  });
});

describe("passport key migration", () => {
  it("registers key status and migrate in help, dispatch, and persisted config", () => {
    const cli = fs.readFileSync(path.join(process.cwd(), "bin/passcontrol.mjs"), "utf8");
    const config = fs.readFileSync(path.join(process.cwd(), "cli/config.mjs"), "utf8");

    expect(cli).toContain("key status");
    expect(cli).toContain("key migrate");
    expect(cli).toMatch(/case "key":\s+await keyCommand/u);
    const init = cli.slice(cli.indexOf("async function initCommand"), cli.indexOf("async function mintVisa"));
    expect(init).not.toMatch(/ask\([^\n]*Passport Secret[^\n]*config\.passportSecret/u);
    expect(init).toContain("PASSPORT_KEY_STORAGE:");
    expect(config).toContain('"PASSPORT_KEY_STORAGE"');
    expect(config).toMatch(/if \(storage\?\.fallback\) warn/u);

    const login = fs.readFileSync(path.join(process.cwd(), "cli/login.mjs"), "utf8");
    const logout = fs.readFileSync(path.join(process.cwd(), "cli/logout.mjs"), "utf8");
    expect(login).toContain('PASSPORT_KEY_STORAGE: ""');
    expect(logout).toContain('PASSPORT_KEY_STORAGE: ""');
  });

  it("does not add a marker to tier 0 files and persists it only when selected", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pc-key-config-"));
    const file = path.join(directory, ".passcontrol");
    try {
      writeConfigFile(file, { PASSPORT_ID, PASSPORT_SECRET: SECRET });
      expect(fs.readFileSync(file, "utf8")).not.toContain("PASSPORT_KEY_STORAGE");

      mergeConfigFile(file, { PASSPORT_KEY_STORAGE: "os" });
      expect(fs.readFileSync(file, "utf8")).toContain("PASSPORT_KEY_STORAGE=os");

      mergeConfigFile(file, { PASSPORT_KEY_STORAGE: "" });
      const reset = fs.readFileSync(file, "utf8");
      expect(reset).not.toContain("PASSPORT_KEY_STORAGE");
      expect(reset).toContain(`PASSPORT_SECRET=${SECRET}`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does exactly write, readback, compare, then remove", () => {
    const order: string[] = [];
    const store = {
      name: "mock OS store",
      write: () => {
        order.push("write");
        return { ok: true as const };
      },
      read: () => {
        order.push("read");
        return { ok: true as const, secret: SECRET };
      },
    };

    const result = migratePassportKey({
      passportId: PASSPORT_ID,
      secret: SECRET,
      store,
      removeFileSecret: () => order.push("remove"),
    });

    expect(result).toMatchObject({ ok: true, tier: 1 });
    expect(order).toEqual(["write", "read", "remove"]);
  });

  it("leaves the file in place and reports a failed readback without the key", () => {
    const removeFileSecret = vi.fn();
    const result = migratePassportKey({
      passportId: PASSPORT_ID,
      secret: SECRET,
      store: {
        name: "mock OS store",
        write: () => ({ ok: true as const }),
        read: () => ({ ok: false as const, reason: "credential store readback failed" }),
      },
      removeFileSecret,
    });

    expect(result).toMatchObject({ ok: false, tier: 0 });
    expect(result.message).toMatch(/readback failed|could not be read back/iu);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(removeFileSecret).not.toHaveBeenCalled();
  });

  it("falls back explicitly to the tier 0 file when the preferred store is unavailable", () => {
    const resolved = resolvePassportKey({
      passportId: PASSPORT_ID,
      fileSecret: SECRET,
      fileLabel: "/tmp/project/.passcontrol",
      storageMarker: "os",
      store: {
        name: "mock OS store",
        write: () => ({ ok: false as const, reason: "unavailable" }),
        read: () => ({ ok: false as const, reason: "unavailable" }),
      },
    });

    expect(resolved).toMatchObject({
      secret: SECRET,
      storage: { tier: 0, fallback: true, source: "/tmp/project/.passcontrol" },
    });
    expect(resolved.storage.message).toMatch(/tier 0|file fallback/iu);
    expect(resolved.storage.message).not.toContain(SECRET);
  });

  it("keeps an explicit tier 0 environment secret above a persisted store marker", () => {
    const read = vi.fn(() => ({ ok: true as const, secret: "stored-secret" }));
    const resolved = resolvePassportKey({
      passportId: PASSPORT_ID,
      fileSecret: SECRET,
      fileLabel: "environment variable",
      preferFileSecret: true,
      storageMarker: "os",
      store: {
        name: "mock OS store",
        write: () => ({ ok: true as const }),
        read,
      },
    });

    expect(resolved).toMatchObject({
      secret: SECRET,
      storage: { tier: 0, source: "environment variable", fallback: false },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("captures raw subprocess stderr and returns only a fixed, secret-free failure", () => {
    const store = createPassportCredentialStore({
      platform: "linux",
      run: () => ({ status: 1, stdout: "", stderr: `helper exploded: ${SECRET}` }),
    });
    const write = store.write(PASSPORT_ID, SECRET);

    expect(write).toMatchObject({ ok: false });
    expect(JSON.stringify(write)).not.toContain(SECRET);
    expect(JSON.stringify(write)).not.toContain("helper exploded");
  });

  it("turns a throwing subprocess runner into a fixed secret-free failure", () => {
    const store = createPassportCredentialStore({
      platform: "linux",
      run: () => {
        throw new Error(`runner included stdin: ${SECRET}`);
      },
    });

    expect(() => store.write(PASSPORT_ID, SECRET)).not.toThrow();
    expect(JSON.stringify(store.write(PASSPORT_ID, SECRET))).not.toContain(SECRET);
  });
});

// ── Removing a key is only reported when the helper says it happened ────────
//
// `read()` collapses every failure into one shape on purpose, so an unreadable
// item cannot tell "gone" apart from "keychain locked" or "helper missing".
// Deleting on that evidence made `logout` print a success line over a private
// key that was still there.
describe("deleting a stored passport key", () => {
  const lockedRunner = () => ({
    // Delete refuses, and the subsequent read fails the way a locked store does.
    run: () => ({ status: 1, stdout: "", stderr: "" }),
  });

  it("reports failure when the helper refused, even though the item reads as absent", () => {
    const store = createPassportCredentialStore({
      platform: "darwin",
      run: lockedRunner().run,
    });
    expect(store.read(PASSPORT_ID).ok).toBe(false);
    expect(store.delete(PASSPORT_ID)).toMatchObject({ ok: false });
  });

  it("treats an already-absent macOS item as a successful removal", () => {
    const store = createPassportCredentialStore({
      platform: "darwin",
      // 44 is errSecItemNotFound: nothing to delete, which is what was asked for.
      run: (_command: string, args: string[]) =>
        args.includes("delete-generic-password")
          ? { status: 44, stdout: "", stderr: "" }
          : { status: 1, stdout: "", stderr: "" },
    });
    expect(store.delete(PASSPORT_ID)).toMatchObject({ ok: true });
  });

  it("reports failure when the item is still readable afterwards", () => {
    const store = createPassportCredentialStore({
      platform: "linux",
      run: (_command: string, args: string[]) =>
        args.includes("lookup")
          ? { status: 0, stdout: SECRET, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(store.delete(PASSPORT_ID)).toMatchObject({ ok: false });
  });
});

// ── A helper that hangs is a third outcome, and it has to say which hang ─────
//
// `security add-generic-password -w` has two distinct ways to stop answering,
// and they need opposite responses from the operator:
//
//   • it printed "password data for new item:" and then waited forever — the
//     prompt was reached and the key never got handed over on stdin;
//   • it printed nothing at all — it never got as far as the prompt, which is
//     what a locked Keychain (or its unanswered unlock dialog) looks like.
//
// Both surface today as the same "macOS Keychain write failed", and both are
// indistinguishable from "security(1) is not installed", because a spawn
// timeout sets `error` and so collapses into `failedToStart`. A ten-second
// wall-clock stall with no explanation is what an operator actually gets, so
// the timeout carries one derived bit — was the prompt seen — and nothing else.
describe("a credential helper that stops answering", () => {
  const hung = (sawPasswordPrompt: boolean) => () => ({
    status: null,
    stdout: "",
    failedToStart: false,
    timedOut: true,
    sawPasswordPrompt,
  });

  it("blames the stdin hand-off when security(1) did reach its password prompt", () => {
    const store = createPassportCredentialStore({ platform: "darwin", run: hung(true) });
    const written = store.write(PASSPORT_ID, SECRET);

    expect(written).toMatchObject({ ok: false });
    expect(written.reason).toMatch(/did not respond/iu);
    expect(written.reason).toMatch(/stdin/iu);
    expect(written.reason).not.toMatch(/locked/iu);
    expect(JSON.stringify(written)).not.toContain(SECRET);
  });

  it("points at a locked Keychain when security(1) never reached its prompt", () => {
    const store = createPassportCredentialStore({ platform: "darwin", run: hung(false) });
    const written = store.write(PASSPORT_ID, SECRET);

    expect(written).toMatchObject({ ok: false });
    expect(written.reason).toMatch(/did not respond/iu);
    expect(written.reason).toMatch(/locked/iu);
  });

  it("says a read or a delete hung rather than that the item is merely unavailable", () => {
    const store = createPassportCredentialStore({ platform: "darwin", run: hung(false) });
    expect(store.read(PASSPORT_ID).reason).toMatch(/did not respond/iu);
    expect(store.delete(PASSPORT_ID).reason).toMatch(/did not respond/iu);
  });

  it("reports a hang on every platform's helper, not only macOS", () => {
    for (const platform of ["linux", "win32"] as const) {
      const store = createPassportCredentialStore({
        platform,
        run: hung(false),
        env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
        ensureDirectory: vi.fn(),
      });
      expect(store.write(PASSPORT_ID, SECRET).reason).toMatch(/did not respond/iu);
    }
  });

  it("does not describe a helper that never started as one that stopped answering", () => {
    const store = createPassportCredentialStore({
      platform: "darwin",
      run: () => ({ status: null, stdout: "", failedToStart: true, timedOut: false }),
    });
    expect(store.write(PASSPORT_ID, SECRET).reason).not.toMatch(/did not respond/iu);
  });

  it("carries the store's own reason into the migration message the operator reads", () => {
    const store = createPassportCredentialStore({ platform: "darwin", run: hung(false) });
    const removeFileSecret = vi.fn();
    const result = migratePassportKey({
      passportId: PASSPORT_ID,
      secret: SECRET,
      store,
      removeFileSecret,
    });

    expect(result).toMatchObject({ ok: false, tier: 0 });
    expect(result.message).toMatch(/locked/iu);
    expect(result.message).toMatch(/left untouched/iu);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(removeFileSecret).not.toHaveBeenCalled();
  });
});
