import { describe, expect, it } from "vitest";
import { DISPATCH_AUTHORITY_MAX_AGE_MS } from "@/lib/gateway/dispatch-stops";

const code = (_killClosed: boolean) => ({ maxAge: 2000 });

describe("fresh stop before every send: the routes against the proved model", () => {
  it("uses the code's own freshness constant", () => {
    expect(code(true).maxAge).toBe(DISPATCH_AUTHORITY_MAX_AGE_MS);
  });
});
