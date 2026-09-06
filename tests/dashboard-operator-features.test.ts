import { describe, expect, it } from "vitest";
import {
  BUDGET_ATTENTION_RATIO,
  budgetRiskRatio,
  buildFleetAttention,
  withLastSeenFromLogs,
  type AttentionAgent,
  type AttentionLog,
} from "@/lib/dashboard-attention";
import { describeStoredShadow } from "@/components/dashboard/CallDetailDrawer";
import { agentCommandsForQuery } from "@/components/dashboard/DashboardCommandPalette";

const NOW = new Date("2026-08-08T12:00:00.000Z");

function agent(overrides: Partial<AttentionAgent> = {}): AttentionAgent {
  return {
    id: "agent-1",
    name: "Reconciler",
    status: "active",
    budget_tokens: 1_000,
    budget_cents: 100,
    spent_tokens: 800,
    spent_microcents: 10_000_000,
    expires_at: null,
    ...overrides,
  };
}

function log(overrides: Partial<AttentionLog> = {}): AttentionLog {
  return {
    agent_id: "agent-1",
    created_at: "2026-08-08T11:00:00.000Z",
    status: "ok",
    input_tokens: 50,
    output_tokens: 50,
    cost_microcents: 1_000_000,
    ...overrides,
  };
}

describe("operator-priority dashboard read models", () => {
  it("uses the shared 80% reconciled-agent threshold", () => {
    expect(BUDGET_ATTENTION_RATIO).toBe(0.8);
    expect(budgetRiskRatio(agent())).toBe(0.8);
    expect(buildFleetAttention([agent()], [], NOW)[0]?.reasons.some((reason) => reason.kind === "budget")).toBe(true);
  });

  it("derives refusal, last-seen and projected exhaustion from the same log rows", () => {
    const rows = [
      log({ status: "blocked_policy", created_at: "2026-08-08T11:00:00.000Z" }),
      log({ created_at: "2026-08-07T12:00:00.000Z", input_tokens: 100, output_tokens: 100 }),
    ];
    const item = buildFleetAttention([agent({ spent_tokens: 700 })], rows, NOW)[0];
    expect(item?.recentRefusals).toBe(1);
    expect(item?.lastSeenAt).toBe("2026-08-08T11:00:00.000Z");
    expect(item?.projectedExhaustionAt).not.toBeNull();
  });

  it("uses the stamped column when the agent's calls fall outside the scan", () => {
    // The mirror image of the 2026-08-17 bug below, and it survived the fix.
    // The attention scan is bounded (ATTENTION_SCAN_DAYS / ATTENTION_SCAN_LIMIT
    // in app/dashboard/page.tsx), so a busy tenant's older calls are simply not
    // in `logs`. The fleet table still renders a time, because it resolves
    // through withLastSeenFromLogs against the column. Reading the scan alone
    // here puts "No recent activity" beside a real timestamp in one viewport --
    // the same contradiction, pointing the other way.
    const item = buildFleetAttention(
      [agent({ last_seen_at: "2026-08-08T09:00:00.000Z" })],
      [],
      NOW
    )[0];
    expect(item?.lastSeenAt).toBe("2026-08-08T09:00:00.000Z");
  });

  it("still prefers a call newer than the stamp", () => {
    const item = buildFleetAttention(
      [agent({ last_seen_at: "2026-08-08T09:00:00.000Z" })],
      [log({ created_at: "2026-08-08T11:00:00.000Z" })],
      NOW
    )[0];
    expect(item?.lastSeenAt).toBe("2026-08-08T11:00:00.000Z");
  });

  it("prefers a stamp newer than the newest call", () => {
    // The column legitimately LEADS: a passport stamps it at the challenge,
    // before any call is recorded. This is the branch withLastSeenFromLogs
    // documents, and the queue has to agree with it or the two disagree again.
    const item = buildFleetAttention(
      [agent({ last_seen_at: "2026-08-08T11:30:00.000Z" })],
      [log({ created_at: "2026-08-08T11:00:00.000Z" })],
      NOW
    )[0];
    expect(item?.lastSeenAt).toBe("2026-08-08T11:30:00.000Z");
  });

  it("keeps 'never' honest in the queue too", () => {
    const item = buildFleetAttention([agent({ last_seen_at: null })], [], NOW)[0];
    expect(item?.lastSeenAt).toBeNull();
  });

  it("does not pad an entirely healthy queue", () => {
    const healthy = agent({ budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0 });
    expect(buildFleetAttention([healthy], [log()], NOW)).toEqual([]);
  });

  it("flags an active passport agent that has no expiry", () => {
    const immortal = agent({
      budget_tokens: null,
      budget_cents: null,
      spent_tokens: 0,
      spent_microcents: 0,
      passport_pubkey: "passport-public-key",
      expires_at: null,
    });

    expect(buildFleetAttention([immortal], [log()], NOW)[0]?.reasons).toContainEqual({
      kind: "no_expiry",
      label: "Set a passport expiry",
      detail: "Choose an expiry on the agent page to give this passport a rotation deadline.",
      tone: "neutral",
    });
  });

  it("does not treat a Direct Agent Key's optional expiry as passport hygiene", () => {
    const directKey = agent({
      budget_tokens: null,
      budget_cents: null,
      spent_tokens: 0,
      spent_microcents: 0,
      passport_pubkey: null,
      expires_at: null,
    });

    expect(buildFleetAttention([directKey], [log()], NOW)).toEqual([]);
  });

  it("does not flag an immortal passport after it is revoked or while it is suspended", () => {
    const credential = {
      budget_tokens: null,
      budget_cents: null,
      spent_tokens: 0,
      spent_microcents: 0,
      passport_pubkey: "passport-public-key",
      expires_at: null,
    };
    const revoked = agent({ ...credential, status: "revoked" });
    const suspended = agent({ ...credential, status: "suspended" });

    expect(buildFleetAttention([revoked], [log()], NOW)).toEqual([]);
    expect(
      buildFleetAttention([suspended], [log()], NOW)[0]?.reasons.some(
        (reason) => reason.kind === "no_expiry"
      )
    ).toBe(false);
  });

  it("does not flag a passport that has any expiry", () => {
    const expiringEventually = agent({
      budget_tokens: null,
      budget_cents: null,
      spent_tokens: 0,
      spent_microcents: 0,
      passport_pubkey: "passport-public-key",
      expires_at: "2027-08-08T12:00:00.000Z",
    });

    expect(buildFleetAttention([expiringEventually], [log()], NOW)).toEqual([]);
  });

  it("keeps a real expiry warning ahead of no-expiry hygiene", () => {
    const shared = {
      budget_tokens: null,
      budget_cents: null,
      spent_tokens: 0,
      spent_microcents: 0,
      passport_pubkey: "passport-public-key",
    };
    const immortal = agent({ ...shared, id: "immortal", name: "Immortal", expires_at: null });
    const expiring = agent({
      ...shared,
      id: "expiring",
      name: "Expiring",
      expires_at: "2026-08-11T12:00:00.000Z",
    });
    const rows = [log({ agent_id: "immortal" }), log({ agent_id: "expiring" })];

    const items = buildFleetAttention([immortal, expiring], rows, NOW);
    expect(items.map((item) => item.agentId)).toEqual(["expiring", "immortal"]);
    expect(items[0]?.score).toBeGreaterThan(items[1]?.score ?? 0);
  });

  it("never presents missing or stale shadow stamps as allow", () => {
    expect(describeStoredShadow(null, "rev-2").state).toBe("not-evaluated");
    expect(describeStoredShadow("allow", "rev-2").state).toBe("not-evaluated");
    expect(describeStoredShadow("allow@rev-1", "rev-2")).toMatchObject({
      state: "stale",
      detail: "Evaluated against a draft that is no longer current.",
    });
    expect(describeStoredShadow("allow@rev-2", "rev-2").state).toBe("allow");
  });

  it("finds an agent by passport suffix and emits identity, policy, and activity targets", () => {
    const commands = agentCommandsForQuery(
      [{ id: "agent-9", name: "Collector", passport_pubkey: "PCPUBKEY-0123456789abcdef" }],
      "89abcdef"
    );
    expect(commands.map((command) => command.href)).toEqual([
      "/dashboard/agents/agent-9#agent-identity",
      "/dashboard/agents/agent-9#agent-policy",
      "/dashboard/agents/agent-9#agent-activity",
    ]);
  });

  // ── One last-seen, not two ─────────────────────────────────────────────────
  //
  // The operator queue derived last-seen from the log scan while the fleet table
  // read `agents.last_seen_at`, and the two disagreed inside one viewport: on
  // production 2026-08-17 the queue said "16 Aug, 06:42" for an agent whose
  // fleet row said "never". The column is written only by the nightly reconcile
  // flush, and — until the direct-key stamp landed in the proxy — was never
  // written at all for a Direct Agent Key agent.
  //
  // Both readers now go through this one function, so they cannot drift again.
  describe("withLastSeenFromLogs", () => {
    it("fills a column the reconcile flush has not written yet", () => {
      const [merged] = withLastSeenFromLogs(
        [{ ...agent(), last_seen_at: null }],
        [log({ created_at: "2026-08-08T11:00:00.000Z" })]
      );
      expect(merged?.last_seen_at).toBe("2026-08-08T11:00:00.000Z");
    });

    it("takes whichever evidence is newer, never a step backwards", () => {
      // The column can lead: it is stamped when a passport authenticates, which
      // happens before any call is recorded. Neither source is authoritative on
      // its own, and "seen" is satisfied by either.
      const older = withLastSeenFromLogs(
        [{ ...agent(), last_seen_at: "2026-08-08T09:00:00.000Z" }],
        [log({ created_at: "2026-08-08T11:00:00.000Z" })]
      );
      expect(older[0]?.last_seen_at).toBe("2026-08-08T11:00:00.000Z");

      const newer = withLastSeenFromLogs(
        [{ ...agent(), last_seen_at: "2026-08-08T11:30:00.000Z" }],
        [log({ created_at: "2026-08-08T11:00:00.000Z" })]
      );
      expect(newer[0]?.last_seen_at).toBe("2026-08-08T11:30:00.000Z");
    });

    it("keeps 'never' honest when there is no evidence at all", () => {
      // An agent that has genuinely never called must still read never — the
      // fallback may only ever ADD evidence, never invent it.
      const [merged] = withLastSeenFromLogs([{ ...agent(), last_seen_at: null }], []);
      expect(merged?.last_seen_at).toBe(null);
    });

    it("ignores rows belonging to another agent, and unusable timestamps", () => {
      const [merged] = withLastSeenFromLogs(
        [{ ...agent(), id: "agent-1", last_seen_at: null }],
        [
          log({ agent_id: "agent-2", created_at: "2026-08-08T11:00:00.000Z" }),
          log({ agent_id: "agent-1", created_at: null }),
          log({ agent_id: null, created_at: "2026-08-08T11:00:00.000Z" }),
          log({ agent_id: "agent-1", created_at: "not a date" }),
        ]
      );
      expect(merged?.last_seen_at).toBe(null);
    });

    it("is the same evidence the operator queue reports", () => {
      // The point of the shared function: one number, two readers.
      const agents = [{ ...agent(), status: "suspended", last_seen_at: null }];
      const logs = [log({ created_at: "2026-08-08T11:00:00.000Z" })];
      expect(withLastSeenFromLogs(agents, logs)[0]?.last_seen_at).toBe(
        buildFleetAttention(agents, logs, NOW)[0]?.lastSeenAt
      );
    });
  });
});
