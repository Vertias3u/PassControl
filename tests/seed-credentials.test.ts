import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line
// @ts-expect-error - plain ESM setup script, intentionally untyped
import { MIN_PASSWORD_LENGTH, generatePassword, resolveNewPassword } from "../scripts/seed.mjs";

// The local Docker stack used to seed a fixed `passcontrol-dev` password on every
// install on earth, printed to the console on boot. That was tolerable while the
// stack was localhost-only, but it is reachable over a tailnet / LAN the moment
// anyone connects a phone to it — at which point a globally-known password guards
// real provider keys in the Vault. There must be no path that produces it.
const RETIRED_PASSWORD = "passcontrol-dev";

describe("seed credentials", () => {
  it("generates a password with real entropy", () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  it("uses DEV_USER_PASSWORD when the operator supplied one", async () => {
    const result = await resolveNewPassword(
      { DEV_USER_PASSWORD: "a-deliberate-operator-password" },
      { interactive: false }
    );
    expect(result.password).toBe("a-deliberate-operator-password");
    expect(result.source).toBe("env");
  });

  it("refuses a supplied password that is too short to guard a vault", async () => {
    await expect(
      resolveNewPassword({ DEV_USER_PASSWORD: "short" }, { interactive: false })
    ).rejects.toThrow(/at least/i);
  });

  // Non-interactive (CI, `| tee`, a wrapper script): we cannot prompt, so generate
  // rather than silently falling back to a known value.
  it("generates a unique password when it cannot prompt", async () => {
    const a = await resolveNewPassword({}, { interactive: false });
    const b = await resolveNewPassword({}, { interactive: false });
    expect(a.source).toBe("generated");
    expect(a.password).not.toBe(b.password);
    expect(a.password).not.toBe(RETIRED_PASSWORD);
  });

  it("asks the operator to choose one when a terminal is attached", async () => {
    const asked: string[] = [];
    const result = await resolveNewPassword(
      {},
      {
        interactive: true,
        ask: async (prompt: string) => {
          asked.push(prompt);
          return "chosen-by-the-operator";
        },
      }
    );
    expect(result.password).toBe("chosen-by-the-operator");
    expect(result.source).toBe("prompt");
    expect(asked.length).toBeGreaterThan(0);
  });

  it("re-prompts instead of accepting a too-short typed password", async () => {
    const answers = ["tiny", "a-long-enough-password"];
    const result = await resolveNewPassword(
      {},
      { interactive: true, ask: async () => answers.shift()! }
    );
    expect(result.password).toBe("a-long-enough-password");
  });

  // The regression guard: no reachable code path may reintroduce the shared default.
  it("never returns the retired shared password", async () => {
    const results = await Promise.all([
      resolveNewPassword({}, { interactive: false }),
      resolveNewPassword({}, { interactive: true, ask: async () => "another-good-password" }),
    ]);
    for (const r of results) expect(r.password).not.toBe(RETIRED_PASSWORD);
  });

  it("no longer hardcodes the retired password anywhere in the setup path", async () => {
    for (const file of ["scripts/seed.mjs", "scripts/dev-stack.sh", "bin/passcontrol.mjs"]) {
      const src = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(src, `${file} still contains the retired password`).not.toContain(RETIRED_PASSWORD);
    }
  });
});
