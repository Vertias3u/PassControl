import type { CapabilityChange } from "@/lib/audit-history";

export function ImpactPreview({
  change,
  title = "Impact preview",
}: {
  change: CapabilityChange;
  title?: string;
}) {
  const changed = Boolean(change.detail?.length);
  return (
    <aside
      className="pc-impact-preview grid gap-3 rounded-lg border border-primary/30 bg-primary/[0.06] p-4"
      data-state={changed ? "changed" : "unchanged"}
      aria-label={title}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          {title}
        </p>
        <span className="rounded-full border border-primary/25 bg-background/70 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Before → after · not saved
        </span>
      </div>
      <p className="m-0 text-sm font-semibold leading-6 text-foreground">{change.summary}</p>
      {change.detail?.length ? (
        <ul className="m-0 grid list-none gap-2 p-0 text-xs leading-5 text-muted-foreground">
          {change.detail.map((line, index) => (
            <li className="flex gap-2" key={`${line}-${index}`}>
              <span aria-hidden="true" className="font-bold text-primary">→</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          The history vocabulary records no effective before/after difference.
        </p>
      )}
    </aside>
  );
}
