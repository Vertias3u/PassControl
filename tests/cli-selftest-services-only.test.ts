import { describe, expect, it, vi } from "vitest";

// Found in the 2026-10-02 Cloud E2E: `doctor --deep` with a passport made for
// GitHub only told its owner to "Add a provider key in the Control Tower". The
// demo model call was refused because the passport has no model scope, which is
// that agent working as designed, not a missing key.
const lines: string[] = [];
vi.mock("../cli/config.mjs", () => ({
  ok: (text: string) => lines.push(`ok ${text}`),
  step: (text: string) => lines.push(`step ${text}`),
  warn: (text: string) => lines.push(`warn ${text}`),
}));
vi.mock("../cli/visa-client.mjs", () => ({
  createVisaClient: () => ({ getVisa: async () => "visa.jwt.value" }),
}));

const { proveItWorks } = (await import(/* @vite-ignore */ new URL("../cli/selftest.mjs", import.meta.url).href)) as {
  proveItWorks: (input: Record<string, unknown>) => Promise<{ visa: boolean; call: boolean; reason?: string }>;
};

const run = (response: Response) =>
  proveItWorks({
    origin: "https://gateway.test",
    passportId: "id",
    passportSecret: "secret",
    fetchImpl: async () => response,
    wait: async () => {},
  });

describe("the self-test on a passport with no model access", () => {
  it("says the refusal is expected, and does not send its owner for a provider key", async () => {
    lines.length = 0;
    const proof = await run(Response.json({ error: "blocked_scope" }, { status: 403 }));
    const text = lines.join("\n");
    expect(proof).toMatchObject({ visa: true, call: false, reason: "no_model_scope" });
    expect(text).toMatch(/no model access/);
    expect(text).not.toMatch(/Add a provider key/);
  });

  it("does not claim the passport was just created on this machine", async () => {
    lines.length = 0;
    await run(Response.json({ error: "blocked_scope" }, { status: 403 }));
    expect(lines.join("\n")).toMatch(/ok minted a visa with this passport/);
    expect(lines.join("\n")).not.toMatch(/just created/);
  });

  it("keeps the provider-key advice for any other refusal", async () => {
    lines.length = 0;
    await run(Response.json({ error: "budget_exceeded" }, { status: 402 }));
    expect(lines.join("\n")).toMatch(/Add a provider key/);
  });
});
