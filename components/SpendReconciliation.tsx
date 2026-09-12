import { AlertTriangle, CheckCircle2, Clock3, Database, Scale } from "lucide-react";

import type { SpendReconciliation as Reconciliation } from "@/lib/spend-reconciliation";

const money = (value: number | null) =>
  value === null ? "—" : `$${(value / 100_000_000).toFixed(6)}`;

const signedMoney = (value: number | null) => {
  if (value === null) return "—";
  if (value === 0) return "$0.000000";
  return `${value > 0 ? "+" : "−"}$${(Math.abs(value) / 100_000_000).toFixed(6)}`;
};

export function SpendReconciliation({ value }: { value: Reconciliation }) {
  const stateLabel = value.state === "reconciled"
    ? "Reconciled"
    : value.state === "pending"
      ? "Difference visible"
      : "Durable explanation unavailable";
  const StateIcon = value.state === "reconciled"
    ? CheckCircle2
    : value.state === "pending"
      ? Clock3
      : AlertTriangle;

  return (
    <section className="pc-spend-reconciliation" data-state={value.state} aria-label="Settled budget reconciliation">
      <div className="pc-spend-reconciliation__heading">
        <div>
          <p className="pc-kicker">All-time budget ledger</p>
          <h3>Settled budget charges</h3>
          <p>The counter used for admission, explained by durable calls and operator adjustments.</p>
        </div>
        <span className="pc-spend-reconciliation__state"><StateIcon aria-hidden="true" />{stateLabel}</span>
      </div>

      <div className="pc-spend-equation">
        <div>
          <span><Database aria-hidden="true" />Durable call charges</span>
          <strong>{money(value.log_attributed_microcents)}</strong>
          <small>{value.contributing_logs === null ? "Read unavailable" : `${value.contributing_logs.toLocaleString()} charge-contributing call${value.contributing_logs === 1 ? "" : "s"}`}</small>
        </div>
        <b aria-hidden="true">+</b>
        <div data-kind="adjustment">
          <span><Scale aria-hidden="true" />Operator adjustments</span>
          <strong>{money(value.adjustment_microcents)}</strong>
          <small>{value.contributing_adjustments === null ? "Read unavailable" : `${value.contributing_adjustments.toLocaleString()} separate adjustment${value.contributing_adjustments === 1 ? "" : "s"}`}</small>
        </div>
        <b aria-hidden="true">+</b>
        <div data-kind="difference">
          <span><Clock3 aria-hidden="true" />Counter difference</span>
          <strong>{signedMoney(value.difference_microcents)}</strong>
          <small>{value.state === "unavailable" ? "Cannot be calculated" : value.state === "reconciled" ? "No difference" : "Pending or divergent state; not hidden"}</small>
        </div>
        <b aria-hidden="true">=</b>
        <div data-kind="settled">
          <span>Settled counter</span>
          <strong>{money(value.settled_microcents)}</strong>
          <small>{value.settled_tokens.toLocaleString()} tokens charged</small>
        </div>
      </div>

      <div className="pc-open-holds" data-state={value.holds_state}>
        <div>
          <span>Open reserved estimate</span>
          <strong>{money(value.open_reserved_microcents)}</strong>
        </div>
        <p>
          {value.holds_state === "unavailable"
            ? "Live reservation state is unavailable. This does not mean there are zero holds."
            : `${value.open_holds?.toLocaleString() ?? "0"} open hold${value.open_holds === 1 ? "" : "s"} · ${(value.open_reserved_tokens ?? 0).toLocaleString()} reserved tokens · not yet charged`}
        </p>
      </div>
    </section>
  );
}
