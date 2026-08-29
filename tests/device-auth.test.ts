// The device-authorization state machine behind `passcontrol login`.
//
// tests/cli-login-shape.test.ts pins the SHAPE of this feature — that no code
// travels in a URL, that the CLI cannot reach the self-host clone. This file
// pins the BEHAVIOUR, and the two assertions that matter most are the ones the
// shape guards structurally cannot make: that a grant redeems exactly once, and
// that the user codes are actually uniform.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, fakeRedis, calls } = vi.hoisted(() => {
  const values = new Map<string, string>();
  const log: string[] = [];
  const client = {
    async set(key: string, value: unknown) {
      log.push(`set ${key}`);
      values.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return "OK";
    },
    // Deliberately async, so two concurrent readers genuinely interleave at the
    // await — which is what makes the exactly-once test below able to FAIL.
    async get(key: string) {
      log.push(`get ${key}`);
      const raw = values.get(key);
      if (raw === undefined) return null;
      // Mirror the client's automatic JSON deserialization, which is the exact
      // behaviour lib/state/redis.ts documents an outage over.
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    async del(key: string) {
      log.push(`del ${key}`);
      return values.delete(key) ? 1 : 0;
    },
    async ttl(key: string) {
      return values.has(key) ? 600 : -2;
    },
    // The whole point: read and delete resolved inside ONE async call, with no
    // await between them, so the event loop cannot interleave a second reader.
    async getdel(key: string) {
      log.push(`getdel ${key}`);
      const raw = values.get(key);
      values.delete(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
  return { store: values, fakeRedis: client, calls: log };
});

vi.mock("@upstash/redis", () => ({ Redis: { fromEnv: () => fakeRedis } }));

import {
  MAX_CODE_ATTEMPTS,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  readDeviceStatus,
  resolveUserCode,
  startDeviceAuthorization,
  takeDeviceGrant,
} from "../lib/state/device-auth";
import {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  generateUserCode,
  hashDeviceCode,
  isDeviceCodeFormat,
  normalizeUserCode,
} from "../lib/device-codes";

beforeEach(() => {
  store.clear();
  calls.length = 0;
});

const open = (userCode = "FKDR8T2W", deviceCodeHash = "hash-a") =>
  startDeviceAuthorization({ userCode, deviceCodeHash, clientName: "laptop", ip: "203.0.113.7" });

describe("user codes", () => {
  it("excludes every homoglyph pair", () => {
    // 0/O and 1/I/L are the pairs that turn a valid login into "code not found",
    // and the operator's conclusion is "this product is broken", not "I misread".
    for (const banned of ["0", "O", "1", "I", "L", "U"]) {
      expect(USER_CODE_ALPHABET, `${banned} must not be in the alphabet`).not.toContain(banned);
    }
    expect(USER_CODE_ALPHABET.length).toBe(30);
    expect(new Set(USER_CODE_ALPHABET).size, "no duplicates").toBe(USER_CODE_ALPHABET.length);
  });

  it("draws uniformly — a modulo shortcut would skew the first 16 characters", () => {
    // 256 % 30 = 16, so `randomByte % 30` maps bytes 0–15 to their character ~9
    // times per 256 draws and the rest ~8. That is a real entropy loss and it is
    // invisible to any test that only checks length and character set — which is
    // why this counts instead.
    // Sizing this is the whole difficulty, and getting it wrong makes the test
    // either blind or flaky — the first draft was flaky, at 60k draws.
    //
    // The signal: 256 = 8×30 + 16, so a naive `% 30` gives values 0–15 nine
    // chances out of 256 and values 16–29 only eight. Every character is off by
    // 5.5–6.25%, in one direction or the other.
    //
    // The noise: with 600k draws each character expects 20,000, and one standard
    // deviation is sqrt(600000 × 1/30 × 29/30) ≈ 139 — about 0.7%. The worst of
    // 30 characters lands near 3σ, so ~2.1%.
    //
    // 3.5% therefore sits well clear of both: above the noise a correct
    // implementation produces, below the smallest deviation a biased one can.
    const counts = new Map<string, number>();
    const draws = 600_000;
    for (let i = 0; i < draws / USER_CODE_LENGTH; i++) {
      for (const ch of generateUserCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const expected = draws / USER_CODE_ALPHABET.length;
    for (const ch of USER_CODE_ALPHABET) {
      const seen = counts.get(ch) ?? 0;
      expect(Math.abs(seen - expected) / expected, `${ch} appeared ${seen} times`).toBeLessThan(0.035);
    }
  });

  it("accepts what a person actually types, and no more", () => {
    expect(normalizeUserCode("fkdr-8t2w")).toBe("FKDR8T2W");
    expect(normalizeUserCode("  FKDR 8T2W ")).toBe("FKDR8T2W");
    expect(normalizeUserCode("FKDR8T2")).toBeNull();
    // A `0` is a WRONG code, not a mistyped `O`. Repairing homoglyphs would make
    // several inputs valid per real code and widen the guess space for free.
    expect(normalizeUserCode("0KDR8T2W")).toBeNull();
  });

  it("pre-filters device codes before they reach the hash", () => {
    expect(isDeviceCodeFormat("x".repeat(43))).toBe(true);
    expect(isDeviceCodeFormat("x".repeat(5_000))).toBe(false);
    expect(isDeviceCodeFormat("has spaces in it and is long enough to pass len")).toBe(false);
  });

  it("keys Redis by the hash, never the device code itself", async () => {
    const hash = await hashDeviceCode("some-device-code");
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toContain("some-device-code");
  });
});

describe("redemption happens exactly once", () => {
  it("hands the grant to ONE of two concurrent redeemers", async () => {
    await open();
    await approveDeviceAuthorization({
      userCode: "FKDR8T2W",
      deviceCodeHash: "hash-a",
      sealedGrant: "sealed-token",
    });

    // Both start before either finishes. With a GET-then-DEL implementation both
    // read before either deletes and BOTH succeed — which is how a captured
    // device_code turns into a second working control-plane key. This is the
    // assertion that justifies `getdel`.
    const [first, second] = await Promise.all([
      takeDeviceGrant("hash-a"),
      takeDeviceGrant("hash-a"),
    ]);
    const winners = [first, second].filter((v) => v !== null);
    expect(winners, "exactly one redeemer may receive the grant").toEqual(["sealed-token"]);
  });

  it("is empty on every attempt after the first", async () => {
    await open();
    await approveDeviceAuthorization({
      userCode: "FKDR8T2W",
      deviceCodeHash: "hash-a",
      sealedGrant: "sealed-token",
    });
    expect(await takeDeviceGrant("hash-a")).toBe("sealed-token");
    expect(await takeDeviceGrant("hash-a")).toBeNull();
    expect(await takeDeviceGrant("hash-a")).toBeNull();
  });

  it("uses getdel, not a get/del pair", async () => {
    // Belt and braces with the concurrency test above. If a future fake happened
    // to be synchronous enough to hide the race, this still names the mechanism.
    await open();
    await approveDeviceAuthorization({
      userCode: "FKDR8T2W",
      deviceCodeHash: "hash-a",
      sealedGrant: "sealed",
    });
    calls.length = 0;
    await takeDeviceGrant("hash-a");
    expect(calls).toContain("getdel devauth:grant:hash-a");
    expect(calls, "a get/del pair is the race this avoids").not.toContain("get devauth:grant:hash-a");
  });
});

describe("one flow cannot redeem another's grant", () => {
  it("keys the grant to the device code, not the user code", async () => {
    await open("AAAA1111".replace(/1/gu, "2"), "hash-a");
    await open("BBBB3333", "hash-b");
    await approveDeviceAuthorization({
      userCode: "BBBB3333",
      deviceCodeHash: "hash-b",
      sealedGrant: "b-token",
    });
    expect(await takeDeviceGrant("hash-a"), "flow A must not collect flow B's key").toBeNull();
    expect(await takeDeviceGrant("hash-b")).toBe("b-token");
  });
});

describe("status transitions the CLI can act on", () => {
  it("reports pending, then approved", async () => {
    await open();
    expect(await readDeviceStatus("hash-a")).toBe("pending");
    await approveDeviceAuthorization({
      userCode: "FKDR8T2W",
      deviceCodeHash: "hash-a",
      sealedGrant: "sealed",
    });
    expect(await readDeviceStatus("hash-a")).toBe("approved");
  });

  it("reports denied, so the CLI stops instead of waiting out 600 seconds", async () => {
    await open();
    await denyDeviceAuthorization({ userCode: "FKDR8T2W", deviceCodeHash: "hash-a" });
    expect(await readDeviceStatus("hash-a")).toBe("denied");
    // And the browser handle is gone: a denied code cannot then be approved.
    expect(await resolveUserCode("FKDR8T2W")).toBeNull();
  });

  it("returns null for a code that never existed", async () => {
    expect(await readDeviceStatus("never-seen")).toBeNull();
  });

  it("publishes the grant BEFORE flipping the status", async () => {
    // Order matters on failure. Grant-then-status means a crash in between leaves
    // the CLI polling `pending` and the grant expiring unread. Status-then-grant
    // would tell the CLI "approved" with nothing to collect.
    await open();
    calls.length = 0;
    await approveDeviceAuthorization({
      userCode: "FKDR8T2W",
      deviceCodeHash: "hash-a",
      sealedGrant: "sealed",
    });
    const grantWrite = calls.indexOf("set devauth:grant:hash-a");
    const statusWrite = calls.indexOf("set devauth:device:hash-a");
    expect(grantWrite).toBeGreaterThan(-1);
    expect(statusWrite).toBeGreaterThan(-1);
    expect(grantWrite).toBeLessThan(statusWrite);
  });
});

describe("the attempt cap destroys rather than freezes", () => {
  it("kills the login after too many resolutions of a real code", async () => {
    await open();
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      expect(await resolveUserCode("FKDR8T2W"), `attempt ${i + 1} should still resolve`).not.toBeNull();
    }
    // The one past the cap destroys it — a login nobody can complete is a login
    // an attacker cannot complete either, and the operator just re-runs.
    expect(await resolveUserCode("FKDR8T2W")).toBeNull();
    expect(await resolveUserCode("FKDR8T2W"), "and it stays dead").toBeNull();
    expect(await readDeviceStatus("hash-a"), "both handles go, not just one").toBeNull();
  });

  it("charges an approval ONCE, not twice — the budget is 5 approvals, not 2.5", async () => {
    // The real sequence is a pair: inspectCliDevice resolves the code to render
    // the screen, then approveCliDevice resolves it again to act. Charging both
    // made every approval cost two attempts, so an operator who re-read their
    // terminal a couple of times had the login destroyed at the moment they
    // pressed Approve — reported to them as "that code is not valid".
    //
    // Measured before it was fixed: one Continue-then-Approve left attempts = 2.
    await open();
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const inspected = await resolveUserCode("FKDR8T2W");
      expect(inspected?.attempts, `inspect ${i + 1} charges once`).toBe(i + 1);
      const approved = await resolveUserCode("FKDR8T2W", { count: false });
      expect(approved?.attempts, "approve charges nothing").toBe(i + 1);
    }
    // Five full inspect+approve pairs still fit inside the cap.
    expect(await resolveUserCode("FKDR8T2W", { count: false })).not.toBeNull();
  });

  it("does not let a caller refresh the TTL by hammering the code", async () => {
    // If each lookup restarted the 600s window, a caller could hold a login open
    // indefinitely. The TTL is read and re-applied, never reset.
    await open();
    await resolveUserCode("FKDR8T2W");
    expect(await fakeRedis.ttl("devauth:code:FKDR8T2W")).toBe(600);
  });
});

describe("a Redis fault fails CLOSED", () => {
  it("throws rather than approving, and throws rather than redeeming", async () => {
    const boom = new Error("redis unavailable");
    const spies = [
      vi.spyOn(fakeRedis, "set").mockRejectedValue(boom),
      vi.spyOn(fakeRedis, "getdel").mockRejectedValue(boom),
      vi.spyOn(fakeRedis, "get").mockRejectedValue(boom),
    ];
    // The opposite posture from the kill-switch reads, on purpose: an unreadable
    // credential store means nothing was authenticated, and the right answer to
    // "we cannot tell" is to mint nothing.
    await expect(
      approveDeviceAuthorization({ userCode: "X", deviceCodeHash: "h", sealedGrant: "s" })
    ).rejects.toThrow();
    await expect(takeDeviceGrant("h")).rejects.toThrow();
    await expect(readDeviceStatus("h")).rejects.toThrow();
    for (const spy of spies) spy.mockRestore();
  });
});
