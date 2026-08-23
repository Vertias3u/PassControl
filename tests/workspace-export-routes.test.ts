import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const DASHBOARD_ROUTE = "app/api/workspace/export/route.ts";
const CONTROL_ROUTE = "app/api/control/v1/workspace/export/route.ts";

describe("workspace export routes", () => {
  // The account export settled this once already: `mfaAuthorizedUser` fails
  // closed and `needsMfaStepUp` does not, and they are one keystroke apart.
  // The workspace export is a complete map of a tenant's fleet — every agent,
  // its reach and its budget — so it gets the same gate, not a softer one.
  it("gates the dashboard route on the strict MFA check", async () => {
    const route = await source(DASHBOARD_ROUTE);
    expect(route).toContain("mfaAuthorizedUser(db)");
    expect(route).not.toContain("needsMfaStepUp");
  });

  it("gates before it reads, not after", async () => {
    const route = await source(DASHBOARD_ROUTE);
    const gate = route.indexOf("mfaAuthorizedUser");
    const read = route.indexOf("loadWorkspaceExport");
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(gate, "the MFA gate must run before the workspace is read").toBeLessThan(read);
  });

  it("hands the browser a file rather than a page", async () => {
    const route = await source(DASHBOARD_ROUTE);
    expect(route).toContain("content-disposition");
    expect(route).toContain("attachment");
    expect(route).toContain("no-store");
  });

  it("uses the control-plane read scope for the CLI surface", async () => {
    const route = await source(CONTROL_ROUTE);
    expect(route).toContain('control("read"');
    // The service client bypasses RLS, so the builder's own `.eq("user_id",
    // userId)` is the only tenant boundary on this path. Passing ctx.userId
    // through is therefore not plumbing — it is the boundary.
    expect(route).toContain("userId");
  });

  // Both surfaces must write the row. If only the dashboard did, the Recovery
  // panel would tell an operator who exports exclusively through the CLI that
  // they have never taken an export — which is precisely the false reassurance
  // this feature exists to remove.
  it("records the export from both surfaces, so Last export cannot lie", async () => {
    for (const path of [DASHBOARD_ROUTE, CONTROL_ROUTE]) {
      const route = await source(path);
      expect(route, `${path} must record the export`).toContain("recordAdminAction");
      expect(route, `${path} must use the registered action`).toContain('"workspace.export"');
    }
  });
});
