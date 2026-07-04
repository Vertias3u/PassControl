import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  consumeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "../lib/recoveryCodes";

const CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{5}-[23456789abcdefghjkmnpqrstuvwxyz]{5}$/;

describe("recovery code generation", () => {
  it("mints N readable, unique codes with matching hashes", async () => {
    const codes = await generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    const seenCodes = new Set<string>();
    const seenHashes = new Set<string>();
    for (const { code, hash } of codes) {
      expect(code).toMatch(CODE_RE); // human-readable, unambiguous charset
      expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha-256
      expect(hash).toBe(await hashRecoveryCode(code));
      seenCodes.add(code);
      seenHashes.add(hash);
    }
    expect(seenCodes.size).toBe(RECOVERY_CODE_COUNT); // no repeats
    expect(seenHashes.size).toBe(RECOVERY_CODE_COUNT);
  });
});

describe("normalizeRecoveryCode + hashRecoveryCode", () => {
  it("is case/format-insensitive (hyphens, spaces, case all collapse)", async () => {
    expect(normalizeRecoveryCode("ABCDE-FGHIJ")).toBe("abcdefghij");
    expect(normalizeRecoveryCode("  abc de-fg hij ")).toBe("abcdefghij");
    expect(await hashRecoveryCode("ABCDE-FGHIJ")).toBe(await hashRecoveryCode("abcdefghij"));
  });
  it("matches a reference SHA-256 of the normalized form", async () => {
    const ref = createHash("sha256").update("abcdefghij").digest("hex");
    expect(await hashRecoveryCode("ABCDE-FGHIJ")).toBe(ref);
  });
});

describe("consumeRecoveryCode", () => {
  function makeDb(result: { data: unknown; error: unknown }) {
    const calls = { update: null as any, eq: [] as [string, unknown][], is: [] as [string, unknown][] };
    const b: any = {
      update: (p: any) => { calls.update = p; return b; },
      eq: (c: string, v: unknown) => { calls.eq.push([c, v]); return b; },
      is: (c: string, v: unknown) => { calls.is.push([c, v]); return b; },
      select: () => b,
      maybeSingle: async () => result,
    };
    return { db: { from: () => b } as any, calls };
  }

  it("consumes a matching unused code (scoped to user + hash + unused)", async () => {
    const { db, calls } = makeDb({ data: { id: "rc1" }, error: null });
    const ok = await consumeRecoveryCode(db, "u1", "ABCDE-FGHIJ");
    expect(ok).toBe(true);
    expect(calls.update).toHaveProperty("used_at"); // marks it used
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["code_hash", await hashRecoveryCode("ABCDE-FGHIJ")]);
    expect(calls.is).toContainEqual(["used_at", null]); // single-use guard
  });

  it("returns false when no unused code matches", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await consumeRecoveryCode(db, "u1", "abcde-fghij")).toBe(false);
  });
});
