// The agent's own note (1.6.0, L2): what Claude Code is told about its PassControl
// limits on a prompt, opt-in, and only when it changes.
//
// Two setups, two notes, because they are different facts:
//   * "api": Claude Code's calls go through the sidecar, so the budget is the one the
//     gateway enforces on them, and saying how much is left helps the agent plan;
//   * "subscription": the calls go to Anthropic directly and never count against the
//     budget (0084), so the note leads with the tool rules, and any budget is named
//     for what it covers.
import { describe, expect, it } from "vitest";
import { agentNote } from "../agent-note.mjs";

const NOW = Date.UTC(2026, 9, 22, 12); // Thu 22 Oct, noon UTC
const TZ = "UTC";
const day = (limit, used, resetsIn = 12 * 3600) => ({
  kind: "day",
  limit_microcents: limit,
  used_microcents: used,
  remaining_microcents: used === null ? null : Math.max(0, limit - used),
  resets_in_seconds: resetsIn,
});
const self = (budget, pace = null) => ({ budget: { tokens: null, cost: null, period: null, ...budget }, pace });
const note = (s, extra = {}) => agentNote({ self: s, rules: null, mode: "api", nowMs: NOW, timeZone: TZ, ...extra });

describe("the api-mode note", () => {
  it("says what is left today, when it resets, and when it runs out at this rate", () => {
    const n = note(self({ period: day(20e8, 15e8) }, { reaches_limit_at: new Date(NOW + 4 * 3600e3).toISOString(), limit: "period", basis: "this_period" }));
    expect(n.text).toBe(
      "PassControl budget note (sent when it changes): $5.00 of $20.00 left today; it resets at 00:00. At this rate it runs out at 16:00."
    );
  });

  it("says it lasts until the reset when the pace says so, and nothing about pace when there is none", () => {
    const lasting = note(self({ period: day(20e8, 2e8) }, { reaches_limit_at: null, limit: "period", basis: "this_period" }));
    expect(lasting.text).toMatch(/At this rate it lasts until the reset\.$/);
    expect(note(self({ period: day(20e8, 2e8) })).text).toMatch(/resets at 00:00\.$/);
  });

  it("names a day further away by its weekday", () => {
    const cost = { limit_microcents: 10e8, used_microcents: 4e8, remaining_microcents: 6e8 };
    const n = note(self({ cost }, { reaches_limit_at: new Date(NOW + 48 * 3600e3).toISOString(), limit: "cost", basis: "last_24h" }));
    expect(n.text).toBe("PassControl budget note (sent when it changes): $6.00 of $10.00 left in total. At this rate it runs out Sat 12:00.");
  });

  it("says plainly when the budget is used up", () => {
    expect(note(self({ period: day(20e8, 20e8) })).text).toBe(
      "PassControl budget note (sent when it changes): the budget for today is used up; PassControl refuses model calls until it resets at 00:00."
    );
  });

  it("has nothing to say with no limit, or an unreadable one", () => {
    expect(note(self({}))).toBeNull();
    expect(note(self({ period: { unknown: true } }))).toBeNull();
    expect(note(self({ period: day(20e8, null) }))).toBeNull();
    expect(note(null)).toBeNull();
  });

  it("leaves the tool rules out: in this setup nothing enforces them", () => {
    const rules = { state: "ok", document: { rules: [{ tool: "Bash", command: "git push*", effect: "ask_owner" }] } };
    expect(note(self({ period: day(20e8, 2e8) }), { rules }).text).not.toMatch(/git push/);
  });
});

describe("the signature: a note is sent again only when something meaningful moved", () => {
  const at = (used, extra = {}) => note(self({ period: day(20e8, used) }), extra).signature;

  it("is the same inside a band and changes across one", () => {
    expect(at(1e8)).toBe(at(4e8)); // 5 % and 20 %: both under a quarter
    expect(at(4e8)).not.toBe(at(5e8)); // 20 % → 25 %
    expect(at(15e8)).not.toBe(at(18e8)); // 75 % → 90 %
    expect(at(18e8)).not.toBe(at(20e8)); // 90 % → used up
  });

  it("changes when the reset comes within the hour", () => {
    const far = note(self({ period: day(20e8, 1e8, 7200) })).signature;
    const near = note(self({ period: day(20e8, 1e8, 1800) })).signature;
    expect(far).not.toBe(near);
  });

  it("does not change with every small move of the pace", () => {
    const p = (h) => ({ reaches_limit_at: new Date(NOW + h * 3600e3).toISOString(), limit: "period", basis: "this_period" });
    expect(note(self({ period: day(20e8, 15e8) }, p(4))).signature).toBe(note(self({ period: day(20e8, 15e8) }, p(5))).signature);
    // Reaching the limit before the reset, or not, is a change.
    expect(note(self({ period: day(20e8, 15e8) }, p(4))).signature).not.toBe(
      note(self({ period: day(20e8, 15e8) }, { ...p(4), reaches_limit_at: null })).signature
    );
  });
});

describe("the subscription-mode note", () => {
  const sub = (s, rules) => agentNote({ self: s, rules, mode: "subscription", nowMs: NOW, timeZone: TZ });
  const rules = (list) => ({ state: "ok", document: { rules: list } });

  it("leads with the tool rules, as the owner wrote them", () => {
    const n = sub(
      self({}),
      rules([
        { tool: "Bash", command: "git push*", effect: "ask_owner" },
        { tool: "Write", path: "/etc/*", effect: "deny" },
        { tool: "WebFetch", domain: "*.example.com", effect: "ask" },
      ])
    );
    expect(n.text).toBe(
      "PassControl note (sent when it changes): this agent's tool rules are Bash `git push*` waits for the owner's approval; Write `/etc/*` is refused; WebFetch `*.example.com` asks in the terminal. They are set on the agent's page."
    );
  });

  it("names a budget for what it covers: calls through PassControl, not this Claude plan", () => {
    const n = sub(self({ period: day(20e8, 2e8) }), null);
    expect(n.text).toBe(
      "PassControl note (sent when it changes): calls made through PassControl (not this Claude plan) have $18.00 of $20.00 left today."
    );
  });

  it("caps a long rule list and every pattern", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ tool: "Bash", command: `cmd${i}*`, effect: "deny" }));
    expect(sub(self({}), rules(many)).text).toMatch(/and 3 more\. They are set/);
    const long = sub(self({}), rules([{ tool: "Bash", command: `${"x".repeat(200)}*`, effect: "deny" }])).text;
    expect(long).toMatch(/x{60}…` is refused/);
  });

  it("has nothing to say with no rules and no limit, and an unreadable rule set is not described", () => {
    expect(sub(self({}), null)).toBeNull();
    expect(sub(self({}), { state: "none" })).toBeNull();
    expect(sub(self({}), { state: "invalid" })).toBeNull();
  });

  it("changes its signature when the rules change", () => {
    const a = sub(self({}), rules([{ tool: "Bash", command: "git push*", effect: "ask_owner" }])).signature;
    const b = sub(self({}), rules([{ tool: "Bash", command: "git push*", effect: "deny" }])).signature;
    expect(a).not.toBe(b);
  });
});

// The soft pause (1.6.0, L4c): a paused agent is told it is paused, not when it runs
// out, because every call it makes is refused until the owner lets it go on.
describe("the soft pause", () => {
  const PACE = { reaches_limit_at: new Date(NOW + 4 * 3600e3).toISOString(), limit: "period", basis: "this_period" };
  const at = (pause, used = 17e8) => ({ ...self({ period: day(20e8, used) }, PACE), pause });
  const PAUSED = { percent: 80, paused: true, limit: "period", lifted_until: null };
  const LIFTED = { percent: 80, paused: false, limit: "period", lifted_until: new Date(NOW + 3600e3).toISOString() };

  it("says the agent is paused and who can let it go on, instead of the pace", () => {
    expect(note(at(PAUSED)).text).toBe(
      "PassControl budget note (sent when it changes): $3.00 of $20.00 left today; it resets at 00:00. " +
        "PassControl has paused this agent at its 80% line and refuses its model calls until the owner lets it go on."
    );
  });

  it("names a lift and its end, and keeps the pace", () => {
    expect(note(at(LIFTED)).text).toMatch(/Its owner let it go on past its 80% pause line until 13:00\. At this rate it runs out at 16:00\.$/);
  });

  it("a used-up limit is said as before: the hard limit is the one refusing", () => {
    expect(note(at(PAUSED, 20e8)).text).toMatch(/the budget for today is used up/);
    expect(note(at(PAUSED, 20e8)).text).not.toMatch(/paused/);
  });

  it("is sent again when the agent is paused, and when it is let go on", () => {
    const below = note(at({ percent: 80, paused: false, limit: null, lifted_until: null })).signature;
    expect(note(at(PAUSED)).signature).not.toBe(below);
    expect(note(at(LIFTED)).signature).not.toBe(note(at(PAUSED)).signature);
    expect(note(at(LIFTED)).signature).not.toBe(below);
  });

  it("in subscription mode, names the pause for what it covers", () => {
    const n = agentNote({ self: at(PAUSED), rules: null, mode: "subscription", nowMs: NOW, timeZone: TZ });
    expect(n.text).toBe(
      "PassControl note (sent when it changes): calls made through PassControl (not this Claude plan) are paused at this agent's 80% line until the owner lets them go on."
    );
  });

  // L7 (0088): past the line with a cheaper model set, the agent is told which.
  const SWITCHED = { percent: 80, paused: false, limit: "period", lifted_until: null, switch_to: { provider: "openai", model: "gpt-5-mini", active: true } };

  it("says where its calls go past the line, and keeps the pace", () => {
    expect(note(at(SWITCHED)).text).toMatch(
      /Past its 80% line, PassControl sends its openai calls to gpt-5-mini instead of the model it asks for; calls to any other provider are paused\. At this rate it runs out at 16:00\.$/
    );
  });

  it("is sent again when the switch starts", () => {
    const below = note(at({ percent: 80, paused: false, limit: null, lifted_until: null })).signature;
    expect(note(at(SWITCHED)).signature).not.toBe(below);
    expect(note(at(SWITCHED)).signature).not.toBe(note(at(PAUSED)).signature);
  });

  it("in subscription mode, names the switch for what it covers", () => {
    const n = agentNote({ self: at(SWITCHED), rules: null, mode: "subscription", nowMs: NOW, timeZone: TZ });
    expect(n.text).toBe(
      "PassControl note (sent when it changes): calls made through PassControl (not this Claude plan) to openai go to gpt-5-mini past this agent's 80% line."
    );
  });
});
