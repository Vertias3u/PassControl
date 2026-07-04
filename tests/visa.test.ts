import { describe, it, expect, beforeAll } from "vitest";
import { mintVisa, verifyVisa } from "../lib/auth/visa";

beforeAll(() => {
  process.env.VISA_SECRET = "test-secret-test-secret-test-secret-32";
  process.env.VISA_TTL_SECONDS = "300";
});

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
  };

  it("mints and verifies a visa with correct claims", async () => {
    const scope = [{ provider: "anthropic", models: ["claude-*"] }];
    const { token, expSeconds } = await mintVisa({
      ...base,
      scope,
      budgetTokens: 1000,
      spentTokens: 42,
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
    expect(claims!.st).toBe(42);
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
});
