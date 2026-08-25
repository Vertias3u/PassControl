import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPARTURE_VERDICT,
  departureCounts,
  departureDestination,
  groupDepartures,
  groupKey,
  groupSpan,
  groupUpstreamStatus,
  repeatBurstTitle,
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
  // The two `departureTime` cases that used to open this block went with the
  // function: it had no callers left once the tooltip stopped pinning its own
  // zone. Times on the board come from `useDashboardTime` now, and the
  // hydration property they guarded is that provider's (it renders UTC until it
  // has mounted and read the stored preference).
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
    //
    // Both sides go through groupKey(), never `row.id`: the representative is
    // the NEWEST member, so a burst keyed on it loses its expansion the moment
    // another call of the same kind arrives. See the groupKey suite below.
    const board = readFileSync(join(process.cwd(), "components/DeparturesBoard.tsx"), "utf8");
    expect(board).toMatch(/toggleGroup\(groupKey\(group\)\)/);
    expect(board).toMatch(/expanded\.has\(groupKey\(group\)\)/);
    expect(board).toMatch(/group\.members\.map/);
    expect(board).not.toMatch(/toggleGroup\(row\.id\)/);
  });
});

// ── The provider's status code, on the board line ────────────────────────────
//
// DIVERTED covered a 401, a 404 and a 429 alike, so an expired provider key and
// a wrong model id were the same word. The code has always been on the receipt.
// The catch is grouping: a burst folds on agent+status+provider+model, which does
// NOT include the upstream code, so one line can stand for rows that failed for
// different reasons. Labelling that line with the newest member's code would put
// a number on the board that is wrong for the rows behind it.
describe("recorded provider status for a board line", () => {
  const jws = (http: unknown) => {
    const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${seg({ alg: "EdDSA" })}.${seg({ res: { status: "upstream_error", http } })}.c2ln`;
  };
  const at = (s: number, http: unknown) =>
    row({
      id: `r${s}`,
      created_at: new Date(Date.UTC(2026, 7, 17, 3, 6, s)).toISOString(),
      status: "upstream_error",
      model: "",
      receipt: jws(http),
    });

  it("reports the code when a single row records one", () => {
    expect(groupUpstreamStatus(groupDepartures([at(30, 401)])[0]!)).toBe(401);
  });

  it("reports the code when every member of a burst agrees", () => {
    const [group] = groupDepartures([at(30, 401), at(29, 401), at(28, 401)]);
    expect(group!.count).toBe(3);
    expect(groupUpstreamStatus(group!)).toBe(401);
  });

  it("stays silent when the members disagree, rather than labelling the burst wrong", () => {
    const [group] = groupDepartures([at(30, 401), at(29, 429)]);
    expect(group!.count).toBe(2);
    expect(groupUpstreamStatus(group!)).toBeNull();
  });

  it("stays silent when any member records nothing readable", () => {
    // A partial answer across a burst is a guess about the rows it cannot read.
    expect(groupUpstreamStatus(groupDepartures([at(30, 401), at(29, "401")])[0]!)).toBeNull();
    expect(groupUpstreamStatus(groupDepartures([at(30, 401), at(29, undefined)])[0]!)).toBeNull();
  });

  it("reports nothing for a row with no receipt at all", () => {
    expect(groupUpstreamStatus({ row: row({ id: "x" }), count: 1, members: [row({ id: "x" })] }))
      .toBeNull();
  });
});

// ── The ×N badge's tooltip ───────────────────────────────────────────────────
//
// Two things were wrong with it in production on 2026-08-17. It formatted its
// own times in hardcoded UTC while the board's TIME column obeyed the UTC/LOCAL
// toggle, so a board reading `05:44:14 EEST` carried a tooltip reading
// `02:44:14 UTC` for the same row. And a burst whose members share a second
// rendered "between 02:44:14 and 02:44:14" — a span with no width, which reads
// like a bug even though the grouping was right.
describe("repeatBurstTitle", () => {
  // Stands in for `useDashboardTime().format(value, "time")`, which already
  // appends the zone name — that is why the caller no longer adds one.
  const fmt = (value: string) => `${value.slice(11, 19)} EEST`;

  it("follows the caller's formatter rather than choosing a zone itself", () => {
    const title = repeatBurstTitle(3, {
      from: "2026-08-01T09:07:03.000Z",
      to: "2026-08-01T09:08:41.000Z",
    }, fmt);
    expect(title).toContain("between 09:07:03 EEST and 09:08:41 EEST");
    // The old copy hardcoded a trailing " UTC" next to a formatted local time.
    expect(title).not.toMatch(/EEST UTC/);
  });

  it("states one instant when the burst has no width", () => {
    const title = repeatBurstTitle(2, {
      from: "2026-08-01T09:07:03.000Z",
      to: "2026-08-01T09:07:03.000Z",
    }, fmt);
    expect(title).toContain("at 09:07:03 EEST");
    expect(title).not.toContain("between");
  });

  it("says nothing about time when the rows carry none", () => {
    // Rows with no timestamp never fold into a burst, but a group can still
    // report a null span — claiming a time we do not have would be worse.
    const title = repeatBurstTitle(2, null, fmt);
    expect(title).toBe("2 identical consecutive refusals, all stored. Click to show them.");
  });

  it("always says every row is kept", () => {
    // The badge hides rows. The one thing it must never imply is that they were
    // dropped — the counters and the CSV export still count rows, not groups.
    for (const span of [null, { from: "2026-08-01T09:07:03.000Z", to: "2026-08-01T09:08:41.000Z" }]) {
      expect(repeatBurstTitle(4, span, fmt)).toMatch(/every one is stored|all stored/);
    }
  });
});

describe("groupKey", () => {
  // An operator clicks ×7 to expand a burst of refusals and starts reading. The
  // client is still live, another refusal of the same kind lands within the
  // burst window, and it becomes the group's representative — because rows
  // arrive newest first and groupDepartures takes the first row it sees. Keyed
  // on that row, the expansion lookup misses and the burst silently re-collapses
  // under the cursor. The key has to name the BURST, not its newest member.
  const burst = (ids: string[]) =>
    ids.map((id, index) =>
      row({
        id,
        status: "denied_scope",
        // Newest first, one second apart, well inside the burst window.
        created_at: new Date(Date.parse("2026-08-01T09:07:03.000Z") - index * 1000).toISOString(),
      })
    );

  it("survives a newer member joining the burst", () => {
    const before = groupDepartures(burst(["c", "b", "a"]));
    expect(before).toHaveLength(1);
    const after = groupDepartures(burst(["d", "c", "b", "a"]));
    expect(after).toHaveLength(1);
    expect(groupKey(after[0]!)).toBe(groupKey(before[0]!));
  });

  it("is not the representative row, which is what moved", () => {
    const after = groupDepartures(burst(["d", "c", "b", "a"]));
    expect(after[0]!.row.id).toBe("d");
    expect(groupKey(after[0]!)).not.toBe("d");
  });

  it("still distinguishes two separate groups", () => {
    const groups = groupDepartures([
      ...burst(["c", "b", "a"]),
      row({ id: "z", status: "denied_scope", created_at: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groupKey(groups[0]!)).not.toBe(groupKey(groups[1]!));
  });

  it("names an ordinary single row by that row", () => {
    const groups = groupDepartures([row({ id: "solo" })]);
    expect(groupKey(groups[0]!)).toBe("solo");
  });
});
