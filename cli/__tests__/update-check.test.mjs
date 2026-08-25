// The update notice must be impossible to trip over.
//
// It is the only outbound call this CLI makes that nobody asked for, in a tool
// whose whole pitch is that it is careful with credentials. So the tests that
// matter are not "does it notice a new version" — they are the ones that prove
// it stays silent and costs nothing everywhere it should.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  CACHE_TTL_MS,
  checkForUpdate,
  fetchLatest,
  isNewer,
  mayAnnounce,
  readCache,
  shouldCheck,
  shouldFetch,
  updateCachePath,
  updateNotice,
} from "../update-check.mjs";

const dirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "pc-update-"));
  dirs.push(dir);
  return join(dir, "update-check.json");
}
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("isNewer", () => {
  it("compares numerically, not as text", () => {
    // The bug this exists for: "0.10.0" sorts BELOW "0.9.0" as a string, and
    // that is exactly when an operator most needs to be told.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });

  it("is false for equal versions", () => {
    expect(isNewer("0.6.1", "0.6.1")).toBe(false);
  });

  it("ignores prereleases rather than nagging someone back to stable", () => {
    expect(isNewer("0.6.1", "0.7.0-rc.1")).toBe(false);
    expect(isNewer("0.7.0-rc.2", "0.7.0-rc.1")).toBe(false);
  });

  it("treats junk as 'nothing to say'", () => {
    for (const junk of [null, undefined, "", "latest", "1.2", "v1.2.3", {}]) {
      expect(isNewer(junk, "0.6.1")).toBe(false);
    }
  });
});

describe("shouldCheck", () => {
  const base = { isTty: true, json: false, env: {}, now: 1_000_000, cache: null };

  it("checks on an interactive terminal with no recent cache", () => {
    expect(shouldCheck(base)).toBe(true);
  });

  it("never checks when stdout is not a terminal", () => {
    // An agent run, a CI job, or a piped command. No human, no notice, no call.
    expect(shouldCheck({ ...base, isTty: false })).toBe(false);
  });

  it("never checks under --json, which would corrupt the document", () => {
    expect(shouldCheck({ ...base, json: true })).toBe(false);
  });

  it("honours both opt-out variables and CI", () => {
    expect(shouldCheck({ ...base, env: { PASSCONTROL_NO_UPDATE_CHECK: "1" } })).toBe(false);
    expect(shouldCheck({ ...base, env: { NO_UPDATE_NOTIFIER: "1" } })).toBe(false);
    expect(shouldCheck({ ...base, env: { CI: "true" } })).toBe(false);
  });

  it("stays inside the daily budget, then checks again", () => {
    const cache = { checkedAt: 1_000_000 };
    expect(shouldCheck({ ...base, cache, now: 1_000_000 + CACHE_TTL_MS - 1 })).toBe(false);
    expect(shouldCheck({ ...base, cache, now: 1_000_000 + CACHE_TTL_MS })).toBe(true);
  });
});

describe("checkForUpdate", () => {
  it("makes NO network call when the guards say no", async () => {
    const fetchLatestImpl = vi.fn();
    const notice = await checkForUpdate({
      current: "0.6.1",
      isTty: false,
      file: scratch(),
      fetchLatestImpl,
    });
    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(notice).toBeNull();
  });

  it("reports a newer published version", async () => {
    const notice = await checkForUpdate({
      current: "0.6.1",
      isTty: true,
      env: {},
      file: scratch(),
      fetchLatestImpl: async () => "0.7.0",
    });
    expect(notice).toContain("0.6.1 → 0.7.0");
    expect(notice).toContain("npm install -g passcontrol@latest");
  });

  it("says nothing when the CLI is current", async () => {
    const notice = await checkForUpdate({
      current: "0.7.0",
      isTty: true,
      env: {},
      file: scratch(),
      fetchLatestImpl: async () => "0.7.0",
    });
    expect(notice).toBeNull();
  });

  it("is silent when the registry is unreachable", async () => {
    const notice = await checkForUpdate({
      current: "0.6.1",
      isTty: true,
      env: {},
      file: scratch(),
      fetchLatestImpl: async () => null,
    });
    expect(notice).toBeNull();
  });

  it("still shows a known update while inside the cache window", async () => {
    // The TTL bounds the NETWORK CALL, not the notice. Otherwise an update
    // discovered a minute ago would go unmentioned for the rest of the day.
    const file = scratch();
    writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest: "0.9.0" }));
    const fetchLatestImpl = vi.fn();
    const notice = await checkForUpdate({
      current: "0.6.1",
      isTty: true,
      env: {},
      file,
      fetchLatestImpl,
    });
    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(notice).toContain("0.6.1 → 0.9.0");
  });

  it("survives a corrupt cache instead of crashing the command", async () => {
    const file = scratch();
    writeFileSync(file, "{ not json");
    expect(readCache(file)).toBeNull();
    const notice = await checkForUpdate({
      current: "0.6.1",
      isTty: true,
      env: {},
      file,
      fetchLatestImpl: async () => "0.7.0",
    });
    expect(notice).toContain("0.7.0");
  });

  it("writes the cache so the next run inside the day is free", async () => {
    const file = scratch();
    await checkForUpdate({
      current: "0.6.1",
      isTty: true,
      env: {},
      now: 42,
      file,
      fetchLatestImpl: async () => "0.7.0",
    });
    expect(readCache(file)).toMatchObject({ checkedAt: 42, latest: "0.7.0" });
  });
});

describe("the display gate is independent of the cache", () => {
  // THE REGRESSION. The first version of this module had one predicate for both
  // "may we print" and "may we call the registry". A fresh cache made it return
  // false for the same reason a pipe did, and the cached-notice fallback then
  // printed a notice into piped output and into a --json document. The unit
  // test for the non-TTY case passed throughout, because it used an EMPTY
  // cache — the one shape where the bug cannot show. Found by running the CLI
  // under a pty and then under a pipe, so every case below seeds a cache.
  const seeded = () => {
    const file = scratch();
    writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest: "9.9.9" }));
    return file;
  };

  it("prints nothing when piped, even with a known update cached", async () => {
    const fetchLatestImpl = vi.fn();
    const notice = await checkForUpdate({
      current: "0.6.1",
      isTty: false,
      env: {},
      file: seeded(),
      fetchLatestImpl,
    });
    expect(notice).toBeNull();
    expect(fetchLatestImpl).not.toHaveBeenCalled();
  });

  it("prints nothing under --json, even with a known update cached", async () => {
    const notice = await checkForUpdate({
      current: "0.6.1",
      isTty: true,
      json: true,
      env: {},
      file: seeded(),
      fetchLatestImpl: async () => "9.9.9",
    });
    expect(notice).toBeNull();
  });

  it("honours an opt-out, even with a known update cached", async () => {
    for (const env of [{ PASSCONTROL_NO_UPDATE_CHECK: "1" }, { NO_UPDATE_NOTIFIER: "1" }, { CI: "1" }]) {
      const notice = await checkForUpdate({
        current: "0.6.1",
        isTty: true,
        env,
        file: seeded(),
        fetchLatestImpl: async () => "9.9.9",
      });
      expect(notice).toBeNull();
    }
  });

  it("keeps the two questions separate", () => {
    // A fresh cache stops the FETCH and must not stop the display.
    expect(shouldFetch({ now: 0, cache: { checkedAt: 0 } })).toBe(false);
    expect(mayAnnounce({ isTty: true, env: {} })).toBe(true);
  });
});

describe("fetchLatest", () => {
  it("resolves null rather than throwing, on every failure shape", async () => {
    const shapes = [
      async () => {
        throw new Error("ENOTFOUND");
      },
      async () => ({ ok: false, status: 500, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => ({}) }),
      async () => ({
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
      }),
    ];
    for (const impl of shapes) {
      await expect(fetchLatest("https://example.invalid", 50, impl)).resolves.toBeNull();
    }
  });

  it("reads the version out of a good response", async () => {
    const impl = async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) });
    await expect(fetchLatest("https://example.invalid", 50, impl)).resolves.toBe("9.9.9");
  });
});

describe("the cache location", () => {
  it("sits beside the existing config, honouring XDG_CONFIG_HOME", () => {
    expect(updateCachePath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/passcontrol/update-check.json"
    );
  });
});

describe("updateNotice", () => {
  it("names the upgrade command, because that is the point of telling anyone", () => {
    expect(updateNotice("0.6.1", "0.7.0")).toContain("npm install -g passcontrol@latest");
  });

  it("is null when there is nothing to say", () => {
    expect(updateNotice("0.7.0", "0.6.1")).toBeNull();
  });
});
