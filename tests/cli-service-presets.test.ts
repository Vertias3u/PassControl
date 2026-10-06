// `passcontrol env <service>` is .mjs and cannot import the catalog, so it keeps
// its own copy of the service list and each one's variable name. This pins both
// to lib/services (the same pattern as SERVICE_UPSTREAMS in
// tests/cli-provider-hosts.test.ts): a catalog service with no `env` preset, or
// a preset printing a different variable from the dashboard's Setup, fails here.
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs CLI module, no types
import { SERVICE_ENV, SERVICE_PRESETS } from "@/cli/presets.mjs";
import { SERVICE_CATALOG, SERVICE_IDS } from "@/lib/services/catalog";
import { SERVICE_DISPLAY } from "@/lib/services/display";

describe("CLI service presets follow the catalog", () => {
  it("offers exactly the catalog's services", () => {
    expect([...SERVICE_PRESETS].sort()).toEqual([...SERVICE_IDS].sort());
    expect(Object.keys(SERVICE_ENV).sort()).toEqual([...SERVICE_IDS].sort());
  });

  it.each(SERVICE_IDS.map((id) => [id]))("%s prints the same variable and label the dashboard uses", (id) => {
    expect(SERVICE_ENV[id].envVar).toBe(SERVICE_DISPLAY[id].envVar);
    expect(SERVICE_ENV[id].label).toBe(SERVICE_CATALOG[id].label);
  });
});
