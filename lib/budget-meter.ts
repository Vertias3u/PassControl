// Display thresholds only. Budget admission and attention-queue policy are separate.
export const BUDGET_METER_THRESHOLDS = { warning: 0.75, calm: 1 } as const;

type BudgetMeterTone = "neutral" | "warning" | "calm";

/** Value and limit must use the same unit; null means no honest fill to draw. */
export function budgetMeterView(value: number | null, limit: number | null): {
  tone: BudgetMeterTone | null;
  percent: number;
} {
  if (value === null || limit === null || !Number.isFinite(value) || !Number.isFinite(limit) || limit < 0) {
    return { tone: null, percent: 0 };
  }
  // Zero is a real configured cap, not the absence of one.
  const ratio = limit === 0 ? BUDGET_METER_THRESHOLDS.calm : Math.max(0, value / limit);
  return {
    tone: ratio >= BUDGET_METER_THRESHOLDS.calm
      ? "calm"
      : ratio >= BUDGET_METER_THRESHOLDS.warning ? "warning" : "neutral",
    percent: Math.min(100, ratio * 100),
  };
}
