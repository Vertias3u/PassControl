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
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon?: ReactNode;
  note?: string;
  href?: string;
  tone?: "neutral" | "signal" | "warning" | "danger";
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
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}
