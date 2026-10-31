import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/dashboard/actions-client", () => ({
  updateAgentBudgets: vi.fn(), updateAgentScopes: vi.fn(), setAgentSuspended: vi.fn(),
  issueDirectAgentKey: vi.fn(), revokeDirectAgentKey: vi.fn(),
}));
vi.mock("@/app/dashboard/agents/[id]/passport-actions", () => ({
  rotateAgentPassport: vi.fn(), setAgentPassportExpiry: vi.fn(),
}));
vi.mock("@/app/dashboard/agents/[id]/delegation-actions", () => ({
  revokeAllDelegationsAction: vi.fn(), revokeDelegationAction: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useActionState: (_action: unknown, initial: unknown) => [initial, () => {}, false],
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-dom")>(),
  useFormStatus: () => ({ pending: false }),
}));
vi.mock("@/app/dashboard/agents/[id]/injection-actions", () => ({ clearInjectionTaint: vi.fn() }));
vi.mock("@/app/dashboard/approvals/actions", () => ({ decideApprovalAction: vi.fn() }));
vi.mock("@/app/dashboard/agents/[id]/break-glass-actions", () => ({ takeBreakGlass: vi.fn(), endBreakGlass: vi.fn() }));

import { BreakGlassPanel } from "@/components/BreakGlassPanel";

const originalZone = process.env.TZ;
afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
  vi.restoreAllMocks();
});

function identicalAcrossZones(render: () => string) {
  process.env.TZ = "UTC";
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-30T12:30:00Z"));
  const utc = render();
  process.env.TZ = "Asia/Tokyo";
  // Hydration is a later render as well as a different zone.
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-30T12:31:01Z"));
  expect(render()).toBe(utc);
  return utc;
}

it("break glass countdown has identical UTC/Tokyo first markup across a minute boundary", () => {
  identicalAcrossZones(() => renderToStaticMarkup(<BreakGlassPanel agentId="agent" status="active" visaTtlSeconds={300} grant={{
    id: "grant", createdAt: "2026-10-30T12:30:00Z", scopes: [{ provider: "openai", models: ["gpt-5"] }], reason: "Investigating", expiresAt: "2026-10-30T12:45:00Z",
  }} />));
});

// These use the real clock hook. No effects run during either initial render.
it("fleet relative activity has identical markup across the hydration delay", async () => {
  const { AgentFleetTable } = await import("@/components/AgentFleetTable");
  identicalAcrossZones(() => renderToStaticMarkup(<AgentFleetTable agentsAvailable logsAvailable visaTtlSeconds={300} agents={[{
    id: "agent", name: "Scout", passport_pubkey: null, status: "active", budget_tokens: null, budget_cents: null,
    spent_tokens: 0, spent_microcents: 0, last_seen_at: "2026-10-30T12:29:30Z", allowed_scopes: [],
  }]} />));
});

it("installation key status has identical markup across its expiry boundary", async () => {
  const { DirectAgentKeyPanel } = await import("@/components/DirectAgentKeyPanel");
  identicalAcrossZones(() => renderToStaticMarkup(<DirectAgentKeyPanel agentId="agent" agentName="Scout" status="active" keys={[{
    id: "key", name: "Worker", suffix: "abcd", createdAt: "2026-10-30T12:00:00Z", expiresAt: "2026-10-30T12:30:30Z",
    revokedAt: null, lastUsedAt: null, recordedCalls: 1234,
  }]} />));
});

it("passport expiry and grace have identical markup across their deadline", async () => {
  const { PassportLifecycle } = await import("@/components/PassportLifecycle");
  identicalAcrossZones(() => renderToStaticMarkup(<PassportLifecycle agentId="agent" status="active"
    expiresAt="2026-10-30T12:30:30Z" previousPassportId="old" previousValidUntil="2026-10-30T12:30:30Z"
    currentPassportId="current" visaTtlSeconds={300} />));
});

it("setup key availability has identical markup across its expiry boundary", async () => {
  const { AgentSetupPanel } = await import("@/components/AgentSetupPanel");
  const html = identicalAcrossZones(() => renderToStaticMarkup(<AgentSetupPanel agentId="agent" agentName="Scout" status="active"
    scopes={[{ provider: "openai", models: ["gpt-5-mini"] }]}
    keys={[{ id: "key", name: "Worker", suffix: "abcd", expiresAt: "2026-10-30T12:30:30Z", revokedAt: null }]} />));
  expect(html).toContain("Checking installation key expiry");
});

it("worker expiry has identical markup across its deadline", async () => {
  const { WorkersPanel } = await import("@/components/WorkersPanel");
  const html = identicalAcrossZones(() => renderToStaticMarkup(<WorkersPanel agentId="agent" delegations={[{
    jti: "worker", depth: 1, parent_jti: null, worker_key: "worker-public-key", cap_microcents: 1000000,
    scope: [], issued_at: "2026-10-30T12:00:00Z", expires_at: "2026-10-30T12:30:30Z",
    first_exchanged_at: "2026-10-30T12:00:01Z", revoked: false,
  }]} />));
  expect(html).toContain("Checking expiry");
});

it("a waiting approval's age has identical markup across the hydration delay", async () => {
  // A mismatch here leaves Approve and Deny dead until React rebuilds the panel.
  const { ApprovalsPanel } = await import("@/components/ApprovalsPanel");
  identicalAcrossZones(() => renderToStaticMarkup(<ApprovalsPanel items={[{
    id: "approval", agentId: "agent", agentName: "Scout", serviceLabel: "GitHub", method: "POST", path: "/repos",
    preview: "{}", createdAt: Date.parse("2026-10-30T12:25:31Z"), onTelegram: false, hold: null,
  }]} />));
});

it("the closed connect dialog has identical markup across UTC midnight", async () => {
  const { DirectAgentConnect } = await import("@/components/DirectAgentConnect");
  vi.useFakeTimers();
  try {
    process.env.TZ = "UTC";
    vi.setSystemTime(new Date("2026-10-30T23:59:59Z"));
    const utc = renderToStaticMarkup(<DirectAgentConnect />);
    process.env.TZ = "Asia/Tokyo";
    vi.setSystemTime(new Date("2026-10-31T00:00:01Z"));
    expect(renderToStaticMarkup(<DirectAgentConnect />)).toBe(utc);
  } finally {
    vi.useRealTimers();
  }
});

