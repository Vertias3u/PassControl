// The spending limit a new dashboard agent starts with (F1, plans/tonight-2026-10-09.md).
//
// A stranger's first agent used to spend without limit until they found the
// setting. Simon Willison's point (3 Oct 2026) is that the default should be a
// hard cap and leaving it off an explicit, clearly worded choice. So:
//
// - A new agent from the dashboard's forms or the key-import on-ramp starts with
//   a K1 periodic limit of $20 a day (owner, 2026-10-10). That limit already
//   exists and the gate already enforces it; this module only decides the value
//   a NEW agent is created with. Existing agents are never touched.
// - Removing it takes `removeSpendingLimit: true`, literally. The absence of a
//   field is never a removal, so an old bundle or a hand-built call that sends
//   nothing still gets the limit.
// - An agent with no priced provider in scope is exempt. Under any dollar limit
//   the gateway refuses calls it cannot price (`unpriced_endpoint`), so a
//   default on a local-model or Azure agent would refuse its every call.
// - A deployment may change or switch off the default with
//   DEFAULT_AGENT_DAILY_LIMIT_USD (self-host: `.env.docker`). An unreadable value
//   keeps the default rather than silently removing it.
//
// The control API, the CLI and workspace import do not use this module: a script
// that creates agents gets exactly what it got before F1.
//
// Pure and browser-safe: the forms import the statement and the parser; the
// server reads the environment and passes the value in.
import { parseUsdBudgetToCents } from "./budget-input";
import { isProvider, providerRequiresEndpoint } from "./providers";

/** $20 a day, in cents. Sized from the 2026-10-10 measurement: a heavy Claude
 * Code fan-out holds about $10 at once, so $20 is 2x headroom. */
export const DEFAULT_DAILY_LIMIT_CENTS = 2000;

/** The opt-out, worded after Simon Willison's. Shown beside the checkbox and
 * stored in the audit row, so the record says what the owner agreed to. */
export const REMOVE_SPENDING_LIMIT_STATEMENT =
  "Remove the spending limit. Calls will not be refused past it, and I am responsible for the charges.";

/** The largest value `budget_period_cents` (an integer column) holds. */
const MAX_PERIOD_CENTS = 2_147_483_647;

/**
 * The deployment's default, in cents, from DEFAULT_AGENT_DAILY_LIMIT_USD.
 * Unset or blank → $20. "off" or "0" → no default. Anything unreadable → $20:
 * a typo must not quietly hand every new agent an unlimited budget.
 */
export function resolveDefaultDailyLimitCents(raw: string | undefined): number | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return DEFAULT_DAILY_LIMIT_CENTS;
  if (value === "off" || value === "0") return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return DEFAULT_DAILY_LIMIT_CENTS;
  const [dollars, cents = ""] = value.split(".");
  const total = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return total > 0 ? total : null;
}

/** True when a daily limit is the deployment's default amount. Value equality,
 * so the label stays right however the limit was later edited. */
export function isDefaultDailyLimit(
  kind: string | null | undefined,
  cents: number | null | undefined,
  defaultCents: number | null
): boolean {
  return defaultCents !== null && kind === "day" && cents === defaultCents;
}

/** Whether any provider in scope is one the gateway can price. Azure and local
 * have no host of ours (`providerRequiresEndpoint`) and are never priced; no
 * model scope at all means no model call to limit. */
export function scopesNeedDollarLimit(scopes: readonly { provider: string }[]): boolean {
  return scopes.some((entry) => !(isProvider(entry.provider) && providerRequiresEndpoint(entry.provider)));
}

export type NewAgentSpendLimit =
  | { source: "default" | "custom"; budget_period: "day"; budget_period_cents: number }
  | { source: "removed" | "exempt" | "off"; budget_period: null; budget_period_cents: null };

const NONE = { budget_period: null, budget_period_cents: null } as const;

/**
 * The periodic limit a new dashboard agent is created with. Throws (a message
 * safe to show) on a daily amount that is not a whole number of cents above zero.
 */
export function resolveNewAgentSpendLimit(
  scopes: readonly { provider: string }[],
  choice: { removeSpendingLimit?: unknown; dailyLimitCents?: unknown },
  defaultCents: number | null
): NewAgentSpendLimit {
  if (!scopesNeedDollarLimit(scopes)) return { source: "exempt", ...NONE };
  if (choice.removeSpendingLimit === true) return { source: "removed", ...NONE };

  const asked = choice.dailyLimitCents;
  if (asked !== undefined && asked !== null) {
    if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1 || asked > MAX_PERIOD_CENTS) {
      throw new Error(
        "The daily spending limit must be at least $0.01. To create the agent without one, tick Remove the spending limit."
      );
    }
    return {
      source: asked === defaultCents ? "default" : "custom",
      budget_period: "day",
      budget_period_cents: asked,
    };
  }
  if (defaultCents === null) return { source: "off", ...NONE };
  return { source: "default", budget_period: "day", budget_period_cents: defaultCents };
}

/**
 * What a form sends for its limit field and checkbox. A cleared field is NOT a
 * removal: removing takes the checkbox, so a cleared field with a default in
 * force is an error the owner sees, not a silent unlimited agent.
 */
export function spendLimitChoiceFromForm(
  form: { usd: string; removed: boolean },
  defaultCents: number | null
): { removeSpendingLimit?: true; dailyLimitCents?: number } {
  if (form.removed) return { removeSpendingLimit: true };
  if (!form.usd.trim()) {
    if (defaultCents === null) return {};
    throw new Error("Enter a daily spending limit, or tick Remove the spending limit.");
  }
  let cents: number | null;
  try {
    cents = parseUsdBudgetToCents(form.usd);
  } catch {
    // Its own message names the cost budget field; this is a different field.
    throw new Error("The daily spending limit must be a dollar amount, like 20 or 12.50.");
  }
  if (cents === null || cents < 1) {
    throw new Error(
      "The daily spending limit must be at least $0.01. To create the agent without one, tick Remove the spending limit."
    );
  }
  return { dailyLimitCents: cents };
}

/** "$20" or "$12.50": a limit as the refusal and the form say it. */
export function formatLimitUsd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * The message on an unpriced refusal when a periodic limit is what makes the call
 * refusable. Most such limits are the default nobody chose on purpose, so it
 * names the limit and where it is removed. Says nothing about the call itself.
 */
export function unpricedUnderPeriodLimitMessage(kind: "day" | "month", capCents: number): string {
  return (
    `This agent has a spending limit of ${formatLimitUsd(capCents)} a ${kind}, and this call cannot be priced, ` +
    "so PassControl cannot hold it to that limit. New dashboard agents start with a daily limit. " +
    "To make calls like this one, remove the limit on the agent's page in the dashboard."
  );
}
