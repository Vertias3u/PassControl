import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ rpc }) }));
vi.mock("@/lib/state/redis", () => ({ redis: () => ({ ping: vi.fn() }) }));
vi.mock("@/lib/system-health/build-identity", () => ({
  getBuildIdentity: () => ({ version: "0.0.0", commit: "a".repeat(40), channel: "development", migrations: { entries: [] } }),
}));

import { classifyMigrations, getSystemHealthSnapshot } from "@/lib/system-health";

const ledger = [
  { version: "0001_init.sql", checksum: "a".repeat(64) },
  { version: "0002_lock_privileged_columns.sql", checksum: "b".repeat(64) },
];
const vault = { extension: true, secrets_relation: true, decrypt_rpc: true, service_role_execute: true, public_execute: false, anon_execute: false, authenticated_execute: false, no_dangling_references: true };

beforeEach(() => {
  vi.unstubAllEnvs();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { ledger, vault }, error: null });
});

describe("system health snapshot", () => {
  it("states no check that cannot fail: with every dependency broken, nothing reports ready", async () => {
    // A row pinned to "ready" is indistinguishable from a row that measured
    // something and passed. With the whole instance broken, an honest panel has
    // no green ticks left on it.
    rpc.mockResolvedValue({ data: null, error: new Error("down") });
    const snapshot = await getSystemHealthSnapshot({
      redisPing: async () => { throw new Error("down"); },
      buildIdentity: { version: "0.0.0", commit: null, channel: "unknown" },
    });
    expect(snapshot.checks.length).toBeGreaterThan(0);
    expect(snapshot.checks.filter((entry) => entry.state === "ready")).toEqual([]);
  });

  it("carries no self-referential operator-authentication row", async () => {
    // The page is already gated; a row asserting its own gate measures nothing.
    const snapshot = await getSystemHealthSnapshot();
    expect(snapshot.checks.map((entry) => entry.id)).not.toContain("auth");
    expect(JSON.stringify(snapshot)).not.toContain("Operator authentication");
  });

  it("never serializes internal ledger checksums or runtime configuration", async () => {
    vi.stubEnv("VISA_SECRET", "x".repeat(32));
    vi.stubEnv("CACHE_ENC_KEY", Buffer.alloc(32).toString("base64"));
    const snapshot = await getSystemHealthSnapshot();
    const text = JSON.stringify(snapshot);

    expect(snapshot.format_version).toBe(1);
    expect(text).not.toContain(ledger[0]!.checksum);
    expect(text).not.toContain("VISA_SECRET");
    expect(text).not.toContain("CACHE_ENC_KEY");
    expect(text).not.toContain("no_dangling_references");
    expect(Object.keys(snapshot)).toEqual([
      "format_version", "generated_at", "overall", "build", "migrations", "protocols", "checks",
    ]);
  });

  it("marks a valid exact expected prefix with missing migrations as behind/incompatible", async () => {
    const snapshot = await getSystemHealthSnapshot({
      expectedMigrations: [
        ["0001_init.sql", ledger[0]!.checksum],
        ["0002_lock_privileged_columns.sql", ledger[1]!.checksum],
        ["0003_admin_audit.sql", "c".repeat(64)],
      ],
      redisPing: async () => "PONG",
    });
    expect(snapshot.migrations).toMatchObject({ state: "behind", missing_count: 1, extra_count: 0 });
    expect(snapshot.overall).toBe("incompatible");
  });

  it("fails closed on unavailable database evidence", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("database unavailable") });
    const snapshot = await getSystemHealthSnapshot({ redisPing: async () => "PONG" });
    expect(snapshot.migrations.state).toBe("unknown");
    expect(snapshot.overall).toBe("degraded");
    expect(snapshot.checks.find((check) => check.id === "database")?.state).toBe("degraded");
  });

  it("distinguishes exact-prefix extras from gaps, duplicates, mismatches, and unvetted rows", () => {
    const expected = [["0001_init.sql", "a".repeat(64)], ["0002_lock_privileged_columns.sql", "b".repeat(64)]] as const;
    expect(classifyMigrations([...expected.map(([version, checksum]) => ({ version, checksum })), { version: "9999_future.sql", checksum: "c".repeat(64) }], expected).state).toBe("ahead");
    expect(classifyMigrations([{ version: "0001_init.sql", checksum: "a".repeat(64) }, { version: "0003_gap.sql", checksum: "c".repeat(64) }], expected).state).toBe("incompatible");
    expect(classifyMigrations([{ version: "0001_init.sql", checksum: "a".repeat(64) }, { version: "0001_init.sql", checksum: "a".repeat(64) }], expected).state).toBe("incompatible");
    expect(classifyMigrations([{ version: "0001_init.sql", checksum: "0".repeat(64) }], expected).state).toBe("incompatible");
    expect(classifyMigrations([{ version: "0001_init.sql", checksum: "" }], expected).state).toBe("unknown");
  });
});
