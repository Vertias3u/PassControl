import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTANCE_LABEL, instanceLabel } from "@/lib/instance-label";

// What this deployment calls itself, in one place.
//
// The dashboard sidebar hardcoded "Local control plane" and shipped it to
// production — on 2026-08-17 the live Control Tower at passcontrol.vertias.eu
// introduced itself as local. The login screen beside it had always read the
// label from `PASSCONTROL_INSTANCE_LABEL`, so the same deployment could be
// named correctly on one screen and wrongly on the next.
//
// The source assertions below are the half that would have caught it: a helper
// nobody calls fixes nothing. Same guard-the-literal discipline as
// `tests/site-metadata.test.ts`, and for the same reason — these are JSX files
// the runner cannot import without a bundler plugin.
async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const SHELLS = ["components/dashboard/DashboardShell.tsx", "components/auth/AuthShell.tsx"];

afterEach(() => {
  delete process.env.PASSCONTROL_INSTANCE_LABEL;
});

describe("instance label", () => {
  it("falls back to a name that is true on any deployment", () => {
    delete process.env.PASSCONTROL_INSTANCE_LABEL;
    expect(instanceLabel()).toBe(DEFAULT_INSTANCE_LABEL);
    // The default must not claim a location. It is rendered unchanged on a
    // hosted control plane whenever the variable is unset — which is the state
    // production is in — so a default of "Local …" is a lie by default.
    expect(DEFAULT_INSTANCE_LABEL.toLowerCase()).not.toContain("local");
  });

  it("uses the configured label, trimmed", () => {
    process.env.PASSCONTROL_INSTANCE_LABEL = "  PassControl Cloud  ";
    expect(instanceLabel()).toBe("PassControl Cloud");
  });

  it("treats a blank value as unset rather than as an empty name", () => {
    process.env.PASSCONTROL_INSTANCE_LABEL = "   ";
    expect(instanceLabel()).toBe(DEFAULT_INSTANCE_LABEL);
  });

  it("is what both shells render — neither may hardcode a name", async () => {
    for (const path of SHELLS) {
      const text = await source(path);
      expect(text).toContain("instanceLabel");
      expect(text).not.toContain("Local control plane");
      // A second inline `process.env.PASSCONTROL_INSTANCE_LABEL ?? "…"` is how
      // the two drifted apart the first time. One reader, one default.
      expect(text).not.toContain("PASSCONTROL_INSTANCE_LABEL");
    }
  });
});
