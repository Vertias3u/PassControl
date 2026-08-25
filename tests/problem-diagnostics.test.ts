/**
 * The artifact builder — the function that decides which workspace data becomes
 * durable in a table an operator later opens.
 *
 * Its correctness rests on something a passing render would not reveal: the
 * column lists it SELECTs must match what summarizeAgent and summarizeFailures
 * actually read. A silent mismatch produces a hollow artifact that still looks
 * complete — every key present, every value null — which is worse than an
 * absent one, because an operator would read it as evidence.
 *
 * So this feeds rows carrying the things that must never survive (a receipt, a
 * prompt, a credential hash, a raw passport key) and asserts on the serialized
 * output, the house style from tests/system-health.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCloudBetaQuotaSnapshot: vi.fn(),
  readKillState: vi.fn(),
  loadInstanceSigner: vi.fn(),
  instanceIssuer: vi.fn(),
  isSentryConfigured: vi.fn(),
  getCachedMigrationHealth: vi.fn(),
}));

vi.mock("@/lib/cloud-beta-quota", () => ({ readCloudBetaQuotaSnapshot: mocks.readCloudBetaQuotaSnapshot }));
vi.mock("@/lib/state/killswitch", () => ({ readKillState: mocks.readKillState }));
vi.mock("@/lib/crypto/instanceKey", () => ({
  loadInstanceSigner: mocks.loadInstanceSigner,
  instanceIssuer: mocks.instanceIssuer,
}));
vi.mock("@/lib/observability", () => ({ isSentryConfigured: mocks.isSentryConfigured }));
vi.mock("@/lib/system-health/cache", () => ({ getCachedMigrationHealth: mocks.getCachedMigrationHealth }));

import {
  buildProblemDiagnostics,
  readInstanceStamp,
  withinDiagnosticSizeLimit,
  DIAGNOSTIC_SCAN_LIMIT,
} from "@/lib/problem-diagnostics";

/**
 * Every one of these is a field that must not reach the artifact. They are on
 * the rows because a real `select("*")` would return them — the point is that
 * the builder constructs from an allowlist and therefore ignores them.
 */
const AGENT_ROW = {
  id: "agent-1",
  name: "research-agent",
  status: "active",
  passport_pubkey: "MCowBQYDK2VwAyEA0011223344556677889900aabbccddeeff",
  allowed_scopes: [{ provider: "anthropic", models: ["claude-*"] }],
  policy: { deny: ["rm"], windows: [], max_requests_per_hour: 10 },
  budget_tokens: 1000,
  spent_tokens: 12,
  created_at: "2026-08-01T00:00:00.000Z",
  last_seen_at: null,
  // Never selected, never summarized — present to prove both.
  vault_secret_id: "00000000-0000-0000-0000-00000000dead",
  api_key_hash: "sha256:should-never-appear",
  totp_secret: "JBSWY3DPEHPK3PXP",
};

const LOG_ROW = {
  id: "log-1",
  agent_id: "agent-1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  status: "blocked_budget",
  created_at: "2026-08-24T09:00:00.000Z",
  receipt: { sig: "a-signed-receipt-blob" },
  prompt: "the user's actual private prompt text",
  response: "the model's actual response text",
  authorization: "Bearer sk-ant-api03-NeverInAnArtifact",
};

function db(agents: unknown[], logs: unknown[]) {
  const selects: string[] = [];
  return {
    selects,
    from(table: string) {
      const b: Record<string, unknown> = {
        select(cols: string, opts?: unknown) {
          selects.push(`${table}:${cols}`);
          if (opts) return Promise.resolve({ count: 2, error: null });
          return b;
        },
        order: () => b,
        gte: () => b,
        limit: () => Promise.resolve({ data: table === "agents" ? agents : logs, error: null }),
      };
      return b;
    },
  };
}

const USER = { id: "user-1" } as never;
const NOW = new Date("2026-08-24T12:00:00.000Z");

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.readCloudBetaQuotaSnapshot.mockResolvedValue({ state: "ok", used: 1, limit: 100 });
  mocks.readKillState.mockResolvedValue({ userKill: false, platformKill: false });
  mocks.loadInstanceSigner.mockReturnValue({});
  mocks.instanceIssuer.mockReturnValue("https://passcontrol.vertias.eu");
  mocks.isSentryConfigured.mockReturnValue(false);
  mocks.getCachedMigrationHealth.mockResolvedValue({
    state: "current",
    applied_head: "0038_problem_reports.sql",
  });
});

describe("buildProblemDiagnostics", () => {
  it("carries none of the fields that must never become durable", async () => {
    const client = db([AGENT_ROW], [LOG_ROW]);
    const artifact = await buildProblemDiagnostics(client as never, USER, NOW);
    const text = JSON.stringify(artifact);

    for (const secret of [
      "should-never-appear",
      "JBSWY3DPEHPK3PXP",
      "00000000-0000-0000-0000-00000000dead",
      "a-signed-receipt-blob",
      "the user's actual private prompt text",
      "the model's actual response text",
      "sk-ant-api03-NeverInAnArtifact",
    ]) {
      expect(text).not.toContain(secret);
    }
    // The raw passport key is never emitted; summarizeAgent keeps a suffix.
    expect(text).not.toContain(AGENT_ROW.passport_pubkey);

    // The blanket sweep, minus the bundle's own safety notice — which reads
    // "No prompts, receipts, provider keys, or raw credentials" and would
    // otherwise trip a check on the word "prompt" forever.
    //
    // `receipt` is deliberately NOT in this alternation: `receipt_signing` is a
    // legitimate configuration-signal key. The receipt BLOB is covered by the
    // exact-string assertion above, which is the stronger check anyway.
    const withoutNotice = JSON.stringify({
      ...artifact,
      bundle: { ...artifact.bundle, notice: "" },
    });
    expect(withoutNotice).not.toMatch(/prompt|api[_-]?key|secret|totp|authorization|bearer/i);
  });

  /**
   * The mismatch this file exists to catch: a hollow artifact with every key
   * present and every value empty reads as "nothing was wrong".
   */
  it("actually summarizes the rows rather than returning an empty shell", async () => {
    const client = db([AGENT_ROW], [LOG_ROW]);
    const artifact = await buildProblemDiagnostics(client as never, USER, NOW);
    expect(artifact.bundle.agents).toHaveLength(1);
    expect(artifact.bundle.agents[0]!.name).toBe("research-agent");
    expect(artifact.bundle.agents[0]!.passport.attached).toBe(true);
    expect(artifact.bundle.agents[0]!.passport.public_key_suffix).toBe(AGENT_ROW.passport_pubkey.slice(-8));
    expect(artifact.bundle.agents[0]!.policy.deny_rule_count).toBe(1);
    expect(artifact.bundle.recent_failures).toHaveLength(1);
    expect(artifact.bundle.recent_failures[0]!.code).toBe("blocked_budget");
  });

  it("selects the columns the summarizers read, and not a wildcard", async () => {
    const client = db([AGENT_ROW], [LOG_ROW]);
    await buildProblemDiagnostics(client as never, USER, NOW);
    const agentSelect = client.selects.find((s) => s.startsWith("agents:"))!;
    // A `select("*")` would be safe by construction but would fetch columns
    // this file's whole claim says it never touches.
    expect(agentSelect).not.toContain("*");
    for (const column of ["passport_pubkey", "policy", "budget_tokens", "last_seen_at"]) {
      expect(agentSelect).toContain(column);
    }
    const logSelect = client.selects.find((s) => s.startsWith("agent_logs:"))!;
    expect(logSelect).toContain("status");
    expect(logSelect).not.toContain("receipt");
  });

  /**
   * buildCloudSupportBundle records neither its window nor its row counts, so
   * two artifacts taken over different spans compare falsely. An operator
   * reading "1 failure" needs to know whether that was all of them.
   */
  it("records the window it was built over, and whether it hit the cap", async () => {
    const client = db([AGENT_ROW], [LOG_ROW]);
    const artifact = await buildProblemDiagnostics(client as never, USER, NOW);
    expect(artifact.scan.until).toBe(NOW.toISOString());
    expect(new Date(artifact.scan.since).getTime()).toBeLessThan(NOW.getTime());
    expect(artifact.scan.log_rows).toBe(1);
    expect(artifact.scan.truncated).toBe(false);

    const full = db([AGENT_ROW], Array.from({ length: DIAGNOSTIC_SCAN_LIMIT }, () => LOG_ROW));
    const capped = await buildProblemDiagnostics(full as never, USER, NOW);
    expect(capped.scan.truncated).toBe(true);
  });

  it("pins the artifact's top-level shape, so a new field is a decision", async () => {
    const client = db([AGENT_ROW], [LOG_ROW]);
    const artifact = await buildProblemDiagnostics(client as never, USER, NOW);
    expect(Object.keys(artifact)).toEqual(["artifact_version", "source", "scan", "bundle"]);
  });
});

describe("readInstanceStamp", () => {
  it("reports the build and the schema head", async () => {
    const stamp = await readInstanceStamp();
    expect(stamp.schema_head).toBe("0038_problem_reports.sql");
    expect(stamp.schema_state).toBe("current");
    expect(stamp.app_version).toBeTruthy();
  });

  /** A collector that timed out must never be the reason a report is refused. */
  it("degrades to nulls when the migration collector fails", async () => {
    mocks.getCachedMigrationHealth.mockRejectedValue(new Error("timeout"));
    const stamp = await readInstanceStamp();
    expect(stamp.schema_head).toBeNull();
    expect(stamp.schema_state).toBeNull();
    // The half that did not depend on it still reports.
    expect(stamp.app_version).toBeTruthy();
  });
});

describe("withinDiagnosticSizeLimit", () => {
  it("admits an ordinary artifact and refuses one past the column's ceiling", async () => {
    const client = db([AGENT_ROW], [LOG_ROW]);
    const artifact = await buildProblemDiagnostics(client as never, USER, NOW);
    expect(withinDiagnosticSizeLimit(artifact)).toBe(true);

    const huge = { ...artifact, bundle: { ...artifact.bundle, notice: "x".repeat(300_000) } };
    expect(withinDiagnosticSizeLimit(huge as never)).toBe(false);
  });
});
