import type { ReactNode } from "react";

export function MetricCard({
  label,
  value,
  unit,
  icon,
  highlight,
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon?: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg border p-5 transition-colors " +
        (highlight ? "border-primary/50 bg-primary/10" : "border-border bg-card hover:border-primary/30")
      }
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-bold text-primary">{value}</div>
            {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
          </div>
        </div>
        {icon && <div className="text-primary/60">{icon}</div>}
      </div>
    </div>
  );
}
