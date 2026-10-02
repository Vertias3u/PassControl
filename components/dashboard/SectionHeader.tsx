import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionHeader({
  eyebrow,
  title,
  icon,
  description,
  action,
  className,
}: {
  eyebrow?: string;
  title: string;
  /** Drawn before the title, e.g. a service's logo. Decorative: the title names it. */
  icon?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("pc-section-header", className)}>
      <div>
        {eyebrow ? <p className="pc-kicker">{eyebrow}</p> : null}
        {icon ? (
          <h2 className="flex items-center gap-2">
            {icon}
            {title}
          </h2>
        ) : (
          <h2>{title}</h2>
        )}
        {description ? <div className="pc-section-header__description">{description}</div> : null}
      </div>
      {action ? <div className="pc-section-header__action">{action}</div> : null}
    </div>
  );
}

