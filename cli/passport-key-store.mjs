import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PASSPORT_KEY_STORAGE_OS = "os";

const SERVICE = "eu.vertias.passcontrol.passport";
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * The one prompt string this module ever matches stderr against, reduced
 * immediately to a boolean. See `sawPasswordPrompt` below.
 */
const MACOS_PASSWORD_PROMPT = /password data for new item/iu;

/**
 * Exported for tests/passport-key-store-os.test.ts, which drives a real stalling
 * subprocess through it. The seam tests can only assert the *shape* returned
 * here; something has to check a real process still produces it. `timeoutMs`
 * exists for the same reason — so that check costs under a second instead of the
 * full helper timeout.
 */
export function runProcess(
  command,
  args,
  { input = "", env = {}, timeoutMs = COMMAND_TIMEOUT_MS, detached = false } = {}
) {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    // `detached` puts the child in its own session (setsid), which leaves it with
    // NO controlling terminal. Only one caller wants that and it is documented at
    // that call site; it is off by default because on Windows the same flag opens
    // a new console window, which no adapter here has any use for.
    detached,
  });
  // Deliberately omit stderr and the native Error object. Helpers sometimes
  // repeat their input in diagnostics, and no caller may log that raw text.
  //
  // Two derived bits leave, and only two. A timeout is not the same failure as a
  // helper that is not installed, though `error` is set for both — and when a
  // helper stalls, whether it had already printed its password prompt is the
  // difference between "it never took the key on stdin" and "it never got that
  // far, so the store is probably locked". Both are booleans computed from a
  // fixed literal; neither can carry a byte of the helper's output outward.
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    failedToStart: Boolean(result.error) && !timedOut,
    timedOut,
    sawPasswordPrompt: MACOS_PASSWORD_PROMPT.test(stderr),
  };
}

function passed(result) {
  return result && result.status === 0 && !result.failedToStart;
}

function invoke(run, command, args, options) {
  try {
    return run(command, args, options);
  } catch {
    // A thrown helper error is no safer to surface than stderr: an adapter or
    // platform runtime may attach stdin to it. Collapse it to fixed state.
    return { status: null, stdout: "", failedToStart: true, timedOut: false, sawPasswordPrompt: false };
  }
}

function fixedFailure(reason) {
  return { ok: false, reason };
}

/**
 * A helper that stalls and a helper that refuses are different problems for the
 * operator, and only one of them is fixed by unlocking something. Every adapter
 * routes its failures through here so a hang is never reported as "unavailable"
 * or "did not confirm the removal" — the sentences that made a ten-second stall
 * read as a missing item.
 */
function helperTimeout(name) {
  return `${name} did not respond within ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s`;
}

function helperFailure(name, result, reason) {
  return fixedFailure(result?.timedOut ? helperTimeout(name) : reason);
}

/** security(1) exit code for errSecItemNotFound — nothing to delete. */
const MACOS_ITEM_NOT_FOUND = 44;

/**
 * A removal is confirmed by POSITIVE evidence from the helper, never by a
 * failed read.
 *
 * `read()` deliberately collapses every failure into one fixed shape to keep
 * stderr away from callers, so "the item is gone", "the keychain is locked" and
 * "the helper is not installed" are indistinguishable from here. Concluding
 * success from an unreadable item would make a locked keychain print
 * "removed the passport key" over a key that is still sitting in it — the one
 * sentence `logout` must never get wrong.
 *
 * So `deleted` carries the helper's own verdict, and the read is only a
 * secondary check: a still-readable item disproves the removal, an unreadable
 * one proves nothing either way.
 */
function confirmGone(store, passportId, name, deleted) {
  if (!deleted) return fixedFailure(`${name} did not confirm the removal`);
  return store.read(passportId).ok
    ? fixedFailure(`${name} still holds the passport key`)
    : { ok: true };
}

function windowsStateRoot(env) {
  return env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function windowsBlobPath(passportId, env) {
  const id = createHash("sha256").update(passportId).digest("hex");
  return path.join(windowsStateRoot(env), "PassControl", "passport-keys", `${id}.dpapi`);
}

const WINDOWS_WRITE = [
  "$plain = [Console]::In.ReadToEnd()",
  "$secure = ConvertTo-SecureString $plain -AsPlainText -Force",
  "$cipher = ConvertFrom-SecureString $secure",
  "[IO.File]::WriteAllText($env:PASSCONTROL_DPAPI_BLOB, $cipher)",
].join("; ");

const WINDOWS_READ = [
  "$cipher = [IO.File]::ReadAllText($env:PASSCONTROL_DPAPI_BLOB)",
  "$secure = ConvertTo-SecureString $cipher",
  "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
].join("; ");

/**
 * OS credential storage with an injectable subprocess seam for CI.
 * Private key material is supplied only through stdin, never argv.
 */
export function createPassportCredentialStore({
  platform = process.platform,
  env = process.env,
  run = runProcess,
  ensureDirectory = (directory) => fs.mkdirSync(directory, { recursive: true, mode: 0o700 }),
  removeFile = (file) => fs.rmSync(file, { force: true }),
} = {}) {
  if (platform === "darwin") {
    return {
      name: "macOS Keychain",
      write(passportId, secret) {
        // `-w` with no argv value does NOT read stdin as a value. It runs an
        // interactive double prompt — "password data for new item:" then
        // "retype password for new item:" — so the secret has to be answered
        // TWICE. Sending it once lets the retype hit EOF, at which point
        // security(1) stores an EMPTY password and still exits 0. That is why
        // the value cannot simply move to argv instead: argv is world-readable
        // in `ps`, and this is a private key. Verified against security(1) on
        // macOS 15; tests/passport-key-store-os.test.ts is what holds it.
        if (/[\r\n]/u.test(secret)) {
          return fixedFailure("macOS Keychain cannot store a key containing a newline");
        }
        // `detached` is what makes the stdin above reachable, and without it none
        // of the reasoning in the comment above holds. Given a controlling
        // terminal, security(1) does not read the prompt from stdin at all — it
        // opens /dev/tty and asks the human, so the pipe is ignored, the write
        // stalls until the helper timeout, and the key never lands. Detaching the
        // child into its own session removes the terminal it would have reached
        // for, and it falls back to stdin, which is where the secret already is.
        //
        // The consequence of getting this wrong is not a flaky test: it is that
        // the feature works in every context that has no tty — CI, an agent shell,
        // a piped script — and fails in the ONLY context that has one, which is a
        // person at a terminal. tests/passport-key-store-os.test.ts owns a pty for
        // exactly this reason.
        const result = invoke(run,
          "security",
          ["add-generic-password", "-U", "-a", passportId, "-s", SERVICE, "-w"],
          { input: `${secret}\n${secret}\n`, detached: true }
        );
        if (result.timedOut) {
          // The one place the prompt bit earns its keep: `security` stalling
          // after its prompt means stdin never landed, stalling before it means
          // it never reached the Keychain at all.
          return fixedFailure(result.sawPasswordPrompt
            ? `${helperTimeout(this.name)} after asking for the password — the key was never accepted on stdin`
            : `${helperTimeout(this.name)} and never reached its password prompt — the Keychain is probably locked`);
        }
        return passed(result) ? { ok: true } : fixedFailure("macOS Keychain write failed");
      },
      read(passportId) {
        const result = invoke(run,
          "security",
          ["find-generic-password", "-a", passportId, "-s", SERVICE, "-w"]
        );
        return passed(result)
          ? { ok: true, secret: String(result.stdout).replace(/\r?\n$/u, "") }
          : helperFailure(this.name, result, "macOS Keychain item unavailable");
      },
      delete(passportId) {
        const result = invoke(run, "security", ["delete-generic-password", "-a", passportId, "-s", SERVICE]);
        if (result.timedOut) return fixedFailure(helperTimeout(this.name));
        // Already absent is a successful logout, not a failure — the operator
        // asked for the key to be gone, and it is.
        const deleted = passed(result) ||
          (!result.failedToStart && result.status === MACOS_ITEM_NOT_FOUND);
        return confirmGone(this, passportId, "macOS Keychain", deleted);
      },
    };
  }

  if (platform === "linux") {
    return {
      name: "Linux Secret Service",
      write(passportId, secret) {
        const result = invoke(run,
          "secret-tool",
          ["store", "--label=PassControl passport key", "service", SERVICE, "passport-id", passportId],
          { input: secret }
        );
        return passed(result) ? { ok: true } : helperFailure(this.name, result, "Linux Secret Service unavailable");
      },
      read(passportId) {
        const result = invoke(run,
          "secret-tool",
          ["lookup", "service", SERVICE, "passport-id", passportId]
        );
        return passed(result)
          ? { ok: true, secret: String(result.stdout).replace(/\r?\n$/u, "") }
          : helperFailure(this.name, result, "Linux Secret Service item unavailable");
      },
      delete(passportId) {
        // `secret-tool clear` exits 0 whether or not it matched anything.
        const result = invoke(run, "secret-tool", ["clear", "service", SERVICE, "passport-id", passportId]);
        if (result.timedOut) return fixedFailure(helperTimeout(this.name));
        return confirmGone(this, passportId, "Linux Secret Service", passed(result));
      },
    };
  }

  if (platform === "win32") {
    const powershell = "powershell.exe";
    const args = (script) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
    return {
      name: "Windows DPAPI",
      write(passportId, secret) {
        const blob = windowsBlobPath(passportId, env);
        try {
          ensureDirectory(path.dirname(blob));
        } catch {
          return fixedFailure("Windows DPAPI storage unavailable");
        }
        const result = invoke(run, powershell, args(WINDOWS_WRITE), {
          input: secret,
          env: { PASSCONTROL_DPAPI_BLOB: blob },
        });
        return passed(result) ? { ok: true } : helperFailure(this.name, result, "Windows DPAPI write failed");
      },
      read(passportId) {
        const blob = windowsBlobPath(passportId, env);
        const result = invoke(run, powershell, args(WINDOWS_READ), {
          env: { PASSCONTROL_DPAPI_BLOB: blob },
        });
        return passed(result)
          ? { ok: true, secret: String(result.stdout) }
          : helperFailure(this.name, result, "Windows DPAPI item unavailable");
      },
      delete(passportId) {
        try {
          // force:true, so a missing blob is a no-op rather than a throw.
          removeFile(windowsBlobPath(passportId, env));
        } catch {
          return fixedFailure("Windows DPAPI item could not be removed");
        }
        return confirmGone(this, passportId, "Windows DPAPI", true);
      },
    };
  }

  return {
    name: "OS credential store",
    write: () => fixedFailure("OS credential store unsupported"),
    read: () => fixedFailure("OS credential store unsupported"),
    delete: () => fixedFailure("OS credential store unsupported"),
  };
}

/**
 * What this machine may honestly declare to the gateway about its own key
 * storage, derived from the SAME resolution that produced the key — so the CLI
 * cannot declare a tier it did not actually read from.
 *
 * The gateway can never check any of this (research/passport-key-protection.md
 * §4), so the wire shape stays minimal and the dashboard labels it as declared.
 * `fallback` is the state worth carrying: the operator configured tier 1, the
 * store could not be read, and the file key answered instead. Reported as the
 * tier 0 it really is, with the disappointment attached.
 *
 * No key resolved means no claim. Silence is a state the panel renders on its
 * own terms; it must never be sent as "file".
 */
export function keyStorageDeclaration(storage) {
  if (!storage || storage.available === false) return null;
  if (storage.tier === 1) return { store: "os" };
  if (storage.tier === 0) return storage.fallback ? { store: "file", fallback: true } : { store: "file" };
  return null;
}

export function resolvePassportKey({
  passportId,
  fileSecret = "",
  fileLabel = "configuration file",
  preferFileSecret = false,
  storageMarker = "",
  store = createPassportCredentialStore(),
}) {
  if (preferFileSecret && fileSecret) {
    return {
      secret: fileSecret,
      storage: {
        tier: 0,
        source: fileLabel,
        available: true,
        fallback: false,
        message: `tier 0 — ${fileLabel}`,
      },
    };
  }

  if (storageMarker === PASSPORT_KEY_STORAGE_OS && passportId) {
    const stored = store.read(passportId);
    if (stored.ok && stored.secret) {
      return {
        secret: stored.secret,
        storage: {
          tier: 1,
          source: store.name,
          available: true,
          fallback: false,
          message: `tier 1 — ${store.name}`,
        },
      };
    }
    if (fileSecret) {
      return {
        secret: fileSecret,
        storage: {
          tier: 0,
          source: fileLabel,
          available: true,
          fallback: true,
          message: `tier 0 — file fallback (${fileLabel}); ${store.name} was unavailable`,
        },
      };
    }
    return {
      secret: "",
      storage: {
        tier: 1,
        source: store.name,
        available: false,
        fallback: false,
        message: `tier 1 configured, but ${store.name} is unavailable and no tier 0 file key exists`,
      },
    };
  }

  return {
    secret: fileSecret,
    storage: {
      tier: 0,
      source: fileSecret ? fileLabel : "none",
      available: Boolean(fileSecret),
      fallback: false,
      message: fileSecret ? `tier 0 — file (${fileLabel})` : "tier 0 — no passport key configured",
    },
  };
}

function sameSecret(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function migratePassportKey({ passportId, secret, store, removeFileSecret }) {
  if (!passportId || !secret) {
    return { ok: false, tier: 0, message: "A tier 0 passport file is required for migration." };
  }

  const written = store.write(passportId, secret);
  if (!written.ok) {
    return {
      ok: false,
      tier: 0,
      // The store's reason is its own fixed text, never the helper's output, and
      // it is the only thing that tells the operator whether to unlock a
      // Keychain, install a helper, or read a stack trace.
      message: `Credential-store write failed${written.reason ? ` (${written.reason})` : ""}; the tier 0 file was left untouched.`,
    };
  }

  const readback = store.read(passportId);
  if (!readback.ok || !sameSecret(secret, readback.secret)) {
    return {
      ok: false,
      tier: 0,
      message: "Credential-store readback failed or did not match; the tier 0 file was left untouched.",
    };
  }

  try {
    removeFileSecret();
  } catch {
    return {
      ok: false,
      tier: 0,
      message: "Credential-store verification succeeded, but the tier 0 file could not be updated and remains authoritative.",
    };
  }

  return {
    ok: true,
    tier: 1,
    message: `Migrated to tier 1 — ${store.name}; verified readback before removing the file key.`,
  };
}

/**
 * Move a verified passport secret into the OS store and commit the config that
 * points at it, with one invariant holding the rollbacks together:
 *
 *   **this function may only delete an item that it created.**
 *
 * Both failure paths below used to end in `store.delete(passportId)`, on the
 * reasoning that the item under that id was the one just written. That is true
 * exactly until `--replace` is used to re-import the SAME passport id, which it
 * permits. OS storage is keyed by the id — macOS `add-generic-password -U`
 * updates in place, and the DPAPI blob path is derived from the id — so in that
 * one case the item removed is the operator's existing key, and the config left
 * behind still points at a store that no longer has it.
 *
 * The pre-existence probe is UNCONDITIONAL, and not gated on the config saying
 * `PASSPORT_KEY_STORAGE=os` for this id. The config is not authoritative about
 * what the store contains: `cli/logout.mjs` blanks that marker in the same write
 * that asks the store to delete, and the store is allowed to report that it
 * could not confirm the removal — so an item can outlive the marker. The store
 * is the only authority on its own contents. The cost is one extra read per
 * import, which on a locked Keychain may mean one extra unlock prompt.
 *
 * The honest limit, and it is the same one `confirmGone` states above: a failed
 * `read()` does not prove absence. A locked store reads as empty, so a rollback
 * can still remove a real item. This narrows the window to that case; it does
 * not close it, because the store cannot give positive evidence of absence.
 *
 * `commitConfig` is injected rather than called directly for the same reason
 * `migratePassportKey` takes `removeFileSecret`: the rollback is the behaviour
 * worth testing, and it is only reachable if the commit can be made to fail.
 */
export function importPassportKey({
  passportId,
  secret,
  store,
  oldId = "",
  oldStorage = "",
  commitConfig,
}) {
  if (!passportId || !secret) {
    return { ok: false, message: "A Passport ID and secret are required." };
  }

  const existing = store.read(passportId);
  const preExisting = existing.ok && typeof existing.secret === "string" && existing.secret.length > 0;
  // The caller proves `secret` derives `passportId` before reaching here, so a
  // same-id import is provably the same key the store already holds. Writing it
  // changes nothing and only opens a window in which a rollback could take it.
  const alreadyStored = preExisting && sameSecret(secret, existing.secret);

  if (!alreadyStored) {
    const written = store.write(passportId, secret);
    if (!written.ok) {
      // Nothing was created, so there is nothing to roll back.
      return { ok: false, message: `${written.reason}. Nothing was written to the PassControl config.` };
    }

    const readback = store.read(passportId);
    if (!readback.ok || !sameSecret(secret, readback.secret)) {
      if (!preExisting) store.delete(passportId);
      return {
        ok: false,
        message: preExisting
          ? `${store.name} did not return the key that was just stored. The item already under this Passport ID was left in place, and config was not changed.`
          : `${store.name} did not return the key that was just stored. The new item was removed and config was not changed.`,
      };
    }
  }

  try {
    commitConfig();
  } catch (error) {
    if (!preExisting) store.delete(passportId);
    // The CLI's top-level handler prints `error.message` and nothing else, so
    // the filesystem detail has to travel inside the message or the operator
    // loses the only line that says which path failed. An fs error names a
    // path, not a key — the collapse-to-fixed-text rule above is about
    // subprocess stderr, which can echo the secret back.
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      cause: error,
      message: preExisting
        ? `The PassControl config could not be written; the key already in ${store.name} was left in place. ${detail}`
        : `The PassControl config could not be written; the new item was removed from ${store.name}. ${detail}`,
    };
  }

  let warning = null;
  if (oldStorage === PASSPORT_KEY_STORAGE_OS && oldId && oldId !== passportId) {
    const removed = store.delete(oldId);
    if (!removed.ok) {
      warning = `The previous Passport key could not be confirmed removed from ${store.name}; the new import is active, but the old OS item needs manual cleanup.`;
    }
  }

  return {
    ok: true,
    alreadyStored,
    warning,
    message: alreadyStored
      ? `${store.name} already held this Passport key; it was verified and left in place.`
      : `Passport ${passportId} imported into ${store.name}.`,
  };
}
