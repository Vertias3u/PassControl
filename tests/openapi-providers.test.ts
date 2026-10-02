// The OpenAPI document's provider enums drifted from lib/providers.ts once already:
// xAI shipped (package 2, step 4) and the three enums still stopped at gemini.
// Derived from the registry, so the next provider fails here instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPE_PROVIDERS } from "@/lib/providers";

const spec = readFileSync(join(process.cwd(), "openapi.yaml"), "utf8");
const enums = [...spec.matchAll(/provider: \{ type: string, enum: \[([^\]]*)\] \}/gu)].map((m) =>
  m[1]!.split(",").map((s) => s.trim())
);

describe("openapi.yaml provider enums", () => {
  it("exist", () => {
    expect(enums.length).toBeGreaterThan(0);
  });

  it("name exactly the providers a scope may hold", () => {
    for (const values of enums) expect([...values].sort()).toEqual([...SCOPE_PROVIDERS].sort());
  });
});
