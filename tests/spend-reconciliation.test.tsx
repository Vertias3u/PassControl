import type { SupabaseClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpendReconciliation } from "@/components/SpendReconciliation";
import { buildSpendReconciliation } from "@/lib/spend-reconciliation";
import type { SpendReconciliation as Value } from "@/lib/spend-reconciliation";

const base: Value = {
  state: "pending",
  settled_tokens: 2_400,
  settled_microcents: 42_000_000,
  log_attributed_tokens: 1_900,
  log_attributed_microcents: 3_093_700,
  adjustment_tokens: 100,
  adjustment_microcents: 8_000_000,
  attributable_tokens: 2_000,
  attributable_microcents: 11_093_700,
  difference_tokens: 400,
  difference_microcents: 30_906_300,
  contributing_logs: 2,
  contributing_adjustments: 1,
  last_reconciled_at: "2026-09-12T09:00:00Z",
  holds_state: "available",
  open_reserved_tokens: 500,
  open_reserved_microcents: 4_000_000,
  open_holds: 2,
};

describe("settled budget reconciliation UI", () => {
  it("shows the equation and keeps open holds outside the settled total", () => {
    const html = renderToStaticMarkup(<SpendReconciliation value={base} />);
    expect(html).toContain("Settled budget charges");
    expect(html).toContain("Durable call charges");
    expect(html).toContain("$0.030937");
    expect(html).toContain("Operator adjustments");
    expect(html).toContain("Counter difference");
    expect(html).toContain("$0.420000");
    expect(html).toContain("Open reserved estimate");
    expect(html).toContain("not yet charged");
  });

  it("renders unavailable durable and hold reads as unavailable, never zero", () => {
    const html = renderToStaticMarkup(<SpendReconciliation value={{
      ...base,
      state: "unavailable",
      log_attributed_tokens: null,
      log_attributed_microcents: null,
      adjustment_tokens: null,
      adjustment_microcents: null,
      attributable_tokens: null,
      attributable_microcents: null,
      difference_tokens: null,
      difference_microcents: null,
      contributing_logs: null,
      contributing_adjustments: null,
      holds_state: "unavailable",
      open_reserved_tokens: null,
      open_reserved_microcents: null,
      open_holds: null,
    }} />);
    expect(html).toContain("Durable explanation unavailable");
    expect(html).toContain("Live reservation state is unavailable");
    expect(html).not.toContain("0 open holds");
    expect(html).toContain("$0.420000");
  });
});

// The builder had no direct test at all: the file above only rendered the view
// against a hand-written value, so nothing exercised the money arithmetic or
// the two-independent-reads contract. These do.
//
// The first case is a regression. app/dashboard/page.tsx used to call
// `buildSpendReconciliation(serviceClient(), …)`, and `serviceClient()` throws
// when the service-role env is absent — a throw at the CALL SITE, outside every
// catch inside the builder. That took the whole Control Tower down on a page
// whose entire discipline is to render a failed read as unavailable rather than
// as zero, and it broke tests/dashboard-log-error-threading.test.tsx. The client
// is now passed as a thunk so its construction shares the read's failure domain.
describe("buildSpendReconciliation", () => {
  const agents = [
    { id: "a1", spent_tokens: 1_000, spent_microcents: 5_000_000 },
    { id: "a2", spent_tokens: 400, spent_microcents: 1_000_000 },
  ];

  // Only `.rpc` is reached, so only `.rpc` is stubbed. A whole SupabaseClient
  // double here would assert nothing extra and hide which call is load-bearing.
  const explanation = (over: Record<string, unknown> = {}) => ({
    rpc: async () => ({
      data: [{
        log_tokens: 1_200,
        log_microcents: 5_500_000,
        adjustment_tokens: 200,
        adjustment_microcents: 500_000,
        attributable_tokens: 1_400,
        attributable_microcents: 6_000_000,
        contributing_logs: 3,
        contributing_adjustments: 1,
        last_reconciled_at: "2026-09-12T09:00:00Z",
        ...over,
      }],
      error: null,
    }),
  }) as unknown as SupabaseClient;

  const holds = async () =>
    new Map([
      ["a1", { tokens: 300, microcents: 900_000, openHolds: 2 }],
      ["a2", { tokens: 0, microcents: 0, openHolds: 0 }],
    ]);

  it("keeps the settled counters and the holds read when the client cannot be built", async () => {
    const value = await buildSpendReconciliation(
      () => {
        throw new Error("Supabase service env not set");
      },
      "user-1",
      agents,
      holds
    );

    // The defect this replaces was a thrown page, not a wrong number.
    expect(value.state).toBe("unavailable");
    expect(value.attributable_microcents).toBeNull();
    expect(value.difference_microcents).toBeNull();
    // Settled comes from the agent rows already in hand — never nulled, never zeroed.
    expect(value.settled_tokens).toBe(1_400);
    expect(value.settled_microcents).toBe(6_000_000);
    // And the OTHER read is independent: losing the database must not erase
    // live reservations. A version that nulled both would pass on state alone.
    expect(value.holds_state).toBe("available");
    expect(value.open_holds).toBe(2);
    expect(value.open_reserved_microcents).toBe(900_000);
  });

  it("reports reconciled when the durable explanation matches the counters exactly", async () => {
    const value = await buildSpendReconciliation(
      () => explanation({ attributable_tokens: 1_400, attributable_microcents: 6_000_000 }),
      "user-1",
      agents,
      holds
    );
    expect(value.state).toBe("reconciled");
    expect(value.difference_tokens).toBe(0);
    expect(value.difference_microcents).toBe(0);
    expect(value.contributing_logs).toBe(3);
    expect(value.last_reconciled_at).toBe("2026-09-12T09:00:00Z");
  });

  it("shows a difference rather than hiding it", async () => {
    const value = await buildSpendReconciliation(
      () => explanation({ attributable_tokens: 1_000, attributable_microcents: 4_000_000 }),
      "user-1",
      agents,
      holds
    );
    expect(value.state).toBe("pending");
    expect(value.difference_tokens).toBe(400);
    expect(value.difference_microcents).toBe(2_000_000);
  });

  it("marks reservations unavailable instead of reporting zero open holds", async () => {
    const value = await buildSpendReconciliation(
      () => explanation(),
      "user-1",
      agents,
      async () => {
        throw new Error("Redis unreachable");
      }
    );
    // "Unavailable" and "no holds" are different facts about money.
    expect(value.holds_state).toBe("unavailable");
    expect(value.open_holds).toBeNull();
    expect(value.open_reserved_microcents).toBeNull();
    expect(value.attributable_microcents).toBe(6_000_000);
  });
});
