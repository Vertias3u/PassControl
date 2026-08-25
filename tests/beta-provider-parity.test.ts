// The beta signup provider list exists in THREE independent places, and until
// this test nothing compared them:
//
//   1. `BETA_PROVIDERS` in lib/beta-launch.ts   — validates the submission
//   2. the `beta_applications_provider` CHECK    — enforces it in the database
//   3. the <option> list in BetaApplicationForm  — what a human can actually pick
//
// Every pairing fails differently, and none of them fails loudly:
//   1 without 2 → the app accepts the value and Postgres rejects the insert, so
//                 the applicant gets a 500 on a form they filled in correctly.
//   2 without 1 → the database would allow it and the validator refuses first.
//   3 missing   → the option is simply not offered and nobody finds out.
//
// This is the same class of bug as tests/cli-provider-parity.test.ts. The SQL
// and the TSX are read as text because neither can be imported here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BETA_PROVIDERS, BETA_PROVIDER_LABELS } from "../lib/beta-providers";

const repo = process.cwd();

/** Every provider the CHECK constraint admits, from the migration that last
 *  rewrote it. Reading the newest definition is the point: an older migration
 *  still contains the narrower list it originally shipped. */
function constraintProviders(): string[] {
  const sql = readFileSync(
    join(repo, "db/migrations/0039_beta_applications_gemini.sql"),
    "utf8"
  );
  const match = /beta_applications_provider\s+check\s*\(\s*provider in \(([^)]*)\)/iu.exec(sql);
  if (!match) throw new Error("the provider CHECK is no longer declared where this test looks");
  return [...match[1]!.matchAll(/'([a-z0-9-]+)'/gu)].map((m) => m[1]!);
}

/** The form used to hand-type its <option> list, which is how it fell behind.
 *  It now maps over BETA_PROVIDERS, so the drift it could suffer is no longer
 *  "a missing option" but "someone hardcodes the list again". That is what this
 *  pins: the select must be derived, not literal. */
function providerSelectSource(): string {
  const tsx = readFileSync(join(repo, "components/BetaApplicationForm.tsx"), "utf8");
  const select = /name="provider"[\s\S]*?<\/select>/u.exec(tsx);
  if (!select) throw new Error("the provider <select> is no longer where this test looks");
  return select[0];
}

describe("the beta signup provider list", () => {
  it("finds both list declarations", () => {
    expect(BETA_PROVIDERS.length).toBeGreaterThan(0);
    expect(constraintProviders().length).toBeGreaterThan(0);
  });

  it("has a database CHECK that admits exactly what the validator admits", () => {
    // The pairing that produces a 500 on a correctly filled form if it drifts.
    expect(constraintProviders().sort()).toEqual([...BETA_PROVIDERS].sort());
  });

  it("has a label for every provider, so none renders blank", () => {
    for (const provider of BETA_PROVIDERS) {
      expect(BETA_PROVIDER_LABELS[provider]?.trim()).toBeTruthy();
    }
  });

  it("renders the form's options from BETA_PROVIDERS instead of hardcoding them", () => {
    const select = providerSelectSource();
    expect(select).toContain("BETA_PROVIDERS");
    expect(select).toContain("BETA_PROVIDER_LABELS");
    // No literal option values: a hardcoded list is exactly the regression.
    expect(select).not.toMatch(/<option value="[a-z]/u);
  });

  it("keeps 'Not decided' first, since it is the default selection", () => {
    expect(providerSelectSource()).toContain('defaultValue="undecided"');
    expect(providerSelectSource()).toContain('"undecided"');
  });

  it("includes gemini, now that the gateway supports it", () => {
    expect(BETA_PROVIDERS).toContain("gemini");
    expect(constraintProviders()).toContain("gemini");
    expect(BETA_PROVIDER_LABELS.gemini).toBe("Google Gemini");
  });
});
