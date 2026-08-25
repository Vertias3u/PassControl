/**
 * The report vocabulary and the body bounds, in a plain module.
 *
 * These lived in app/dashboard/report/actions.ts until the production build
 * rejected it: a "use server" file may export ONLY async functions, so a single
 * exported const there breaks the build while every unit test still passes —
 * vitest imports the module directly and never applies the server-action
 * transform. The client form needs these values, so they belong somewhere both
 * sides can import without dragging a server module into the browser bundle.
 *
 * The four values are duplicated in the check constraint in
 * db/migrations/0038_problem_reports.sql, which is the real enforcement; this
 * list is what the form renders and what the action validates against before
 * the database gets a chance to refuse.
 */
export const PROBLEM_REPORT_TYPES = ["bug", "confusing", "feature", "security"] as const;
export type ProblemReportType = (typeof PROBLEM_REPORT_TYPES)[number];

export const MESSAGE_MIN = 20;
export const MESSAGE_MAX = 4_000;
