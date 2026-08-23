import { CircleAlert, KeyRound, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SystemOperatorReason } from "@/lib/system-health/operator";

/**
 * What a refused operator sees instead of a snapshot.
 *
 * This surface is reachable only by an account that is already authenticated,
 * so the refusal can afford to say which condition failed. It carries no
 * diagnostic data of any kind — the point is to name the next step, not to leak
 * a preview of what is behind the gate.
 *
 * One line is load-bearing: the deployment variable is named for the two
 * *deployment* states and withheld from `forbidden`. An instance that names no
 * operators is a misconfiguration its owner has to see; an account that simply
 * is not on someone else's list has no business reading that instance's
 * configuration back.
 */
type RestrictedReason = Extract<
  SystemOperatorReason,
  "enrollment_required" | "not_configured" | "misconfigured" | "forbidden"
>;

const copy: Record<RestrictedReason, {
  state: "attention" | "degraded";
  Icon: LucideIcon;
  title: string;
  body: string;
  next: string;
  href?: { label: string; url: string };
}> = {
  enrollment_required: {
    state: "attention",
    Icon: KeyRound,
    title: "Second factor required",
    body:
      "System health is restricted to operators who have verified an authenticator app. This account has no verified authenticator, so the diagnostic stays closed.",
    next: "Enrol an authenticator under Settings, then open this page again.",
    href: { label: "Go to Settings", url: "/dashboard/settings" },
  },
  not_configured: {
    state: "attention",
    Icon: ShieldCheck,
    title: "This instance names no operators",
    body:
      "System health opens only to accounts a deployment names in advance. This one names none, so it authorizes nobody — including this account. Nothing is broken; the surface has simply never been switched on.",
    next:
      "Set PASSCONTROL_SYSTEM_OPERATOR_EMAILS to a comma-separated list of operator addresses and restart the deployment.",
  },
  misconfigured: {
    state: "degraded",
    Icon: CircleAlert,
    title: "The operator list could not be read",
    body:
      "PASSCONTROL_SYSTEM_OPERATOR_EMAILS is set on this instance, but at least one entry is not a valid address. The list is rejected whole rather than applied in part, so it currently authorizes nobody.",
    next:
      "Correct every entry in PASSCONTROL_SYSTEM_OPERATOR_EMAILS and restart the deployment. A partly-valid list is treated as no list at all.",
  },
  forbidden: {
    state: "attention",
    Icon: ShieldCheck,
    title: "This account is not an operator here",
    body:
      "System health is restricted to the operator accounts this deployment names, and this account is not one of them.",
    next: "Ask an operator of this instance to add this account before trying again.",
  },
};

export function SystemHealthRestricted({ reason }: { reason: RestrictedReason }) {
  const { state, Icon, title, body, next, href } = copy[reason];

  return (
    <>
      <section className="pc-system-health-banner" data-state={state} role="status">
        <div>
          <p className="pc-kicker">Restricted surface</p>
          <strong>Not available to this account</strong>
          <span>No diagnostic data was read.</span>
        </div>
        <p>Access is refused before any instance state is collected, so nothing below reflects this deployment&rsquo;s health.</p>
      </section>
      <section className="pc-system-health-card" data-state={state} aria-labelledby="system-restricted-title">
        <div className="pc-system-health-card__heading">
          <span className="pc-system-health-card__icon"><Icon aria-hidden="true" /></span>
          <div>
            <h2 id="system-restricted-title">{title}</h2>
            <p>{body}</p>
          </div>
        </div>
        <div className="pc-system-health-card__migration" data-state={state}>
          <strong>What to do next</strong>
          <p className="pc-system-health-card__action">{next}</p>
          {href ? <p><a href={href.url}>{href.label}</a></p> : null}
        </div>
      </section>
    </>
  );
}
