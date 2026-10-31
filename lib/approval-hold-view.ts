import type { ApprovalHold } from "@/lib/state/approvals";

export type ApprovalHoldView = "tainted" | "cleared" | "unknown" | null;

/** A failed live read retains the stored hold; only confirmed absence clears it. */
export function approvalHoldView(
  stored: ApprovalHold | undefined,
  live: PromiseSettledResult<boolean> | undefined
): ApprovalHoldView {
  if (stored === "injection_unknown") return "unknown";
  if (stored !== "injection_tainted") return null;
  return live?.status === "fulfilled" && !live.value ? "cleared" : "tainted";
}
