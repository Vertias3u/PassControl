// The operator queue has three tiers now, and every surface that reads it has
// to say which one it is looking at.
//
// The queue was built as a fault list: everything in it was, by construction,
// something wrong. `no_expiry` broke that — an agent with no passport expiry is
// not faulty, it is unconfigured — and the two surfaces above the builder still
// generalised from the old rule. The headline card went red for any non-zero
// count, and every row that was not `danger` was labelled `warning`.
//
// These tests pin the derivation rather than the prose, because the prose is
// exactly what drifted: the card's subtitle used to name "revoked", a status
// `buildFleetAttention` skips outright, so it advertised a state that could
// never appear beneath it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  attentionItemTone,
  buildFleetAttention,
  summariseFleetAttention,
  type AttentionAgent,
  type AttentionLog,
} from "@/lib/dashboard-attention";
import { FleetAttentionQueue } from "@/components/dashboard/FleetAttentionQueue";
import { FleetOverviewCards } from "@/components/FleetOverviewCards";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const RECENT = "2026-09-02T11:00:00.000Z";

function agent(overrides: Partial<AttentionAgent> = {}): AttentionAgent {
  return {
    id: "agent-1",
    name: "Reconciler",
    status: "active",
    budget_tokens: null,
    budget_cents: null,
    spent_tokens: 0,
    spent_microcents: 0,
    passport_pubkey: "pk_1",
    expires_at: "2027-01-01T00:00:00.000Z",
    last_seen_at: RECENT,
    ...overrides,
  };
}

const logs: AttentionLog[] = [];

/** An agent whose only queue entry is the missing-expiry nudge. */
const hygieneOnly = () => buildFleetAttention([agent({ expires_at: null })], logs, NOW);

describe("item tone is the worst reason, not the absence of danger", () => {
  it("is neutral when every reason is housekeeping", () => {
    const [item] = hygieneOnly();
    expect(item?.reasons.map((r) => r.kind)).toEqual(["no_expiry"]);
    expect(attentionItemTone(item!)).toBe("neutral");
  });

  it("is warning when a real warning is present", () => {
    const items = buildFleetAttention(
      [agent({ expires_at: "2026-09-10T00:00:00.000Z" })],
      logs,
      NOW
    );
    expect(attentionItemTone(items[0]!)).toBe("warning");
  });

  it("is danger when any one reason is danger, whatever else it carries", () => {
    // An expired passport (danger) beside no recent activity (neutral). A
    // suspended agent cannot be used here: `no_expiry` is gated on an ACTIVE
    // status, so suspension never coexists with the housekeeping tier.
    const items = buildFleetAttention(
      [agent({ expires_at: "2026-08-01T00:00:00.000Z", last_seen_at: null })],
      logs,
      NOW
    );
    expect(items[0]!.reasons.map((r) => r.tone)).toContain("neutral");
    expect(attentionItemTone(items[0]!)).toBe("danger");
  });
});

describe("the queue renders the tier it was given", () => {
  it("marks a housekeeping-only row neutral, not warning", () => {
    const html = renderToStaticMarkup(<FleetAttentionQueue items={hygieneOnly()} />);
    expect(html).toContain('data-tone="neutral"');
    // The old derivation had no neutral at all, so this is the assertion that
    // would have failed before: every row was danger or warning.
    expect(html).not.toContain('data-tone="warning"');
  });

  it("still marks a suspended row danger", () => {
    const items = buildFleetAttention([agent({ status: "suspended" })], logs, NOW);
    const html = renderToStaticMarkup(<FleetAttentionQueue items={items} />);
    expect(html).toContain('data-tone="danger"');
  });
});

describe("the headline card describes what is actually in the queue", () => {
  it("says nothing is wrong when the queue holds only housekeeping", () => {
    const summary = summariseFleetAttention(hygieneOnly());
    expect(summary.count).toBe(1);
    expect(summary.tone).toBe("neutral");
    expect(summary.note).toBe("Missing expiries");
  });

  it("goes danger only when a danger reason exists", () => {
    const items = buildFleetAttention(
      [agent({ id: "a", name: "A", expires_at: null }), agent({ id: "b", name: "B", status: "suspended" })],
      logs,
      NOW
    );
    expect(summariseFleetAttention(items).tone).toBe("danger");
  });

  it("names the kinds present, worst first, and never a kind that is absent", () => {
    const items = buildFleetAttention(
      [agent({ id: "a", name: "A", expires_at: null }), agent({ id: "b", name: "B", status: "suspended" })],
      logs,
      NOW
    );
    expect(summariseFleetAttention(items).note).toBe("Suspensions, missing expiries");
  });

  it("never advertises revoked, which the builder skips", () => {
    const items = buildFleetAttention(
      [agent({ id: "a", name: "A", status: "revoked" }), agent({ id: "b", name: "B", expires_at: null })],
      logs,
      NOW
    );
    expect(items.map((i) => i.agentId)).toEqual(["b"]);
    expect(summariseFleetAttention(items).note.toLowerCase()).not.toContain("revoked");
  });

  it("caps the line at two nouns and counts the rest", () => {
    // Four kinds at once: suspended, an expired passport, refusals and silence.
    // The cap is a measured one — three nouns plus the tail wraps the card's
    // footer onto a second line and makes it taller than its neighbours.
    const items = buildFleetAttention(
      [
        agent({ id: "a", name: "A", status: "suspended" }),
        agent({ id: "b", name: "B", expires_at: "2026-08-01T00:00:00.000Z", last_seen_at: null }),
        agent({ id: "c", name: "C", budget_cents: 100, spent_microcents: 99_000_000 }),
      ],
      logs,
      NOW
    );
    expect(summariseFleetAttention(items).note).toBe(
      "Suspensions, passport deadlines +2 more"
    );
  });

  it("falls back to the empty note with an empty queue", () => {
    expect(summariseFleetAttention([])).toEqual({
      count: 0,
      tone: "neutral",
      note: "No agent alerts",
    });
  });

  it("renders the derived tone and note rather than deriving from the count", () => {
    const html = renderToStaticMarkup(
      <FleetOverviewCards
        activeAgents={1}
        totalAgents={1}
        spentMicrocents={0}
        blockedCalls={0}
        recentCalls={0}
        attention={summariseFleetAttention(hygieneOnly())}
      />
    );
    expect(html).toContain("Missing expiries");
    expect(html).toContain("pc-metric-card--neutral");
    // One item in the queue, and the card is not red about it.
    expect(html).not.toContain("pc-metric-card--danger");
  });
});
