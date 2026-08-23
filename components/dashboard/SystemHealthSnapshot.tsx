import {
  BadgeCheck,
  CircleAlert,
  CircleHelp,
  CircleX,
  FileCheck2,
  HeartPulse,
  Landmark,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SystemHealthSnapshot } from "@/lib/system-health";

type CheckState = SystemHealthSnapshot["checks"][number]["state"];
type OverallState = SystemHealthSnapshot["overall"];
type HealthCategory = SystemHealthSnapshot["checks"][number]["category"];
type MigrationState = SystemHealthSnapshot["migrations"]["state"];

const stateCopy: Record<CheckState, string> = {
  ready: "Ready",
  attention: "Needs attention",
  degraded: "Degraded",
  unknown: "Unknown",
  disabled: "Not configured",
};

const overallCopy: Record<OverallState, string> = {
  current: "Current",
  attention: "Needs attention",
  degraded: "Degraded",
  incompatible: "Incompatible",
};

const migrationCopy: Record<MigrationState, string> = {
  current: "Current",
  behind: "Behind",
  ahead: "Ahead",
  incompatible: "Incompatible",
  unknown: "Unknown",
};

const stateIcon: Record<CheckState, LucideIcon> = {
  ready: BadgeCheck,
  attention: CircleAlert,
  degraded: CircleX,
  unknown: CircleHelp,
  disabled: CircleHelp,
};

const areas: Array<{
  category: HealthCategory;
  title: string;
  description: string;
  Icon: LucideIcon;
}> = [
  {
    category: "application",
    title: "Application identity",
    description: "The deployed application’s local release identity.",
    Icon: HeartPulse,
  },
  {
    category: "database",
    title: "Database & migrations",
    description: "The trusted migration ledger, not a general schema audit.",
    Icon: Landmark,
  },
  {
    category: "runtime",
    title: "Runtime dependencies",
    description: "Bounded local dependency checks. A status may be unavailable.",
    Icon: FileCheck2,
  },
  {
    category: "trust",
    title: "Trust & signing",
    description: "Local wiring; public JWKS publication is not verified here.",
    Icon: ShieldCheck,
  },
];

function displayTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(time);
}

function Card({ snapshot, category, title, description, Icon }: {
  snapshot: SystemHealthSnapshot;
  category: HealthCategory;
  title: string;
  description: string;
  Icon: LucideIcon;
}) {
  const checks = snapshot.checks.filter((check) => check.category === category);
  const mostSevere = checks.find((check) => check.state === "degraded")
    ?? checks.find((check) => check.state === "attention")
    ?? checks.find((check) => check.state === "unknown")
    ?? checks.find((check) => check.state === "disabled")
    ?? checks[0];
  const state = mostSevere?.state ?? "unknown";
  const StateIcon = stateIcon[state];

  return (
    <section className="pc-system-health-card" data-state={state} aria-labelledby={`system-${category}-title`}>
      <div className="pc-system-health-card__heading">
        <span className="pc-system-health-card__icon"><Icon aria-hidden="true" /></span>
        <div>
          <h2 id={`system-${category}-title`}>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="pc-system-health-card__status" aria-label={`${title}: ${stateCopy[state]}`}>
        <StateIcon aria-hidden="true" />
        <strong>{stateCopy[state]}</strong>
      </div>
      {category === "application" ? (
        <dl className="pc-system-health-card__facts">
          <div><dt>Release version</dt><dd>{snapshot.build.version}</dd></div>
          <div><dt>Release channel</dt><dd>{snapshot.build.channel}</dd></div>
          <div><dt>Build revision</dt><dd>{snapshot.build.commit ? snapshot.build.commit.slice(0, 7) : "Not supplied"}</dd></div>
        </dl>
      ) : null}
      {category === "database" ? (
        <div className="pc-system-health-card__migration" data-state={snapshot.migrations.state}>
          <strong>Migration ledger: {migrationCopy[snapshot.migrations.state]}</strong>
          <p>
            {snapshot.migrations.state === "unknown"
              ? "Migration counts are unavailable."
              : snapshot.migrations.state === "incompatible"
                ? "Migration ledger diverges from this build."
                : snapshot.migrations.missing_count > 0
              ? `${snapshot.migrations.missing_count} required migration${snapshot.migrations.missing_count === 1 ? "" : "s"} pending.`
              : snapshot.migrations.extra_count > 0
                ? `${snapshot.migrations.extra_count} later migration record${snapshot.migrations.extra_count === 1 ? "" : "s"} found.`
                : "No missing or later migration records reported."}
          </p>
          <p className="pc-system-health-card__action">{snapshot.migrations.action}</p>
          <dl className="pc-system-health-card__migration-heads">
            <div><dt>Expected migration</dt><dd>{snapshot.migrations.expected_head || "Unavailable"}</dd></div>
            <div><dt>Applied migration</dt><dd>{snapshot.migrations.applied_head ?? "Not recorded"}</dd></div>
          </dl>
        </div>
      ) : null}
      <details className="pc-system-health-card__details">
        <summary>View safe checks and guidance</summary>
        <ul>
          {checks.map((check) => {
            const CheckIcon = stateIcon[check.state];
            return (
              <li key={check.id} data-state={check.state}>
                <CheckIcon aria-hidden="true" />
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.summary}</p>
                  {check.action ? <p className="pc-system-health-card__action">{check.action}</p> : null}
                </div>
              </li>
            );
          })}
          {checks.length === 0 ? <li data-state="unknown"><CircleHelp aria-hidden="true" /><p>Status is unavailable.</p></li> : null}
        </ul>
      </details>
    </section>
  );
}

export function SystemHealthSnapshotView({ snapshot }: { snapshot: SystemHealthSnapshot }) {
  return (
    <>
      <section className="pc-system-health-banner" data-state={snapshot.overall} role="status" aria-live="polite">
        <div>
          <p className="pc-kicker">Instance diagnostic snapshot</p>
          <strong>{overallCopy[snapshot.overall]}</strong>
          <span>Observed <time dateTime={snapshot.generated_at}>{displayTime(snapshot.generated_at)}</time></span>
        </div>
        <p>Diagnostics do not contact model providers or verify public signing routes.</p>
      </section>
      <div className="pc-system-health-grid">
        {areas.map((area) => <Card key={area.category} snapshot={snapshot} {...area} />)}
      </div>
    </>
  );
}
