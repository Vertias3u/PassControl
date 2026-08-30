// Who may reach operator-only surfaces on this instance.
//
// Extracted from the hosted beta module, where it was the single reason eight
// Core dashboard pages imported hosted operations code. Nothing about it is
// beta-specific: an allowlist of addresses that may see operator surfaces is
// something every deployment has, and System Health (/dashboard/system) gates on
// it today.
//
// The environment variable still says BETA and must keep saying it. Renaming it
// would read as tidying and land as an outage: the live deployment sets the old
// name, so the first deploy after a rename locks its own operator out of the
// diagnostics page they would use to find out why.
//
// Empty means nobody, deliberately. An unset allowlist yields an empty Set and
// every operator surface stays closed, so a deployment that never configures
// this has no operator surfaces rather than open ones — the safe direction for a
// default nobody chose.

function normalizeOperatorEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function operatorEmails(
  raw = process.env.PASSCONTROL_BETA_OPERATOR_EMAILS
): Set<string> {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((value) => normalizeOperatorEmail(value))
      .filter(Boolean)
  );
}
