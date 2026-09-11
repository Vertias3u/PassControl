import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { fare } from "@/lib/departures";
import { formatCost } from "@/lib/verify/receipt-view";
import { costMicrocents } from "@/lib/pricing";
import { PROVIDERS } from "@/lib/providers";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * A cost of zero and a cost nobody could determine are different facts, and only
 * one of them is safe to print as money.
 *
 * `lib/pricing.ts` refuses to price a call sent to a custom endpoint — a proxy
 * may mark up, re-route, alias onto a local model, or be free — and returns 0
 * because the function returns a number. That zero used to travel alone into the
 * audit row, the SIGNED receipt and the dashboard, each of which rendered it as
 * "$0.00" or "no charge". A signed receipt asserting a cost of zero for a call
 * with no known cost is a false statement on the one artifact this product asks
 * strangers to trust.
 *
 * Unlike the log-status union, NOTHING HERE FAILS TO COMPILE if a surface gets
 * it wrong: receipt claims are `Record<string, unknown>` and `cost_microcents` is
 * merely nullable. So this file is the guard, in the same spirit as
 * tests/log-status-coverage.test.ts.
 */

/**
 * Every file that turns a stored `agent_logs.cost_microcents` into something a
 * human reads. Adding a new one is a decision, not a detail: it has to choose
 * what to do with null, and this list is where that choice gets noticed.
 *
 * If this assertion fails because you added a consumer, add it here AND make it
 * render an unknown cost as anything other than a zero amount of money.
 */
const COST_CONSUMERS = [
  "components/AuditLogTable.tsx",
  "components/SpendChart.tsx",
  "components/DeparturesBoard.tsx",
  "components/dashboard/CallDetailDrawer.tsx",
  "components/dashboard/ActivityWorkspace.tsx",
  "lib/departures.ts",
  "lib/dashboard-attention.ts",
  "lib/control-graph.ts",
  "lib/log.ts",
  // Both of these present the AGGREGATE counter, `agents.spent_microcents`, and
  // reason about `agent_logs.cost_microcents` only to say what that counter is
  // NOT. The decision this list asks for is recorded there in full: the number
  // is what was charged against the budget, which Postgres defines once in 0055
  // as coalesce(enforced_microcents, coalesce(cost_microcents, 0)), so it equals
  // observed cost everywhere PassControl can price and contains a conservative
  // estimate where it cannot. Neither renders a null as $0.00 — neither ever
  // sees a null. What they used to do was worse and subtler: present the total
  // as observed money, which made the fleet card contradict a signed receipt
  // for the same call (T4-02). Both now state the basis instead.
  "app/api/control/v1/spend/route.ts",
  "components/FleetOverviewCards.tsx",
  // WHERE THE NULL IS DECIDED IN THE FIRST PLACE. Every surface below is
  // reasoning about a value this file chose: the proxy writes
  // `cost_microcents: null` for a call nobody could price, and `unpriced: true`
  // beside it to say which kind of null it is. It also decides, separately, what
  // the BUDGET was charged — an unpriced call still consumes its cost
  // reservation — and records that as `enforced_microcents` rather than
  // backfilling the price it does not know. A zero here would travel to every
  // other entry on this list as a fact.
  "app/api/v1/[provider]/[...path]/route.ts",
  // Turns a statement's signed `cost` claim into a dollar figure, for the
  // PUBLIC verifier and — since the duplicate formatter was removed — for the
  // operator's chain table too. Unlike every other entry here it never sees a
  // null: the issuer excludes an unknown cost from the signed total and counts
  // it in the `unp`/`unk` claims instead, and describeCoverage in that module
  // renders those beside the figure with the words "unknown, not zero". So the
  // decision this list asks for was made one layer up, and this file's job is
  // to not undo it by presenting the remaining total as the whole day.
  //
  // It is listed on the both-trees side of the markers below on purpose: this
  // module ships to the mirror, because a deployment that operates no chain can
  // still be handed someone else's statement to check.
  "lib/verify/statement-view.ts",
];

/**
 * Files that NAME the column without turning it into words for a reader: select
 * lists, export column sets, and the two diagnostics writers, which report an
 * agent's mirrored `spent_microcents` rather than any per-call cost. They carry
 * a null through untouched, which is correct, so there is nothing here to get
 * wrong — but they are listed rather than pattern-excluded so that a file which
 * later starts FORMATTING a cost has to move to the list above deliberately.
 */
const NON_RENDERING = [
  "app/dashboard/page.tsx",
  "app/dashboard/graph/page.tsx",
  "lib/control/columns.ts",
  "lib/account-lifecycle.ts",
  "lib/cloud-operations.ts",
  "lib/problem-diagnostics.ts",
  // A typed transport. It names the column in the statements docblock — to warn
  // a caller that `covered_count` and `cost_microcents` alone would convert "we
  // cannot say" into "zero" — and it formats nothing. Values cross it untouched,
  // nulls included. Listed rather than pattern-excluded so that an SDK method
  // which later starts FORMATTING a cost has to move up to COST_CONSUMERS
  // deliberately, which is the whole point of this list.
  "sdk/control.ts",
];

function filesMentioning(token: string, dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(rel);
      } else if (/\.tsx?$/.test(entry.name) && read(rel).includes(token)) {
        found.push(rel);
      }
    }
  };
  for (const d of dirs) walk(d);
  return found;
}

describe("an unknown cost is never presented as a zero cost", () => {
  it("the board shows a dash rather than a currency figure", () => {
    expect(fare(null)).toBe("—");
    // Zero gets the same treatment, and always has: `$0.0000` on a call that
    // simply rounded below the display precision is its own lie.
    expect(fare(0)).toBe("—");
    expect(fare(1_234_000_000)).toMatch(/^\$/);
  });

  it("a receipt distinguishes 'not priced' from 'no charge'", () => {
    expect(formatCost(0, true).primary).toMatch(/not priced/i);
    expect(formatCost(0, true).primary).not.toMatch(/free|no charge|nothing/i);
    // Absent flag keeps the words every receipt issued so far already carries.
    expect(formatCost(0).primary).toBe("No charge recorded");
  });

  it("a receipt never invents an exact figure for a cost it does not know", () => {
    expect(formatCost(0, true).exact).toBeNull();
  });

  it("every file that reads a stored cost is on the reviewed list", () => {
    const mentioning = filesMentioning("cost_microcents", ["components", "lib", "app", "sdk"]);
    const unreviewed = mentioning.filter(
      (f) => !COST_CONSUMERS.includes(f) && !NON_RENDERING.includes(f)
    );

    expect(
      unreviewed,
      `These read agent_logs.cost_microcents and are not on the reviewed list: ` +
        `${unreviewed.join(", ")}.\nA null cost means UNKNOWN, not zero. Decide what this ` +
        `surface does with it — a dash, "no recorded cost", or exclusion from a total — ` +
        `then add it to COST_CONSUMERS in this file. Do not render it as $0.00.`
    ).toEqual([]);
  });

  it("no cost renderer defaults an unknown straight into a currency string", () => {
    // The exact shape the SpendChart bar label had: `?? 0` feeding a toFixed.
    const offenders = COST_CONSUMERS.filter((f) =>
      /cost_microcents\s*\?\?\s*0\)?\s*\/\s*1e[68]\)?\.toFixed/.test(read(f))
    );

    expect(
      offenders,
      `${offenders.join(", ")} formats a defaulted-to-zero cost as money. ` +
        `Test for null first and say so in words.`
    ).toEqual([]);
  });
});

/**
 * CONTRACT ITEM 6 — a money cap that cannot bind is not a money cap.
 *
 * `costMicrocents` returns 0 when no price row matches, and `priceFor` falls
 * back to a per-provider row derived from PRICES — so a provider present in
 * PROVIDERS with no PRICES entry at all gets `undefined`, and every estimate for
 * it is zero. For an agent with a MONETARY cap that is silent and total: the
 * hold reserves nothing, admission never denies, settlement charges the same
 * zero, and the cap it was given never moves however much it spends.
 *
 * lib/pricing.ts already names this outcome — "Returning 0 here means a provider
 * was added without pricing rows, which should be treated as a bug" — but
 * nothing enforced it, so the bug was one array entry away and would have
 * shipped green. Adding a provider now fails here instead.
 */
describe("every provider can be priced", () => {
  it.each([...PROVIDERS])("%s has a usable fallback price", (provider) => {
    const cost = costMicrocents("a-model-nobody-has-a-row-for", 1_000, 1_000, provider);

    expect(
      cost,
      `${provider} is in PROVIDERS but no PRICES row yields a fallback for it, so ` +
        `every cost estimate for it is zero. An agent with a monetary cap could ` +
        `then spend without limit: the reserve is zero, so the cap never denies.`
    ).toBeGreaterThan(0);
  });
});
