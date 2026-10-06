// The Settings actions for workspace alerts. Saving, changing or removing the
// destination is gated like a credential (MFA step-up): silencing alerts is
// exactly what a stolen session would do. The URL goes to Vault through the
// service-role RPC and is never echoed back to the browser.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake, and split so secret scanners do not block a push over it.
const SLACK = "https://hooks.slack.com/services/" + "T0123ABCD/B0456EFGH/abcdEFGH1234ijklMNOP5678";

const mocks = vi.hoisted(() => {
  const state = {
    gate: { ok: true, user: { id: "tenant-a", email: "a@example.test" } } as Record<string, unknown>,
    row: null as Record<string, unknown> | null,
    rowError: null as null | { code?: string; message: string },
    rpcError: null as null | { code?: string; message: string },
    url: "" as string | null,
    limited: false,
  };
  const updates: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === "get_workspace_alert_url_for_user") return { data: state.url, error: null };
    return { data: null, error: state.rpcError };
  });
  const from = vi.fn((table: string) => {
    if (table !== "workspace_alerts") throw new Error(`unexpected table ${table}`);
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: state.row, error: state.rowError }),
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return { eq: async () => ({ error: null }) };
      },
    };
    return q;
  });
  return {
    state,
    updates,
    rpc,
    from,
    mfaAuthorizedUser: vi.fn(async () => state.gate),
    recordAdminAction: vi.fn(async () => undefined),
    rateLimit: vi.fn(async () => ({ success: !state.limited, remaining: 0 })),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://passcontrol.example" }) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({}) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: mocks.mfaAuthorizedUser }));
vi.mock("@/lib/profile/manage", () => ({ ensureProfileRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: mocks.recordAdminAction }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: mocks.rateLimit }));

import { removeAlertDestination, saveAlertSettings, sendTestAlert } from "@/app/dashboard/settings/alert-actions";

const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
const setCalls = () => mocks.rpc.mock.calls.filter(([name]) => name === "set_workspace_alert_destination_for_user");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates.length = 0;
  Object.assign(mocks.state, {
    gate: { ok: true, user: { id: "tenant-a", email: "a@example.test" } },
    row: null,
    rowError: null,
    rpcError: null,
    url: SLACK,
    limited: false,
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("saveAlertSettings", () => {
  it("needs the two-factor step-up and touches nothing without it", async () => {
    mocks.state.gate = { ok: false, reason: "step_up_required" };
    const result = await saveAlertSettings({ url: SLACK, events: ["refused"] });
    expect(result.error).toMatch(/two-factor/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updates).toHaveLength(0);
  });

  it("refuses anything but a Slack or Discord webhook", async () => {
    const result = await saveAlertSettings({ url: "https://evil.example/hook", events: ["refused"] });
    expect(result.error).toMatch(/Slack or Discord/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("stores the canonical URL in Vault for the session's own account, and never returns it", async () => {
    const result = await saveAlertSettings({ url: `  ${SLACK}  `, events: ["refused", "security"] });
    expect(result.error).toBeUndefined();
    expect(setCalls()).toEqual([[
      "set_workspace_alert_destination_for_user",
      { p_user_id: "tenant-a", p_destination: "slack", p_hint: "hooks.slack.com/…/5678", p_url: SLACK },
    ]]);
    expect(mocks.updates).toEqual([{ events: ["refused", "security"], updated_at: expect.any(String) }]);
    expect(JSON.stringify(result)).not.toContain("abcdEFGH1234");
    expect(mocks.recordAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      userId: "tenant-a",
      action: "workspace.alerts",
      metadata: expect.objectContaining({ to: "slack", hint: "hooks.slack.com/…/5678", events: ["refused", "security"] }),
    }));
    expect(JSON.stringify(mocks.recordAdminAction.mock.calls)).not.toContain("abcdEFGH1234");
  });

  it("builds a Telegram destination from a bot token and a chat id, and never returns the token", async () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
    const result = await saveAlertSettings({ url: "", telegramToken: token, telegramChatId: "-1001234567890", events: ["refused"] });
    expect(result.error).toBeUndefined();
    expect(setCalls()).toEqual([[
      "set_workspace_alert_destination_for_user",
      {
        p_user_id: "tenant-a",
        p_destination: "telegram",
        p_hint: "bot …saw0 → chat -1001234567890",
        p_url: `https://api.telegram.org/bot${token}/sendMessage?chat_id=-1001234567890`,
      },
    ]]);
    expect(JSON.stringify(result)).not.toContain("AAHdqTcv");
    expect(JSON.stringify(mocks.recordAdminAction.mock.calls)).not.toContain("AAHdqTcv");
  });

  it("asks for both Telegram fields, and refuses a malformed one", async () => {
    expect((await saveAlertSettings({ url: "", telegramToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0", telegramChatId: "", events: [] })).error).toMatch(/bot token and a chat ID/);
    expect((await saveAlertSettings({ url: "", telegramToken: "not-a-token", telegramChatId: "-100123", events: [] })).error).toMatch(/bot token and a chat ID/);
    expect(setCalls()).toHaveLength(0);
  });

  it("keeps only known kinds, in a fixed order, without duplicates", async () => {
    await saveAlertSettings({ url: SLACK, events: ["security", "everything", "refused", "refused"] });
    expect(mocks.updates[0]?.events).toEqual(["refused", "security"]);
  });

  it("changes only the kinds when the URL field is left blank and a destination exists", async () => {
    mocks.state.row = { destination: "slack", hint: "hooks.slack.com/…/5678", events: ["refused"] };
    const result = await saveAlertSettings({ url: "", events: ["budget"] });
    expect(result.error).toBeUndefined();
    expect(setCalls()).toHaveLength(0);
    expect(mocks.updates).toEqual([{ events: ["budget"], updated_at: expect.any(String) }]);
  });

  it("asks for a URL when there is no destination yet", async () => {
    const result = await saveAlertSettings({ url: "", events: ["budget"] });
    expect(result.error).toMatch(/Paste a Slack or Discord webhook URL/);
  });

  it("says which migration is missing on an instance without 0078", async () => {
    mocks.state.rpcError = { code: "PGRST202", message: "Could not find the function" };
    const result = await saveAlertSettings({ url: SLACK, events: ["refused"] });
    expect(result.error).toMatch(/0078/);
  });
});

describe("removeAlertDestination", () => {
  it("is gated, deletes through the RPC and records it", async () => {
    mocks.state.gate = { ok: false, reason: "step_up_required" };
    expect((await removeAlertDestination()).error).toMatch(/two-factor/);
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.state.gate = { ok: true, user: { id: "tenant-a" } };
    expect((await removeAlertDestination()).error).toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("delete_workspace_alert_destination_for_user", { p_user_id: "tenant-a" });
    expect(mocks.recordAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.alerts",
      metadata: expect.objectContaining({ to: "none" }),
    }));
  });
});

describe("sendTestAlert", () => {
  it("posts a test message to the stored destination", async () => {
    const result = await sendTestAlert();
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/Sent/);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.text).toMatch(/^Test alert from PassControl/);
  });

  it("is rate limited per account", async () => {
    mocks.state.limited = true;
    const result = await sendTestAlert();
    expect(result.error).toMatch(/Too many test alerts/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith("alert-test:tenant-a", expect.any(Number), expect.any(Number));
  });

  it("says when there is nowhere to send", async () => {
    mocks.state.url = null;
    expect((await sendTestAlert()).error).toMatch(/No alert destination/);
  });

  it("says when the service refused the message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no_service", { status: 404 }));
    expect((await sendTestAlert()).error).toMatch(/did not accept/);
  });
});
