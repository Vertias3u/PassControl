// The two security events reach the workspace's own channel as well as the
// platform webhook: passport rotation (dashboard and control API) and opening
// a break-glass grant. Both are moments an owner who did NOT act needs to hear
// about now. Sent in waitUntil, so a slow webhook never delays the action.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

const SITES = [
  ["app/dashboard/agents/[id]/passport-actions.ts", "passport_rotated"],
  ["app/api/control/v1/agents/[id]/rotate/route.ts", "passport_rotated"],
  ["app/dashboard/agents/[id]/break-glass-actions.ts", "break_glass"],
] as const;

describe("security events notify the workspace", () => {
  it.each(SITES)("%s sends %s next to the platform alert", (path, type) => {
    const source = read(path);
    const platform = source.indexOf("dispatchSecurityAlert(\"agent.");
    const workspace = source.indexOf(`type: "${type}"`);
    expect(platform).toBeGreaterThan(-1);
    expect(workspace).toBeGreaterThan(-1);
    expect(source).toMatch(/waitUntil\(\s*notifyWorkspace\(/u);
    // Exactly one send per event site.
    expect(source.match(/notifyWorkspace\(/gu)?.length).toBe(1);
  });

  it("does not alert when a break-glass grant is closed, only when one is opened", () => {
    const source = read("app/dashboard/agents/[id]/break-glass-actions.ts");
    expect(source.match(/type: "break_glass"/gu)?.length).toBe(1);
  });
});
