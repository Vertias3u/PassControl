// How an agent's limits read to a person (1.4.0 candidate 2): one formatter for the
// MCP `budget` tool and `passcontrol statusline`, fed by GET /api/v1/self.
//
// The rules a money display gets wrong first:
//   * unknown is "?", never "$0.00";
//   * no limit says "no limit", never "$0.00 of null";
//   * a real but tiny amount is "<$0.01", not "$0.00".
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM CLI module, no declaration file
import { budgetLines, formatUsd, panelRows, paused, statusLine } from "../cli/budget-format.mjs";

const USD = 100_000_000; // microcents per dollar
const self = (budget: Record<string, unknown>) => ({ agent_id: "a", auth: "passport", scope: [], as_of: "", budget });
const DAY = { kind: "day", limit_microcents: 2 * USD, used_microcents: 0.42 * USD, remaining_microcents: 1.58 * USD, resets_in_seconds: 11 * 3600 };

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [42_000_000, "$0.42"],
    [2 * USD, "$2.00"],
    [123_456 * USD, "$123,456.00"],
    [1, "<$0.01"],
    [null, "?"],
  ])("%s µ¢ is %s", (value, text) => {
    expect(formatUsd(value)).toBe(text);
  });
});

describe("statusLine", () => {
  it("leads with today's spend against the daily limit", () => {
    expect(statusLine(self({ tokens: null, cost: null, period: DAY }))).toBe("PassControl · $0.42 of $2.00 today");
  });

  it("names a monthly limit as this month", () => {
    expect(statusLine(self({ tokens: null, cost: null, period: { ...DAY, kind: "month" } }))).toBe(
      "PassControl · $0.42 of $2.00 this month"
    );
  });

  it("falls back to the lifetime dollar cap, then the token cap", () => {
    const cost = { limit_microcents: 5 * USD, used_microcents: 1.2 * USD, remaining_microcents: 3.8 * USD };
    expect(statusLine(self({ tokens: null, cost, period: null }))).toBe("PassControl · $1.20 of $5.00 total");
    const tokens = { limit: 50_000, used: 12_300, remaining: 37_700 };
    expect(statusLine(self({ tokens, cost: null, period: null }))).toBe("PassControl · 12.3k of 50k tokens");
  });

  it("says no limit when there is none", () => {
    expect(statusLine(self({ tokens: null, cost: null, period: null }))).toBe("PassControl · no limit");
  });

  it("shows an unreadable count as ?, never $0.00", () => {
    const line = statusLine(self({ tokens: null, cost: null, period: { ...DAY, used_microcents: null, remaining_microcents: null } }));
    expect(line).toBe("PassControl · ? of $2.00 today");
  });

  it("says when the limit itself cannot be read", () => {
    expect(statusLine(self({ tokens: null, cost: null, period: { unknown: true } }))).toBe("PassControl · limit unknown");
  });
});

describe("budgetLines", () => {
  it("states every limit with what is left and when the period resets", () => {
    const cost = { limit_microcents: 5 * USD, used_microcents: 1.2 * USD, remaining_microcents: 3.8 * USD };
    const lines = budgetLines(self({ tokens: null, cost, period: DAY }));
    expect(lines).toEqual([
      "Today: $0.42 of $2.00 used, $1.58 left (resets in 11h).",
      "Lifetime: $1.20 of $5.00 used, $3.80 left.",
    ]);
  });

  it("says plainly when nothing limits the agent", () => {
    expect(budgetLines(self({ tokens: null, cost: null, period: null }))).toEqual(["No spending or token limit is set for this agent."]);
  });
});

// 1.6.0: the pace from /self (lib/budget-pace.ts), on each surface that shows a limit.
describe("pace", () => {
  const NOW = Date.UTC(2026, 9, 22, 12);
  const opts = { nowMs: NOW, timeZone: "UTC" };
  const paced = (budget: Record<string, unknown>, pace: unknown) => ({ ...self(budget), pace });
  const reaching = (hours: number, limit = "period", basis = "this_period") => ({
    reaches_limit_at: new Date(NOW + hours * 3600e3).toISOString(),
    limit,
    basis,
  });

  it("the status line says when the limit it shows runs out", () => {
    expect(statusLine(paced({ tokens: null, cost: null, period: DAY }, reaching(4)), opts)).toBe(
      "PassControl · $0.42 of $2.00 today · runs out at 16:00"
    );
    expect(statusLine(paced({ tokens: null, cost: { limit_microcents: 5 * USD, used_microcents: USD, remaining_microcents: 4 * USD }, period: null }, reaching(48, "cost", "last_24h")), opts)).toBe(
      "PassControl · $1.00 of $5.00 total · runs out Sat 12:00"
    );
  });

  it("the status line stays as it was with no pace, a lasting one, or one about another limit", () => {
    const plain = "PassControl · $0.42 of $2.00 today";
    expect(statusLine(paced({ tokens: null, cost: null, period: DAY }, null), opts)).toBe(plain);
    expect(statusLine(paced({ tokens: null, cost: null, period: DAY }, { reaches_limit_at: null, limit: "period", basis: "this_period" }), opts)).toBe(plain);
    expect(statusLine(paced({ tokens: null, cost: null, period: DAY }, reaching(30, "cost", "last_24h")), opts)).toBe(plain);
  });

  it("the MCP answer adds one line for it, either way", () => {
    expect(budgetLines(paced({ tokens: null, cost: null, period: DAY }, reaching(4)), opts).at(-1)).toBe(
      "At this rate, today's limit runs out at 16:00."
    );
    expect(budgetLines(paced({ tokens: null, cost: null, period: DAY }, { reaches_limit_at: null, limit: "period", basis: "this_period" }), opts).at(-1)).toBe(
      "At this rate, today's limit lasts until it resets."
    );
    expect(budgetLines(paced({ tokens: null, cost: null, period: DAY }, null), opts)).toHaveLength(1);
  });

  it("the /passcontrol panel gets a Pace row", () => {
    expect(panelRows(paced({ tokens: null, cost: null, period: DAY }, reaching(4)), opts).at(-1)).toEqual(["Pace", "today's limit runs out at 16:00"]);
  });
});

// The soft pause (1.6.0, L4c): GET /api/v1/self's `pause`. While an agent is paused
// every call gets a 402, so "runs out at 16:00" would be a promise the gateway is not
// keeping: the pause replaces the pace wherever both would be said.
describe("the soft pause", () => {
  const NOW = Date.UTC(2026, 9, 22, 12);
  const opts = { nowMs: NOW, timeZone: "UTC" };
  const LATE = { ...DAY, used_microcents: 1.7 * USD, remaining_microcents: 0.3 * USD };
  const pace = { reaches_limit_at: new Date(NOW + 4 * 3600e3).toISOString(), limit: "period", basis: "this_period" };
  const at = (pause: unknown) => ({ ...self({ tokens: null, cost: null, period: LATE }), pace, pause });
  const PAUSED = { percent: 80, paused: true, limit: "period", lifted_until: null };
  const LIFTED = { percent: 80, paused: false, limit: "period", lifted_until: new Date(NOW + 3600e3).toISOString() };
  const BELOW = { percent: 80, paused: false, limit: null, lifted_until: null };

  it("the status line leads with the pause, and drops the pace", () => {
    expect(statusLine(at(PAUSED), opts)).toBe("PassControl · paused at its 80% line · $1.70 of $2.00 today");
  });

  it("the status line is as it was below the line, during a lift, and with no pause field", () => {
    const plain = "PassControl · $1.70 of $2.00 today · runs out at 16:00";
    expect(statusLine(at(BELOW), opts)).toBe(plain);
    expect(statusLine(at(LIFTED), opts)).toBe(plain);
    expect(statusLine(at(null), opts)).toBe(plain);
    expect(statusLine(at(undefined), opts)).toBe(plain);
  });

  it("the MCP answer says the agent is paused and who can let it go on, instead of the pace", () => {
    const lines = budgetLines(at(PAUSED), opts);
    expect(lines.at(-1)).toBe(
      "PassControl has paused this agent at its 80% line: it refuses model calls until the owner lets it go on from the agent's page."
    );
    expect(lines.join(" ")).not.toMatch(/At this rate/);
  });

  it("the MCP answer names a lift with its end, and the line below it", () => {
    expect(budgetLines(at(LIFTED), opts)).toContain("Its owner let it go on past its 80% pause line until 13:00.");
    expect(budgetLines(at(BELOW), opts)).toContain("PassControl pauses it at 80% of any limit, before the limit itself is reached.");
    expect(budgetLines(at(LIFTED), opts).at(-1)).toMatch(/^At this rate/);
  });

  it("the /passcontrol panel gets a Pause row, and no Pace row while paused", () => {
    const paused = panelRows(at(PAUSED), opts);
    expect(paused).toContainEqual(["Paused", "at its 80% line · the owner can let it go on from the agent's page"]);
    expect(paused.map((r: string[]) => r[0])).not.toContain("Pace");
    expect(panelRows(at(LIFTED), opts)).toContainEqual(["Pause", "lifted until 13:00 · line at 80%"]);
    expect(panelRows(at(BELOW), opts)).toContainEqual(["Pause", "at 80% of any limit"]);
  });

  it("paused() is true only for an answer that says so", () => {
    expect(paused(at(PAUSED))).toBe(true);
    for (const p of [LIFTED, BELOW, null, undefined, { paused: "yes" }]) expect(paused(at(p))).toBe(false);
    expect(paused(null)).toBe(false);
  });
  // L7 (0088): past the line with a switch set, the agent is on the cheaper model.
  describe("with a cheaper model at the line", () => {
    const sw = { provider: "openai", model: "gpt-5-mini" };
    const ON = { percent: 80, paused: false, limit: "period", lifted_until: null, switch_to: { ...sw, active: true } };
    const SET = { ...BELOW, switch_to: { ...sw, active: false } };

    it("the status line says which model it is on, and keeps the pace", () => {
      expect(statusLine(at(ON), opts)).toBe("PassControl · on gpt-5-mini past its 80% line · $1.70 of $2.00 today · runs out at 16:00");
      expect(statusLine(at(SET), opts)).toBe("PassControl · $1.70 of $2.00 today · runs out at 16:00");
    });

    it("the MCP answer says where its calls go, and that other providers pause", () => {
      expect(budgetLines(at(ON), opts)).toContain(
        "Past its 80% line, PassControl sends this agent's openai calls to gpt-5-mini instead of the model asked for; calls to any other provider are paused."
      );
      expect(budgetLines(at(SET), opts)).toContain("At 80% of any limit, PassControl switches this agent's openai calls to gpt-5-mini instead of pausing them.");
    });

    it("the panel gets a Switched row past the line, and a Pause row naming the switch below it", () => {
      expect(panelRows(at(ON), opts)).toContainEqual(["Switched", "to gpt-5-mini past its 80% line · other providers paused"]);
      expect(panelRows(at(SET), opts)).toContainEqual(["Pause", "at 80% of any limit · switches openai to gpt-5-mini"]);
    });

    it("a switch never reads as paused", () => {
      expect(paused(at(ON))).toBe(false);
    });
  });
});
