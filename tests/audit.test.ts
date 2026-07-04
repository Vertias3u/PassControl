import { describe, it, expect } from "vitest";
import { buildAuditRecord, AUDIT_ACTIONS } from "../lib/audit";

describe("buildAuditRecord — admin-action audit row", () => {
  it("builds a row for a known action", () => {
    const rec = buildAuditRecord({
      userId: "user-1",
      action: "agent.create",
      targetType: "agent",
      targetId: "agent-9",
      metadata: { name: "billing-bot" },
    });
    expect(rec).toEqual({
      user_id: "user-1",
      action: "agent.create",
      target_type: "agent",
      target_id: "agent-9",
      metadata: { name: "billing-bot" },
    });
  });

  it("rejects an unknown action (only our own constants may be logged)", () => {
    // @ts-expect-error — exercising the runtime guard with a bad value
    expect(() => buildAuditRecord({ userId: "u", action: "drop.tables" })).toThrow();
  });

  it("sanitizes metadata + target so an injected value can't forge log/audit lines", () => {
    const rec = buildAuditRecord({
      userId: "u",
      action: "agent.suspend",
      targetType: "agent",
      targetId: "ok\r\nfake",
      metadata: { note: "line1\r\nline2", suspended: true },
    });
    expect(String(rec.target_id)).not.toMatch(/[\r\n]/);
    expect(String((rec.metadata as any).note)).not.toMatch(/[\r\n]/);
    expect((rec.metadata as any).suspended).toBe(true); // non-strings pass through
  });

  it("bounds over-long target ids", () => {
    const rec = buildAuditRecord({ userId: "u", action: "provider_key.add", targetId: "x".repeat(500) });
    expect(String(rec.target_id).length).toBeLessThanOrEqual(200);
  });

  it("defaults missing target fields to null", () => {
    const rec = buildAuditRecord({ userId: "u", action: "killswitch.master", metadata: { on: true } });
    expect(rec.target_type).toBeNull();
    expect(rec.target_id).toBeNull();
  });

  it("covers exactly the privileged mutations", () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [
        "agent.create",
        "agent.update",
        "agent.suspend",
        "agent.revoke",
        "killswitch.master",
        "provider_key.add",
        "provider_key.rotate",
        "apikey.create",
        "apikey.revoke",
        "mfa.enroll",
        "mfa.disable",
      ].sort()
    );
  });
});
