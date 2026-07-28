import Link from "next/link";

export default function AgentPassportNotFound() {
  return (
    <main className="mx-auto grid min-h-screen max-w-lg place-content-center gap-5 px-4 py-16 text-center sm:px-6">
      <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Control Tower · identity registry
      </p>
      <h1 className="m-0 text-2xl font-bold text-foreground">Passport not found</h1>
      <p className="m-0 text-sm leading-6 text-muted-foreground">
        This passport is unavailable. Check the address or return to your fleet.
      </p>
      <Link
        href="/dashboard"
        className="mx-auto inline-flex items-center rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-semibold text-foreground no-underline transition-colors hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Return to Control Tower
      </Link>
    </main>
  );
}
