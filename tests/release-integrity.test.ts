import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("release integrity", () => {
  it("keeps public claims and package metadata aligned", () => {
    expect(
      execFileSync(process.execPath, ["scripts/check-release-integrity.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
      })
    ).toContain("release integrity verified");
  });
});
