import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


import { existsSync } from "node:fs";
it("keeps the recap sender available without the hosted daily cron", () => {
  expect(existsSync(new URL("../app/api/cron/statements", import.meta.url))).toBe(false);
  expect(existsSync(new URL("../lib/alerts/recap.ts", import.meta.url))).toBe(true);
});
