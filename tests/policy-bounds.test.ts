import { describe, expect, it } from "vitest";
import { POLICY_LIMITS, evaluateAgentPolicy, globMatchWork, policyIsWellFormed } from "@/lib/scope";

/**
 * A policy document is attacker-reachable and evaluated SYNCHRONOUSLY on the
 * credential path.
 *
 * `policy` / `policy_shadow` are read on every proxied call and handed to
 * `evaluateAgentPolicy` before the provider key is resolved. Nothing about that
 * path is asynchronous, so no `try`/`catch` and no timeout around it can rescue
 * a document that is simply expensive to evaluate — the event loop is held.
 * Two shapes made it expensive:
 *
 *   1. an embedded-wildcard glob (`a*a*a*…b`), which the old matcher translated
 *      into a backtracking regular expression — exponential in the length of the
 *      MODEL, which the caller supplies;
 *   2. an unbounded collection — rule and model counts were capped only by the
 *      dashboard form, and a server action is addressable over HTTP by its id,
 *      so the form is not a boundary.
 *
 * Both are refused by the shared parser here, which is the same boundary the
 * write-side validator asks (`validatePolicy` → `policyIsWellFormed`). Refusing
 * in the parser rather than only in the form is the point: the parser is what
 * the gateway itself runs.
 */

const MONDAY_MORNING = new Date("2026-07-27T10:00:00.000Z");

/** The reviewer's exact repro: 15 embedded wildcards, then a character the
 *  model never contains, so every alternative has to be explored. */
const CATASTROPHIC_PATTERN = `${"a*".repeat(15)}b`;
const CATASTROPHIC_MODEL = "a".repeat(28);

function denyPolicy(models: string[]): unknown {
  return { deny: [{ provider: "openai", models }] };
}

describe("policy documents that would stall the proxy", () => {
  it("refuses a deny pattern built out of embedded wildcards", () => {
    // A real model glob has one or two wildcards. Fifteen is not a policy, it is
    // a payload, and the cost of evaluating it lands on live traffic.
    expect(policyIsWellFormed(denyPolicy([CATASTROPHIC_PATTERN]))).toBe(false);
  });

  it("still accepts the wildcard shapes an operator actually writes", () => {
    for (const pattern of ["*", "gpt-4*", "*-preview", "claude-3-*-sonnet*", "gpt-4o"]) {
      expect(policyIsWellFormed(denyPolicy([pattern]))).toBe(true);
    }
  });

  it("refuses a rule carrying an unbounded model list", () => {
    // Reachable without the dashboard: the server action takes the document as
    // an argument, and `policy_shadow` is writable by SQL besides.
    expect(policyIsWellFormed(denyPolicy(Array.from({ length: 10_000 }, (_, i) => `m${i}*`)))).toBe(
      false
    );
  });

  it("refuses an unbounded number of deny rules", () => {
    const deny = Array.from({ length: 5_000 }, () => ({ provider: "openai", models: ["gpt-4*"] }));
    expect(policyIsWellFormed({ deny })).toBe(false);
  });

  it("refuses patterns spread thinly across many rules", () => {
    // The per-rule cap alone is not the bound — 200 rules of 5 patterns is the
    // same amount of per-request work as one rule of 1000.
    const deny = Array.from({ length: 200 }, () => ({
      provider: "openai",
      models: ["a*", "b*", "c*", "d*", "e*"],
    }));
    expect(policyIsWellFormed({ deny })).toBe(false);
  });

  it("refuses an unbounded day list inside one window", () => {
    // The subtler half of the same problem, and the more expensive one: the day
    // list is walked by `.every()` at parse, COPIED by the spread that builds the
    // window, and walked again by `includes` when the window is evaluated — all
    // on every proxied request. There are seven days; the rest is padding.
    const days = Array.from({ length: 50_000 }, () => "mon");
    expect(
      policyIsWellFormed({ windows: [{ days, start: "09:00", end: "18:00", tz: "UTC" }] })
    ).toBe(false);
    // A window naming every day is still a window.
    expect(
      policyIsWellFormed({
        windows: [
          { days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], start: "09:00", end: "18:00", tz: "UTC" },
        ],
      })
    ).toBe(true);
  });

  it("refuses an unbounded number of windows", () => {
    const windows = Array.from({ length: 5_000 }, () => ({
      days: ["mon"],
      start: "09:00",
      end: "18:00",
      tz: "UTC",
    }));
    expect(policyIsWellFormed({ windows })).toBe(false);
  });

  it("evaluates the catastrophic document without stalling, and fails closed", () => {
    // Secondary guard only — the assertions above are the real bound. The
    // ceiling is deliberately generous; the point is that it cannot be seconds.
    const started = Date.now();
    const decision = evaluateAgentPolicy(
      denyPolicy([CATASTROPHIC_PATTERN]),
      "openai",
      CATASTROPHIC_MODEL,
      MONDAY_MORNING
    );
    expect(Date.now() - started).toBeLessThan(250);
    // A document the gateway cannot read is malformed, which denies. Refusing it
    // at the form is what stops an operator ever getting here.
    expect(decision).toEqual({ allowed: false, reason: "malformed", rule: "policy:malformed" });
  });
});

/**
 * The bound the whole fix rests on, asserted as work rather than as elapsed time.
 *
 * A wall-clock assertion in CI is a coin toss on a busy runner, and it also
 * measures the wrong thing: what matters is that no input can make the matcher
 * do more than a fixed number of steps, whatever the machine.
 *
 * Every input to the ceiling is IMPORTED, never typed here. The length bound is
 * as much a part of the product as the pattern count is — a test that hardcoded
 * 200 would keep passing if someone raised the length limit twenty-fold, which
 * is exactly the regression this file exists to catch.
 */
const MODEL_BOUND = POLICY_LIMITS.modelLen;

describe("the work a single match can be made to do", () => {
  const model = "a".repeat(MODEL_BOUND);

  /** Deterministic adversarial search over max-length patterns. */
  function worstCaseSteps(iterations: number): { steps: number; pattern: string } {
    let seed = 0x2545f491;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    let worst = { steps: 0, pattern: "" };
    // Shapes known to be bad for a greedy matcher, then a random sweep.
    const seeded = [
      `a*${"a".repeat(MODEL_BOUND - 3)}b`,
      `${"*a".repeat(4)}${"a".repeat(MODEL_BOUND - 9)}b`,
      `*a*a*a*${"a".repeat(100)}b`,
      `${"a".repeat(MODEL_BOUND - 1)}*`,
    ];
    for (const pattern of seeded) {
      const { steps } = globMatchWork(pattern, model);
      if (steps > worst.steps) worst = { steps, pattern };
    }
    for (let i = 0; i < iterations; i++) {
      let pattern = "";
      let stars = 0;
      const length = 1 + rnd(MODEL_BOUND);
      for (let c = 0; c < length; c++) {
        const roll = rnd(12);
        if (roll === 0 && stars < 4) {
          pattern += "*";
          stars++;
        } else {
          pattern += roll < 7 ? "a" : "b";
        }
      }
      const { steps } = globMatchWork(pattern, model);
      if (steps > worst.steps) worst = { steps, pattern };
    }
    return worst;
  }

  it("never exceeds (model + 1) x (pattern + 1) steps, however adversarial", () => {
    const ceiling = (MODEL_BOUND + 1) * (MODEL_BOUND + 1);
    const worst = worstCaseSteps(20_000);
    expect(worst.steps).toBeGreaterThan(0);
    expect(worst.steps, `worst pattern: ${JSON.stringify(worst.pattern.slice(0, 40))}…`).toBeLessThanOrEqual(
      ceiling
    );
  });

  it("bounds the whole document, not just one pattern", () => {
    // THE assertion. Per-pattern cost times the most patterns the parser will
    // accept is what one request can be made to cost, and the two limits are
    // only safe together — raising either one fails here. Read from the exported
    // constant so the test cannot drift from the parser.
    const perPattern = (POLICY_LIMITS.modelLen + 1) * (POLICY_LIMITS.patternLen + 1);
    expect(perPattern * POLICY_LIMITS.denyPatterns).toBeLessThan(5_000_000);
    // …and the per-rule cap must not be a way around the total.
    expect(POLICY_LIMITS.denyPatterns).toBeLessThanOrEqual(
      POLICY_LIMITS.denyRules * POLICY_LIMITS.modelsPerRule
    );
  });

  it("stays bounded when the policy is as large as the parser permits", () => {
    // Build the worst document that PASSES: full pattern budget, each pattern
    // the nastiest shape found above, and a model that matches none of them so
    // every one is evaluated to exhaustion.
    const nasty = worstCaseSteps(2_000).pattern;
    const perRule = Math.min(POLICY_LIMITS.modelsPerRule, POLICY_LIMITS.denyPatterns);
    const rules = Math.ceil(POLICY_LIMITS.denyPatterns / perRule);
    const deny = Array.from({ length: rules }, () => ({
      provider: "openai",
      models: Array.from({ length: perRule }, () => nasty),
    }));
    expect(policyIsWellFormed({ deny })).toBe(true);

    const total = deny.reduce(
      (sum, rule) =>
        sum + rule.models.reduce((inner, pattern) => inner + globMatchWork(pattern, model).steps, 0),
      0
    );
    expect(total).toBeLessThan(5_000_000);

    const started = Date.now();
    expect(evaluateAgentPolicy({ deny }, "openai", model, MONDAY_MORNING)).toEqual({
      allowed: true,
      maxRequestsPerHour: null,
    });
    expect(Date.now() - started).toBeLessThan(250);
  });
});
