import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPARTURE_VERDICT,
  departureCounts,
  departureDestination,
  groupDepartures,
  groupSpan,
  departureTime,
  fare,
  flightCode,
  mergeDeparture,
  totalTokens,
  verdictFor,
  visibleDepartures,
  type DepartureRow,
} from "@/lib/departures";
import { isHousekeeping } from "@/lib/call-class";

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

  it("still hands the board every row, including housekeeping", () => {
    // The classification is a VIEW. If the page ever starts passing a filtered
    // list, the board's "show probes" toggle becomes a lie — the rows would not
    // be there to show. Preserve everything; filter at the point of display.
    const page = readFileSync(join(process.cwd(), "app/dashboard/page.tsx"), "utf8");
    expect(page).not.toMatch(/initialRows=\{(inferenceLogs|housekeepingLogs)\}/);
  });
});

describe("housekeeping rows on the board", () => {
  const probe = () => row({ id: "probe-1", model: "", status: "ok", input_tokens: 0, output_tokens: 0, cost_microcents: 0 });

  it("names a capability probe instead of showing a blank destination", () => {
    // Before this, a model-listing row rendered as provider + nothing, read as
    // a normal CLEARED call with a missing model — the exact confusion between
    // protocol chatter and agent activity this is meant to end.
    expect(departureDestination(probe())).toBe("Capability probe");
    expect(departureDestination(row())).toBe("gpt-4.1");
  });

  it("leaves a refused probe described by its refusal", () => {
    // A kill switch stopping a startup probe is agent activity of the most
    // important kind. It keeps its normal destination and stays visible.
    const refused = row({ id: "probe-2", model: "", status: "blocked_killed" });
    expect(isHousekeeping(refused)).toBe(false);
    expect(departureDestination(refused)).toBe("—");
  });

  it("counts cleared against agent calls, not handshakes", () => {
    const counts = departureCounts([row(), probe(), row({ id: "r2", status: "blocked_scope" })]);
    expect(counts).toEqual({ cleared: 1, refused: 1, housekeeping: 1 });
  });

  it("hides housekeeping by default and restores it on request", () => {
    const rows = [row(), probe()];
    expect(visibleDepartures(rows, { filter: "all", query: "", showHousekeeping: false }).map((r) => r.id))
      .toEqual(["row-1"]);
    expect(visibleDepartures(rows, { filter: "all", query: "", showHousekeeping: true }).map((r) => r.id))
      .toEqual(["row-1", "probe-1"]);
  });

  it("does not let the outcome filter resurrect a hidden probe", () => {
    // "Cleared" is an outcome, not a class. A probe is cleared, so an unguarded
    // filter would put it straight back on a board the operator just cleaned.
    expect(visibleDepartures([probe()], { filter: "cleared", query: "", showHousekeeping: false }))
      .toHaveLength(0);
  });

  it("still matches a shown probe against the search box", () => {
    expect(visibleDepartures([probe()], { filter: "all", query: "openai", showHousekeeping: true }))
      .toHaveLength(1);
    expect(visibleDepartures([probe()], { filter: "all", query: "gpt-4.1", showHousekeeping: true }))
      .toHaveLength(0);
  });
});

// ── Collapsing repeat bursts ─────────────────────────────────────────────────
//
// A client that pings the same unrouted path before, during and after every
// prompt writes one refused row per ping. They are all true, and twenty of them
// say exactly what one of them says. The board groups consecutive identical
// refusals; the record keeps every row, and the counters above the table still
// count rows, not groups.
describe("repeat-burst grouping", () => {
  const at = (s: number, over: Partial<DepartureRow> = {}) =>
    row({
      id: `r${s}`,
      created_at: new Date(Date.UTC(2026, 7, 16, 12, 0, s)).toISOString(),
      status: "blocked_endpoint",
      model: "",
      ...over,
    });

  it("collapses consecutive identical refusals into one row with a count", () => {
    const groups = groupDepartures([at(30), at(29), at(28)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(3);
    // The newest row represents the burst, so the timestamp is the latest one.
    expect(groups[0]!.row.id).toBe("r30");
  });

  it("never collapses a successful call", () => {
    // Two cleared calls are two pieces of real work and two real charges. Only a
    // refusal can be a repeat of nothing.
    const groups = groupDepartures([at(30, { status: "ok", model: "gpt-4.1" }), at(29, { status: "ok", model: "gpt-4.1" })]);
    expect(groups).toHaveLength(2);
  });

  it("keeps refusals of different kinds apart", () => {
    // A scope refusal next to an endpoint refusal are two different problems.
    const groups = groupDepartures([at(30), at(29, { status: "blocked_scope" })]);
    expect(groups).toHaveLength(2);
  });

  it("keeps different agents apart", () => {
    const groups = groupDepartures([at(30, { agent_id: "a" }), at(29, { agent_id: "b" })]);
    expect(groups).toHaveLength(2);
  });

  it("keeps different models apart", () => {
    const groups = groupDepartures([
      at(30, { status: "blocked_scope", model: "claude-haiku-4.5" }),
      at(29, { status: "blocked_scope", model: "gpt-4.1" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("does not reach across a gap in time", () => {
    // Two bursts an hour apart are two events. Collapsing them would tell the
    // operator a story about frequency that the rows do not support.
    const groups = groupDepartures([at(30), at(29), at(29 - 3600)]);
    expect(groups.map((g) => g.count)).toEqual([2, 1]);
  });

  it("does not group rows whose time is unknown", () => {
    // A null timestamp cannot be shown to be part of a burst, so it stands alone
    // rather than being folded in on an assumption.
    const groups = groupDepartures([at(30, { created_at: null }), at(29, { created_at: null })]);
    expect(groups).toHaveLength(2);
  });

  it("is interrupted by an unrelated row between two identical ones", () => {
    // Only CONSECUTIVE rows group: a cleared call in between means the client
    // recovered and failed again, which is a different shape from a burst.
    const groups = groupDepartures([at(30), at(29, { status: "ok", model: "gpt-4.1" }), at(28)]);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1]);
  });

  it("carries every original row on the group for the board to expand", () => {
    // The board draws one line and the ×N badge expands it back into these —
    // see "wires the count badge to expand the burst" below, which checks the
    // UI actually reaches them. The CSV export is a separate, ungrouped surface.
    const groups = groupDepartures([at(30), at(29)]);
    expect(groups[0]!.members.map((m) => m.id)).toEqual(["r30", "r29"]);
  });

  it("leaves the counters counting rows, not groups", () => {
    // "3 refused" must stay 3 when the board draws one line for them.
    expect(departureCounts([at(30), at(29), at(28)]).refused).toBe(3);
  });
});

describe("a collapsed burst is honest about time and reachable", () => {
  const at = (s: number) =>
    row({
      id: `s${s}`,
      created_at: new Date(Date.UTC(2026, 7, 16, 12, 0, s)).toISOString(),
      status: "blocked_endpoint",
      model: "",
    });

  it("reports the span a burst covers, not a single instant", () => {
    // The window chains member-to-member, so a steady pinger can fold a long
    // stretch onto one line. Drawing that at the newest timestamp alone would
    // imply twenty things happened at once.
    const [group] = groupDepartures([at(100), at(60), at(20)]);
    expect(groupSpan(group!)).toEqual({
      from: "2026-08-16T12:00:20.000Z",
      to: "2026-08-16T12:01:40.000Z",
    });
  });

  it("offers no span for a single row", () => {
    expect(groupSpan(groupDepartures([at(10)])[0]!)).toBeNull();
  });

  it("wires the count badge to expand the burst back into its rows", () => {
    // The grouping only stays honest if the ×N is a way IN to the rows. A test
    // asserting `members` exists while nothing in the UI can reach them would
    // guard a feature that does not exist.
    const board = readFileSync(join(process.cwd(), "components/DeparturesBoard.tsx"), "utf8");
    expect(board).toMatch(/toggleGroup\(row\.id\)/);
    expect(board).toMatch(/expanded\.has\(group\.row\.id\)/);
    expect(board).toMatch(/group\.members\.map/);
  });
});
