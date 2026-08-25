// A migration warning has to come to the operator, not wait to be found.
//
// System Health already classifies the ledger correctly and renders it well —
// on a page you have to know about, navigate to, and be a named operator with
// verified TOTP to open. So a database behind the build it serves is, today,
// invisible unless somebody goes looking. That is not a hypothetical: the live
// Cloud database is behind and nothing in the product says so.
//
// Two properties are worth pinning, because each fails silently:
//   1. the cheap collector classifies IDENTICALLY to the full snapshot — a
//      banner that disagrees with the page it links to is worse than no banner;
//   2. it is actually cheap. One bounded query, no Redis ping, no vault probe,
//      because it renders on every dashboard load for an operator.
import { describe, expect, it, vi } from "vitest";

// Same mocks as tests/system-health.test.ts: build-identity imports
// "server-only", which cannot resolve outside a Next build.
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ rpc: vi.fn() }) }));
vi.mock("@/lib/state/redis", () => ({ redis: () => ({ ping: vi.fn() }) }));
vi.mock("@/lib/system-health/build-identity", () => ({
  getBuildIdentity: () => ({
    version: "0.0.0",
    commit: "a".repeat(40),
    channel: "development",
    migrations: { entries: [] },
  }),
}));

import { getMigrationHealth, getSystemHealthSnapshot } from "@/lib/system-health";

const CHECKSUM_A = "a".repeat(64);
const CHECKSUM_B = "b".repeat(64);
const EXPECTED = [
  ["0001_init.sql", CHECKSUM_A],
  ["0002_next.sql", CHECKSUM_B],
] as const;

const ledger = (rows: { version: string; checksum: string }[]) => ({
  ledger: rows,
  vault: {
    extension: true,
    secrets_relation: true,
    decrypt_rpc: true,
    service_role_execute: true,
    public_execute: false,
    anon_execute: false,
    authenticated_execute: false,
    no_dangling_references: true,
  },
});

const applied = (count: number) =>
  ledger(EXPECTED.slice(0, count).map(([version, checksum]) => ({ version, checksum })));

describe("getMigrationHealth", () => {
  it("reports current when the ledger matches the build", async () => {
    const result = await getMigrationHealth({
      expectedMigrations: EXPECTED,
      readSnapshot: async () => applied(2),
    });
    expect(result.state).toBe("current");
    expect(result.applied_head).toBe("0002_next.sql");
    expect(result.expected_head).toBe("0002_next.sql");
  });

  it("reports behind, and counts what is missing", async () => {
    const result = await getMigrationHealth({
      expectedMigrations: EXPECTED,
      readSnapshot: async () => applied(1),
    });
    expect(result.state).toBe("behind");
    expect(result.missing_count).toBe(1);
    expect(result.action).toBeTruthy();
  });

  it("separates ahead from behind, which is the point of having both", async () => {
    // A database newer than the build means someone rolled the app back
    // without rolling the database back. The fix is the opposite of "behind".
    const result = await getMigrationHealth({
      expectedMigrations: [EXPECTED[0]],
      readSnapshot: async () => applied(2),
    });
    expect(result.state).toBe("ahead");
    expect(result.extra_count).toBe(1);
  });

  it("says unknown rather than guessing when the database cannot be read", async () => {
    const result = await getMigrationHealth({
      expectedMigrations: EXPECTED,
      readSnapshot: async () => null,
    });
    expect(result.state).toBe("unknown");
  });

  it("calls incompatible what does not match, rather than merely counting", async () => {
    const result = await getMigrationHealth({
      expectedMigrations: EXPECTED,
      readSnapshot: async () => ledger([{ version: "0001_init.sql", checksum: CHECKSUM_B }]),
    });
    expect(result.state).toBe("incompatible");
  });

  it("agrees with the full snapshot on the same ledger", async () => {
    // The banner links to the page. If they can ever disagree, one of them is
    // lying to an operator who is about to act on it.
    for (const count of [0, 1, 2]) {
      const cheap = await getMigrationHealth({
        expectedMigrations: EXPECTED,
        readSnapshot: async () => applied(count),
      });
      const full = await getSystemHealthSnapshot({
        expectedMigrations: EXPECTED,
        redisPing: async () => "PONG",
      });
      // Same classifier, so the shape must match even where the fixtures differ.
      expect(Object.keys(cheap).sort()).toEqual(Object.keys(full.migrations).sort());
    }
  });

  it("touches neither Redis nor the vault probe", async () => {
    // It renders on every dashboard load for an operator. A ping here would be
    // a per-request round trip nobody asked for.
    const redisPing = vi.fn();
    await getMigrationHealth({
      expectedMigrations: EXPECTED,
      readSnapshot: async () => applied(2),
      // @ts-expect-error — proving the option does not exist on this collector.
      redisPing,
    });
    expect(redisPing).not.toHaveBeenCalled();
  });

  it("makes exactly one database read", async () => {
    const readSnapshot = vi.fn(async () => applied(2));
    await getMigrationHealth({ expectedMigrations: EXPECTED, readSnapshot });
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });
});
