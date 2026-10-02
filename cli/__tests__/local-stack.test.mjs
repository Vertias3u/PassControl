// 1.0.0 known issue: `setup --port-offset N` moved Supabase and Redis but left
// the dashboard on :3000, so a second install collided with the first one's
// dashboard. The dashboard moves with the offset, and setup hands that port to
// the stack script (Supabase's site URL and the receipt issuer read PORT).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dashboardOriginForOffset } from "../local-stack.mjs";

describe("dashboardOriginForOffset", () => {
  it("is the canonical :3000 with no offset, and moves with one", () => {
    expect(dashboardOriginForOffset(0)).toBe("http://localhost:3000");
    expect(dashboardOriginForOffset(500)).toBe("http://localhost:3500");
  });

  it("refuses an offset setup would refuse", () => {
    for (const bad of [-1, 10001, 1.5, Number.NaN]) expect(() => dashboardOriginForOffset(bad)).toThrow();
  });
});

describe("setup", () => {
  const source = readFileSync(new URL("../../bin/passcontrol.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function setupLocal"), source.indexOf("async function initCommand"));

  it("targets the offset dashboard and gives the stack script its port", () => {
    expect(body).toContain("dashboardOriginForOffset(offset)");
    expect(body).not.toContain("canonicalLocalDashboard()");
    expect(body).toMatch(/PORT: String\(dashboard\.port\)/);
  });
});
