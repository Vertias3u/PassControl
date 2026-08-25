// /api/version answers with the build, and only the build.
//
// The endpoint exists so `passcontrol version` can compare the CLI against the
// gateway. The risk it has to keep refusing is scope creep: the migration state
// is the obvious thing to add here and the one thing that must not be, because
// "which migrations are missing" is "which fixes this instance does not have".
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/version/route";
import { RELEASE_VERSION } from "@/lib/version";

describe("GET /api/version", () => {
  it("reports the build the gateway is running", async () => {
    const body = await GET().json();
    expect(body).toEqual({ version: RELEASE_VERSION });
  });

  it("renders the version from package.json, never a typed literal", () => {
    // Same rule as tests/site-metadata.test.ts: a hand-typed version drifts.
    const source = String(GET);
    expect(source).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("volunteers nothing about the database", async () => {
    const body = (await GET().json()) as Record<string, unknown>;
    for (const leak of ["schema", "migrations", "applied", "expected", "checks", "vault"]) {
      expect(Object.keys(body)).not.toContain(leak);
    }
    expect(Object.keys(body)).toHaveLength(1);
  });

  it("is fetchable by another deployment's server", async () => {
    expect(GET().headers.get("access-control-allow-origin")).toBe("*");
  });
});
