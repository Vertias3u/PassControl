import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/system/health/route";

describe("GET /api/system/health", () => {
  it("returns the exact anonymous liveness document and nothing diagnostic", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("does not read dependencies, migration state, operator identity, or credentials", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/api/system/health/route.ts"),
      "utf8"
    );
    const imports = source.match(/^import .*$/gmu) ?? [];
    const body = source.slice(source.indexOf("export function GET"));
    expect(imports).toEqual([]);
    expect(body).not.toMatch(/getSystemHealthSnapshot|getMigrationHealth|systemOperator|serviceClient|userClient|redis\(|process\.env/i);
    expect(body).not.toMatch(/migration|vault|database|dependency|check(s)?\b/i);
  });
});
