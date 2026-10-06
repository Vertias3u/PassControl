// Where "Report a problem" goes, for the sidebar account menu and the mobile nav.
//
// Cloud's report page writes into our database and our triage view reads it.
// On a self-hosted instance the report would land in the operator's own
// database with no triage view to read it (that view is Cloud-only, pruned by
// scripts/curate-public.sh), so Core sends the report to the public repository's
// issue tracker instead. The chooser shows .github/ISSUE_TEMPLATE: a bug form that
// warns against pasting secrets, and private reporting for security bugs.
export type ReportProblemLink = { href: string; external: boolean };

export const REPORT_PROBLEM_LINK: ReportProblemLink = { href: "https://github.com/Vertias3u/PassControl/issues/new/choose", external: true };
