import { describe, expect, it } from "vitest";
import { approvalHoldView } from "@/lib/approval-hold-view";

describe("approvalHoldView", () => {
  const present = { status: "fulfilled", value: true } as const;
  const cleared = { status: "fulfilled", value: false } as const;
  const failed = { status: "rejected", reason: new Error("store unreadable") } as const;

  it("shows stored taint using the live read, retaining the hold after a throw", () => {
    expect(approvalHoldView("injection_tainted", present)).toBe("tainted");
    expect(approvalHoldView("injection_tainted", cleared)).toBe("cleared");
    expect(approvalHoldView("injection_tainted", failed)).toBe("tainted");
    expect(approvalHoldView("injection_tainted", undefined)).toBe("tainted");
  });

  it("a hold for output not fully checked shows as unchecked, and cleared once the taint is gone", () => {
    expect(approvalHoldView("injection_incomplete", present)).toBe("unchecked");
    expect(approvalHoldView("injection_incomplete", failed)).toBe("unchecked");
    expect(approvalHoldView("injection_incomplete", cleared)).toBe("cleared");
  });

  it("keeps unknown and ordinary requests independent of live taint", () => {
    for (const live of [present, cleared, failed, undefined]) {
      expect(approvalHoldView("injection_unknown", live)).toBe("unknown");
      expect(approvalHoldView(undefined, live)).toBeNull();
    }
  });
});
