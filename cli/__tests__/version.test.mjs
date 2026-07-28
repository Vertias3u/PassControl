import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../config.mjs";

// The MCP server used to carry its own hardcoded `version:` and was still announcing
// 0.2.0 to every connected client at package 0.4.0. It reads PACKAGE_VERSION now; the
// source-text guard for the site surfaces lives in tests/site-metadata.test.ts.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("shipped CLI version", () => {
  it("matches the installed package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(PACKAGE_VERSION).not.toBe("0.0.0");
  });
});
