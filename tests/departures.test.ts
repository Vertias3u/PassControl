import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPARTURE_VERDICT,
  departureTime,
  fare,
  flightCode,
  mergeDeparture,
  totalTokens,
  verdictFor,
  type DepartureRow,
} from "@/lib/departures";

function row(overrides: Partial<DepartureRow> = {}): DepartureRow {
  return {
    id: "row-1",
    created_at: "2026-08-01T09:07:03.000Z",
    passport_id: "kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8",
    jti: "9d8f6159-83a8-4dab-b37b-d54acff63593",
    provider: "openai",
    model: "gpt-4.1",
    input_tokens: 9,
    output_tokens: 40,
    cost_microcents: 49_000_000,
    status: "ok",
    ...overrides,
  };
}

describe("verdict vocabulary", () => {
  it("gives every audit status its own word", () => {
    const words = Object.values(DEPARTURE_VERDICT).map((v) => v.word);
    expect(new Set(words).size).toBe(words.length);
  });

  it("separates our budget refusing a call from the provider's account being empty", () => {
    // Both are about money and both come back as a 402, but the fix is opposite:
    // one is a limit the operator set here, the other is a balance to top up at
    // the provider. An operator who reads them as one word raises the wrong dial.
    expect(verdictFor("blocked_budget").word).toBe("NO FUNDS");
    expect(verdictFor("provider_exhausted").word).toBe("NO CREDIT");
  });

  it("separates a kill switch from an agent suspend — they answer the wire alike", () => {
    // The proxy deliberately returns one opaque code for both. The audit row is
    // where they diverge, and the board is where an operator reads that.
    expect(verdictFor("blocked_killed").word).toBe("KILL SWITCH");
    expect(verdictFor("blocked_suspended").word).toBe("SUSPENDED");
  });

  it("does not label a policy block as a provider error", () => {
    // Regression: blocked_policy shipped without a label and fell through to the
    // upstream-error default across the Control Tower.
    expect(verdictFor("blocked_policy").word).toBe("POLICY");
    expect(verdictFor("blocked_policy").tone).toBe("held");
  });

  it("shows an unknown status as itself rather than guessing", () => {
    expect(verdictFor("blocked_something_new").word).toBe("BLOCKED_SOMETHING_NEW");
    expect(verdictFor(null).word).toBe("UNKNOWN");
  });

  it("reserves the loudest tone for the controls an operator armed", () => {
    expect(DEPARTURE_VERDICT.blocked_killed.tone).toBe("denied");
    expect(DEPARTURE_VERDICT.blocked_suspended.tone).toBe("denied");
    expect(DEPARTURE_VERDICT.ok.tone).toBe("clear");
  });
});

describe("row rendering", () => {
  it("renders time in UTC so the server and client agree", () => {
    // A locale-dependent format would differ across the hydration boundary.
    expect(departureTime("2026-08-01T09:07:03.000Z")).toBe("09:07:03");
  });

  it("survives a missing or unparseable timestamp", () => {
    expect(departureTime(null)).toBe("--:--:--");
    expect(departureTime("whenever")).toBe("--:--:--");
  });

  it("builds a stable flight code from the provider and visa id", () => {
    expect(flightCode(row())).toBe("OP 9D8F");
  });

  it("still renders a flight code when the realtime row has nulls", () => {
    expect(flightCode({ provider: null, jti: null })).toBe("?? ----");
  });

  it("uses the stored credential-use id for a direct-key call with no visa jti", () => {
    expect(
      flightCode({
        provider: "openai",
        jti: null,
        credential_use_id: "ab12cd34-0000-4000-8000-000000000001",
      })
    ).toBe("OP AB12");
  });

  it("shows a dash rather than $0.0000 for an unmetered call", () => {
    expect(fare(null)).toBe("—");
    expect(fare(0)).toBe("—");
    expect(fare(49_000_000)).toBe("$0.4900");
  });

  it("totals tokens across nullable columns", () => {
    expect(totalTokens(row())).toBe(49);
    expect(totalTokens({ input_tokens: null, output_tokens: null })).toBe(0);
  });
});

describe("merging live arrivals", () => {
  it("puts the newest departure on top", () => {
    const merged = mergeDeparture([row()], row({ id: "row-2" }), 40);
    expect(merged.map((r) => r.id)).toEqual(["row-2", "row-1"]);
  });

  it("ignores a row already on the board", () => {
    // Realtime can redeliver; a duplicated key would break React and double the
    // counters above the table.
    const merged = mergeDeparture([row()], row(), 40);
    expect(merged.map((r) => r.id)).toEqual(["row-1"]);
  });

  it("caps the board so a busy fleet cannot grow it without bound", () => {
    const existing = Array.from({ length: 40 }, (_, i) => row({ id: `row-${i}` }));
    const merged = mergeDeparture(existing, row({ id: "newest" }), 40);
    expect(merged).toHaveLength(40);
    expect(merged[0]!.id).toBe("newest");
  });
});

describe("the board reads the data the Control Tower already fetched", () => {
  it("adds no second query for logs", () => {
    // A parallel query is how the board and the audit log start disagreeing.
    const page = readFileSync(join(process.cwd(), "app/dashboard/page.tsx"), "utf8");
    expect(page).toMatch(/<DeparturesBoard[^>]*initialRows=\{displayLogs\}/);
    expect(page.match(/from\("agent_logs"\)/g) ?? []).toHaveLength(1);
  });
});
