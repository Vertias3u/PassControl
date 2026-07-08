import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mintVisa, verifyVisa } from "../lib/auth/visa";

const STRONG_SECRET = "test-secret-test-secret-test-secret-32";

describe("work visa", () => {
  const base = {
    passportId: "pid",
    agentId: "aid",
    userId: "uid",
    jti: "j1",
    scope: [] as { provider: string; models: string[] }[],
    budgetTokens: null,
    budgetCents: null,
    spentTokens: 0,
    spentMicrocents: 0,
  };

  beforeAll(() => {
    process.env.VISA_SECRET = STRONG_SECRET;
    process.env.VISA_TTL_SECONDS = "300";
  });

  beforeEach(() => {
    process.env.VISA_SECRET = STRONG_SECRET;
    delete process.env.VISA_SECRET_PREV;
    process.env.VISA_TTL_SECONDS = "300";
  });

  it("mints and verifies a visa with correct claims", async () => {
    const scope = [{ provider: "anthropic", models: ["claude-*"] }];
    const { token, expSeconds } = await mintVisa({
      ...base,
      scope,
      budgetTokens: 1000,
      budgetCents: 5,
      spentTokens: 42,
      spentMicrocents: 12_345,
    });
    expect(expSeconds).toBe(300);
    const claims = await verifyVisa(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("pid");
    expect(claims!.agid).toBe("aid");
    expect(claims!.uid).toBe("uid");
    expect(claims!.jti).toBe("j1");
    expect(claims!.scope).toEqual(scope);
    expect(claims!.bt).toBe(1000);
    expect(claims!.bc).toBe(5);
    expect(claims!.st).toBe(42);
    expect(claims!.sc).toBe(12_345);
  });

  it("rejects a visa missing the owner claim", async () => {
    const claims = await verifyVisa("not.a.jwt");
    expect(claims).toBeNull();
  });

  it("rejects a tampered visa", async () => {
    const { token } = await mintVisa(base);
    const tampered = token.slice(0, -3) + "AAA";
    expect(await verifyVisa(tampered)).toBeNull();
  });

  it("clamps TTL to the 300–900s range", async () => {
    process.env.VISA_TTL_SECONDS = "60";
    const { expSeconds } = await mintVisa(base);
    expect(expSeconds).toBe(300);
    process.env.VISA_TTL_SECONDS = "300";
  });

  it("rejects a primary VISA_SECRET shorter than 32 bytes", async () => {
    process.env.VISA_SECRET = "secret";
    await expect(mintVisa(base)).rejects.toThrow("VISA_SECRET must be at least 32 bytes");
  });

  it("rejects a previous rotation secret shorter than 32 bytes", async () => {
    process.env.VISA_SECRET_PREV = "short-prev";
    await expect(verifyVisa("not.a.jwt")).rejects.toThrow("VISA_SECRET_PREV must be at least 32 bytes");
  });

  it("accepts current and previous secrets when both are at least 32 bytes", async () => {
    process.env.VISA_SECRET = STRONG_SECRET;
    process.env.VISA_SECRET_PREV = "previous-secret-previous-secret-32";

    const { token } = await mintVisa(base);
    await expect(verifyVisa(token)).resolves.toMatchObject({
      sub: "pid",
      agid: "aid",
      uid: "uid",
    });
  });
});
