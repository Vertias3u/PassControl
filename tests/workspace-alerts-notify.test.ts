// notifyWorkspace runs inside the gateway's waitUntil after a refusal, so a
// looping agent can call it thousands of times. What it may cost, in order:
//   1. nothing at all for a status that never alerts;
//   2. ONE Redis command for an alertable refusal already alerted on (or for a
//      workspace with no alerts, after the first);
//   3. database and Vault reads only for the one call per 10 minutes that
//      would actually send.
// And it never throws: an alert is never allowed to cost the audit row.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake, and split so secret scanners do not block a push over it.
const SLACK = "https://hooks.slack.com/services/" + "T0123ABCD/B0456EFGH/abcdEFGH1234ijklMNOP5678";

const mocks = vi.hoisted(() => {
  const state = {
    slotFree: true,
    slotThrows: false,
    config: { destination: "slack", events: ["refused", "budget", "security"] } as Record<string, unknown> | null,
    configError: null as null | { code?: string; message: string },
    url: "" as string | null,
    agentName: "summarizer",
  };
  const fromCalls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    if (name !== "get_workspace_alert_url_for_user") throw new Error(`unexpected rpc ${name}`);
    return { data: state.url, error: null };
  });
  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () =>
        table === "workspace_alerts"
          ? { data: state.config, error: state.configError }
          : { data: { name: state.agentName }, error: null },
    };
    return q;
  });
  return {
    state,
    fromCalls,
    rpc,
    from,
    claimAlertSlot: vi.fn(async () => {
      if (state.slotThrows) throw new Error("redis down");
      return state.slotFree;
    }),
  };
});

vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/state/redis", () => ({ claimAlertSlot: mocks.claimAlertSlot }));

import { alertForGatewayStatus, notifyWorkspace } from "@/lib/alerts/workspace";

const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));

const refused = {
  userId: "tenant-a",
  agentId: "agent-1",
  type: "refused" as const,
  status: "blocked_scope",
  model: "gpt-5",
  origin: "https://passcontrol.example",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fromCalls.length = 0;
  Object.assign(mocks.state, {
    slotFree: true,
    slotThrows: false,
    config: { destination: "slack", events: ["refused", "budget", "security"] },
    configError: null,
    url: SLACK,
    agentName: "summarizer",
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("alertForGatewayStatus", () => {
  it("alerts on refusals and on running out of budget", () => {
    expect(alertForGatewayStatus("blocked_scope")).toBe("refused");
    expect(alertForGatewayStatus("blocked_endpoint")).toBe("refused");
    expect(alertForGatewayStatus("blocked_policy")).toBe("refused");
    expect(alertForGatewayStatus("blocked_budget")).toBe("budget");
    expect(alertForGatewayStatus("blocked_budget_period")).toBe("budget");
  });

  it.each(["ok", "blocked_budget_state", "blocked_suspended", "blocked_killed", "blocked_unpriced_model", "upstream_error"])(
    "never alerts on %s",
    (status) => {
      // blocked_budget_state is a Redis fault, not an empty budget; a stopped
      // agent retrying is self-inflicted and would only spam.
      expect(alertForGatewayStatus(status)).toBeNull();
    }
  );
});

describe("notifyWorkspace", () => {
  it("sends one message to the stored destination, never following a redirect", async () => {
    await notifyWorkspace(refused);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SLACK);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body.text).toContain("`summarizer`");
    expect(body.text).toContain("https://passcontrol.example/dashboard/agents/agent-1");
    expect(mocks.claimAlertSlot).toHaveBeenCalledWith("tenant-a", "refused", "agent-1");
  });

  it("costs one Redis command and no database read once this alert was sent", async () => {
    mocks.state.slotFree = false;
    await notifyWorkspace(refused);
    expect(mocks.claimAlertSlot).toHaveBeenCalledOnce();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads no secret for a workspace without alerts", async () => {
    mocks.state.config = null;
    await notifyWorkspace(refused);
    expect(mocks.fromCalls).toEqual(["workspace_alerts"]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads no secret when that kind is switched off", async () => {
    mocks.state.config = { destination: "slack", events: ["budget"] };
    await notifyWorkspace(refused);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends security events under the security kind", async () => {
    mocks.state.config = { destination: "slack", events: ["security"] };
    await notifyWorkspace({ userId: "tenant-a", agentId: "agent-1", type: "passport_rotated", origin: "https://passcontrol.example" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("re-checks the stored URL and sends nothing to one that no longer passes", async () => {
    mocks.state.url = "https://evil.example/services/T0/B0/x";
    await notifyWorkspace(refused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when the stored URL's service disagrees with the row", async () => {
    mocks.state.config = { destination: "discord", events: ["refused"] };
    await notifyWorkspace(refused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a missing table (before 0078) as no alerts", async () => {
    mocks.state.config = null;
    mocks.state.configError = { code: "42P01", message: 'relation "public.workspace_alerts" does not exist' };
    await expect(notifyWorkspace(refused)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws: not on a Redis fault, not on a failed send", async () => {
    mocks.state.slotThrows = true;
    await expect(notifyWorkspace(refused)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.state.slotThrows = false;
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(notifyWorkspace(refused)).resolves.toBeUndefined();
  });

  it("posts a Telegram alert to sendMessage with the chat in the body, not in the address", async () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
    mocks.state.config = { destination: "telegram", events: ["refused"] };
    mocks.state.url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=-1001234567890`;
    await notifyWorkspace(refused);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe("-1001234567890");
    expect(body.text).toContain('"summarizer"');
    expect(body.parse_mode).toBeUndefined();
  });

  it("builds the dashboard link from the origin it was given, not from anything else", async () => {
    await notifyWorkspace({ ...refused, origin: "https://passcontrol.example/" });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.text).toContain("<https://passcontrol.example/dashboard/agents/agent-1|");
  });
});
