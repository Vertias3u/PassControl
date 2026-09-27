// Two first-run failures from the 1.0.0 self-host E2E (2026-09-27), both on a
// machine with no CLI config yet:
//
// 1. `setup` wrote no gateway. With no config the CLI's default gateway is
//    already http://localhost:3000, so setup decided it was not "switching" and
//    wrote nothing — but `login` deliberately ignores that default and falls back
//    to Cloud. The first `login` after `setup` went to the hosted service.
// 2. `login` wrote `PROVIDER=` and `MODEL=` (the config writer emits every key),
//    and the reader took the empty string over the default, so bare `call` and
//    `agent create` failed with `Unknown provider ""`. Every 0.9.x login wrote it.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CLI module, no types
import { localActivationPatch, resolveConfigDefaults } from "../cli/config.mjs";

describe("localActivationPatch — what setup writes", () => {
  const url = "http://localhost:3000";

  it("records the local gateway on a fresh machine, even though it equals the built-in default", () => {
    expect(localActivationPatch({ switching: false, globalValues: {}, targetUrl: url })).toEqual({
      PASSCONTROL_GATEWAY: url,
    });
  });

  it("records it when the file names an EMPTY gateway", () => {
    expect(localActivationPatch({ switching: false, globalValues: { PASSCONTROL_GATEWAY: "" }, targetUrl: url })).toEqual({
      PASSCONTROL_GATEWAY: url,
    });
  });

  it("writes nothing when the config already names this gateway", () => {
    expect(localActivationPatch({ switching: false, globalValues: { PASSCONTROL_GATEWAY: url }, targetUrl: url })).toBeNull();
  });

  it("switching from another gateway also forgets its credentials, as before", () => {
    expect(localActivationPatch({ switching: true, globalValues: { PASSCONTROL_GATEWAY: "https://passcontrol.vertias.eu" }, targetUrl: url })).toEqual({
      PASSCONTROL_GATEWAY: url,
      PASSPORT_ID: "",
      PASSPORT_SECRET: "",
      PASSPORT_KEY_STORAGE: "",
      PASSCONTROL_API_KEY: "",
    });
  });
});

describe("resolveConfigDefaults — an empty value is unset", () => {
  it("an empty PROVIDER or MODEL falls back to the defaults", () => {
    expect(resolveConfigDefaults({ PROVIDER: "", MODEL: "", PASSCONTROL_GATEWAY: "" })).toEqual({
      provider: "anthropic",
      gateway: "http://localhost:3000",
    });
  });

  it("keeps values that are set", () => {
    expect(resolveConfigDefaults({ PROVIDER: "openai", PASSCONTROL_GATEWAY: "https://gw.example/" })).toEqual({
      provider: "openai",
      gateway: "https://gw.example",
    });
  });

  it("uses the defaults when nothing is set", () => {
    expect(resolveConfigDefaults({})).toEqual({ provider: "anthropic", gateway: "http://localhost:3000" });
  });
});
