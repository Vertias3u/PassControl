// Call classification: operationally meaningful model calls vs SDK housekeeping.
//
// The rule is DERIVED, never stored, so these tests are the whole specification
// of it. Two properties matter more than any individual case:
//
//   1. A refused call is NEVER housekeeping. A refusal is the product working,
//      and hiding one behind a "chatter" filter is the failure mode this whole
//      feature could plausibly introduce.
//   2. The classification is presentation-only. Nothing in the check order
//      (kill/scope/budget/receipt) may consult it — see the invariant test at
//      the bottom, which greps for exactly that.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCall, isHousekeeping, isInference, CALL_CLASS_REASONS } from "@/lib/call-class";
import type { LogEntry } from "@/lib/log";

const root = join(__dirname, "..");

describe("classifyCall", () => {
  it("calls a successful model-listing probe housekeeping, and names why", () => {
    // What GET /v1/models writes: the proxy's `model` is "" because the body
    // carries none, and the scope step is skipped for listings (lib/gate.ts).
    const c = classifyCall({ status: "ok", model: "" });
    expect(c.klass).toBe("housekeeping");
    expect(c.reason).toBe("model_listing");
  });

  it("treats a null model the same as an empty one", () => {
    // Rows written before the proxy always supplied a string, and any row whose
    // model column is simply absent. Same fact, two spellings.
    expect(classifyCall({ status: "ok", model: null }).klass).toBe("housekeeping");
  });

  it("does not let whitespace disguise a model-less call", () => {
    expect(classifyCall({ status: "ok", model: "   " }).klass).toBe("housekeeping");
  });

  it("calls a successful chat completion inference", () => {
    const c = classifyCall({ status: "ok", model: "claude-sonnet-4-20250514" });
    expect(c.klass).toBe("inference");
    expect(c.reason).toBeNull();
  });

  it("counts the demo provider's calls as inference", () => {
    // The demo path stamps "demo-1" precisely so it is never model-less.
    expect(classifyCall({ status: "ok", model: "demo-1" }).klass).toBe("inference");
  });

  // ── The property that protects the audit surface ──────────────────────────
  const NON_OK: LogEntry["status"][] = [
    "blocked_budget",
    "blocked_endpoint",
    "blocked_killed",
    "blocked_suspended",
    "blocked_scope",
    "blocked_policy",
    "provider_exhausted",
    "no_provider_key",
    "upstream_error",
  ];

  it.each(NON_OK)("never classifies %s as housekeeping, even model-less", (status) => {
    // A kill switch refusing a startup capability probe is the single most
    // operationally meaningful row this product can write. It must not vanish.
    expect(classifyCall({ status, model: "" }).klass).toBe("inference");
    expect(classifyCall({ status, model: null }).klass).toBe("inference");
  });

  it("treats an ABSENT model column as unclassifiable, not as a probe", () => {
    // The realtime path in DeparturesBoard casts `payload.new as DepartureRow`
    // with no normalization — the file says so itself. A WAL payload that does
    // not carry `model` at all is a row we cannot judge, and the board hides
    // housekeeping by default, so guessing "probe" would silently hide a real
    // inference call. Absent and empty are different facts; only empty is a
    // probe. This is the one case where collapsing them breaks the rule that
    // this classifier always fails toward visible.
    expect(classifyCall({ status: "ok" } as unknown as { status: string; model: null }).klass)
      .toBe("inference");
    // An explicitly empty or null model is still a probe: the key is there, the
    // value is the fact.
    expect(classifyCall({ status: "ok", model: undefined }).klass).toBe("housekeeping");
    expect(classifyCall({ status: "ok", model: null }).klass).toBe("housekeeping");
  });

  it("classifies an unrecognised status as inference", () => {
    // Fail toward meaningful: a status this build has never heard of is not
    // something we may quietly file as chatter.
    expect(classifyCall({ status: "some_future_status", model: null }).klass).toBe("inference");
  });

  it("exposes exactly the reasons it can produce", () => {
    expect(CALL_CLASS_REASONS).toEqual(["model_listing"]);
  });

  it("has helpers that agree with classifyCall", () => {
    const probe = { status: "ok", model: "" };
    const real = { status: "ok", model: "gpt-4o-mini" };
    expect(isHousekeeping(probe)).toBe(true);
    expect(isInference(probe)).toBe(false);
    expect(isHousekeeping(real)).toBe(false);
    expect(isInference(real)).toBe(true);
  });
});

describe("the classification stays out of the check order", () => {
  // If a "housekeeping" label could reach the budget reserve, scope, the kill
  // switch, or the receipt payload, it would stop being presentation and become
  // a bypass primitive: relabel a call, skip the atomic Lua reserve. This test
  // is the guard, because that regression would otherwise look like a tidy-up.
  const ENFORCEMENT_FILES = [
    "app/api/v1/[provider]/[...path]/route.ts",
    "lib/gate.ts",
    "lib/scope.ts",
    "lib/state/redis.ts",
    "lib/state/killswitch.ts",
    "lib/receipt.ts",
    "lib/auth/visa.ts",
  ];

  it.each(ENFORCEMENT_FILES)("%s does not import lib/call-class", (file) => {
    const src = readFileSync(join(root, file), "utf8");
    expect(src).not.toMatch(/call-class/);
  });
});

describe("the derivation's standing assumption", () => {
  it("every model-free allowlisted endpoint is a models endpoint, and vice versa", () => {
    // THE load-bearing assumption, asserted as a property rather than a count so
    // it survives the allowlist growing but still fails the moment a *new kind*
    // of endpoint appears.
    //
    // `status === "ok" && !model` isolates model-metadata rows only while every
    // other admitted endpoint is model-bound. Adding, say, POST
    // /v1/messages/count_tokens would write model-less "ok" rows too and quietly
    // widen "housekeeping" to cover it — which might even be right, but must be
    // a decision. An unrecognised path here is that decision point.
    //
    // Recorded decision (2026-08-16): `GET /v1/models/{id}` — the single-model
    // retrieve — was admitted, and it IS housekeeping. It runs no inference and
    // returns strictly less than the listing already allowed, so it belongs to
    // the same class. Driven by a real agent whose context-length probe hit it
    // around every prompt and filled the board with blocked_endpoint refusals.
    const src = readFileSync(join(root, "lib/scope.ts"), "utf8");
    const block = src.slice(
      src.indexOf("const ENDPOINT_ALLOWLIST"),
      src.indexOf("function pathEquals")
    );

    const MODEL_BOUND = new Set([
      "OPENAI_CHAT_PATH",
      "ANTHROPIC_MESSAGES_PATH",
      "DEEPSEEK_CHAT_PATH",
      '["chat", "completions"]',
    ]);
    // Recorded decision (2026-08-25): `VERSIONLESS_MODELS_PATH` (= ["models"])
    // arrived with the gemini provider, whose OpenAI-compat base already carries
    // `/v1beta/openai` and so serves the listing unversioned. It is the same
    // model-metadata listing as OPENAI_MODELS_PATH with the version segment in
    // the base instead of the path — it runs no inference and bills nothing, so
    // it is housekeeping, exactly like the two spellings already here.
    const MODEL_FREE = new Set([
      "OPENAI_MODELS_PATH",
      "VERSIONLESS_MODELS_PATH",
      '["models"]',
    ]);

    const rules = [...block.matchAll(/method:\s*"([A-Z]+)",\s*path:\s*(\[[^\]]*\]|\w+)/g)];
    expect(rules.length).toBeGreaterThan(0);

    for (const [, method, path] of rules) {
      const known = MODEL_BOUND.has(path!) || MODEL_FREE.has(path!);
      // An unrecognised path means a new endpoint shape reached the allowlist
      // without anyone deciding which side of the classification it falls on.
      expect(known, `unrecognised allowlist path ${path} — decide its call class`).toBe(true);
      // Model-free endpoints are GET-only, and every GET is model-free. A POST
      // that carried no model would be admitted work that logs as housekeeping.
      expect(MODEL_FREE.has(path!), `${method} ${path}`).toBe(method === "GET");
    }
  });
});
