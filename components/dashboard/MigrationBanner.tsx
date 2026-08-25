import Link from "next/link";

import type { SystemHealthSnapshot } from "@/lib/system-health";

type Migrations = SystemHealthSnapshot["migrations"];

/**
 * The migration verdict, brought to the operator instead of waiting on a page.
 *
 * System Health already classifies this correctly and renders it in detail —
 * behind a page you must know exists, navigate to, and be a named operator with
 * verified TOTP to open. A database behind the build serving it is therefore
 * invisible until somebody goes looking, which is exactly how the live Cloud
 * database stayed behind without the product ever mentioning it.
 *
 * ── Two deliberate choices ──────────────────────────────────────────────────
 *
 * It warns and never blocks. On an identity gateway, turning a schema warning
 * into an outage is the worse failure — the same reasoning that makes the kill
 * switch fail open. So there is no state here that stops a page rendering.
 *
 * It renders only for the operators the deployment names, because the caller
 * only asks for it then. How far behind a database is doubles as a list of the
 * fixes it does not have yet, which is not a thing to show a tenant.
 *
 * `data-state` carries a SEVERITY the stylesheet already knows; the untranslated
 * verdict rides along in `data-migration-state` so a test can assert on the real
 * classification rather than on its colour.
 */

const SEVERITY: Record<Migrations["state"], "attention" | "incompatible" | null> = {
  current: null, // nothing to say, and a banner that is always there is furniture
  behind: "attention",
  ahead: "attention",
  incompatible: "incompatible",
  unknown: "attention",
};

function describe(migrations: Migrations): { title: string; detail: string } {
  switch (migrations.state) {
    case "behind":
      return {
        title: `This database is missing ${migrations.missing_count} migration${migrations.missing_count === 1 ? "" : "s"} this build expects`,
        detail: `Applied ${migrations.applied_head ?? "nothing"}; this build expects ${migrations.expected_head}. Until they are applied, fixes shipped in those migrations are not in effect here.`,
      };
    case "ahead":
      // Genuinely different from "behind", and the reason the state exists: the
      // database moved forward and the app moved back.
      return {
        title: "This database is newer than the build serving it",
        detail: `Applied ${migrations.applied_head ?? "unknown"}, ${migrations.extra_count} beyond what this build knows about. Usually this means the application was rolled back without rolling back the database.`,
      };
    case "incompatible":
      return {
        title: "The applied migrations do not match this build",
        detail:
          "The ledger disagrees with the migrations this build was made from — a checksum, an order, or a duplicate. This is not a count of missing files; resolve it before relying on anything here.",
      };
    case "unknown":
      return {
        title: "The migration ledger could not be read",
        detail:
          "No verdict is being guessed from a partial answer. The database may be unreachable, or the ledger may not have been vetted.",
      };
    default:
      return { title: "", detail: "" };
  }
}

export function MigrationBanner({ migrations }: { migrations: Migrations }) {
  const severity = SEVERITY[migrations.state];
  if (!severity) return null;

  const { title, detail } = describe(migrations);
  return (
    <section
      className="pc-system-health-banner"
      data-state={severity}
      data-migration-state={migrations.state}
      role="status"
      aria-live="polite"
    >
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <Link className="pc-system-health-card__action" href="/dashboard/system">
        Open System health
      </Link>
    </section>
  );
}
