import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Where the durable kill record (0083) is, and is not, wired in.
 *
 * The behaviour is tested in kill-record-rebuild.test.ts; this pins the call
 * sites, which no unit test of the library can see:
 *  - every proxy read of a session stop is corrected by the kill read's reload
 *    (`withRecordedSessionStop`), or the first call after a Redis loss is let
 *    through, which is the bug 0083 closes;
 *  - every operator-facing arm goes through the durable setters;
 *  - the demo's self-expiring kill and the account-erasure guard stay
 *    Redis-only, on purpose: an expiring demo row would outlive its TTL, and the
 *    erasure guard goes away with the account.
 */
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
// The demo route and the sessions panel are Cloud-only: public curation removes
// them (scripts/curate-public.sh), and their pins go with them.
const ships = (rel: string) => existsSync(new URL(`../${rel}`, import.meta.url));
const DEMO_SESSION = "app/api/demo/session/route.ts";
const SESSIONS_DATA = "app/dashboard/agents/[id]/sessions-data.ts";
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("the durable kill record's call sites", () => {
  it.each(["app/api/v1/[provider]/[...path]/route.ts", "app/api/v1/svc/[service]/[...path]/route.ts"])(
    "%s corrects every session-stop read with the kill read's reload",
    (file) => {
      const src = read(file);
      const sessionReads = count(src, "isSuspended(agentId, lineage?.session ?? null)");
      expect(sessionReads).toBeGreaterThan(0);
      expect(count(src, "withRecordedSessionStop(")).toBe(sessionReads);
    }
  );

  it("the dashboard, the control API and the session stop write the record", () => {
    expect(read("lib/fleet.ts")).toContain("await setTenantKillDurably(userId, on)");
    expect(read("lib/fleet.ts")).toContain("durable = await saveKillRecord(userId, stop)");
    expect(read("app/dashboard/service-actions.ts")).toContain("await setServiceKillDurably(userId, service, requested)");
    expect(read("app/dashboard/service-actions.ts")).not.toMatch(/\barmServiceKill\(/);
    expect(read("app/api/control/v1/kill-switch/route.ts")).toContain("await setTenantKill(db, userId, on)");
  });

  // F4 replaced the demo's shared tenant kill with a per-visitor session stop.
  // It expires on its own and must never leave a durable row per visitor.
  it.skipIf(!ships(DEMO_SESSION))("the demo's self-expiring session stop stays Redis-only", () => {
    const demo = read(DEMO_SESSION);
    expect(demo).toMatch(/\bstopSession\(/);
    expect(demo).toMatch(/ttlSeconds/);
    expect(demo).not.toMatch(/Durably|saveKillRecord|setSessionStopped|kill-record/);
  });

  it("the account-erasure guard stays Redis-only", () => {
    const erasure = read("app/dashboard/settings/account-actions.ts");
    expect(erasure).toMatch(/\barmTenantKill\(user\.id, true\)/);
    expect(erasure).not.toContain("Durably");
  });

  it.skipIf(!ships(SESSIONS_DATA))("the sessions panel loads the record before it reads its stops", () => {
    const src = read(SESSIONS_DATA);
    expect(src.indexOf("await ensureKillRecordLoaded(userId)")).toBeGreaterThan(-1);
    expect(src.indexOf("await ensureKillRecordLoaded(userId)")).toBeLessThan(src.indexOf("readSessionStops(agentId"));
  });
});
