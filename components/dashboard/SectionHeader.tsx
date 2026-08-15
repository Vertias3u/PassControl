import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionHeader({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("pc-section-header", className)}>
      <div>
        {eyebrow ? <p className="pc-kicker">{eyebrow}</p> : null}
        <h2>{title}</h2>
        {description ? <div className="pc-section-header__description">{description}</div> : null}
      </div>
      {action ? <div className="pc-section-header__action">{action}</div> : null}
    </div>
  );
}

