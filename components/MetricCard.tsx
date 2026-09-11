import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

export function MetricCard({
  label,
  value,
  unit,
  icon,
  note,
  href,
  tone = "neutral",
  state,
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon?: ReactNode;
  note?: string;
  href?: string;
  tone?: "neutral" | "signal" | "warning" | "danger";
  /**
   * "unavailable" when the figure could not be read at all — distinct from a
   * measured zero, and machine-readable so a test can assert on the state
   * rather than on the wording, which is the part that drifts.
   */
  state?: "unavailable";
}) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="pc-metric-card__label">
            {label}
          </div>
          <div className="flex items-baseline gap-2">
            <div className="pc-metric-card__value">{value}</div>
            {unit && <span className="pc-metric-card__unit">{unit}</span>}
          </div>
        </div>
        {icon ? <div className="pc-metric-card__icon">{icon}</div> : null}
      </div>
      <div className="pc-metric-card__footer">
        <span>{note ?? "Current account state"}</span>
        {href ? <ArrowUpRight aria-hidden="true" /> : null}
      </div>
    </>
  );

  const className = `pc-metric-card pc-metric-card--${tone}`;
  return href ? (
    <Link href={href} className={className} data-state={state}>
      {content}
    </Link>
  ) : (
    <div className={className} data-state={state}>
      {content}
    </div>
  );
}
