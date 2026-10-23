import { describe, expect, it, vi } from "vitest";


import { existsSync } from "node:fs";
it("omits the hosted release archive from the self-hosted build", () => {
  expect(existsSync(new URL("../app/updates", import.meta.url))).toBe(false);
});
