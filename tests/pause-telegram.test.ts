// The soft pause's Telegram button (1.6.0, L4b): "Let it go on for an hour".
//
// A tap lets an agent spend again, so it is held to Ask-me-first's rules: the
// button names a minted prompt id, a tap counts only from the message it was sent
// as (lib/state/pause.ts takePausePrompt), an edited message is refused, and the
// ONE poller reads both kinds of tap: a second getUpdates reader would share the
// offset and eat the other's taps.
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const TELEGRAM = `https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=555`;
const PROMPT = "PpPpPpPpPpPpPpPpPpPpPp";
const APPROVAL = "AbCdEfGhIjKlMnOpQrStUv";

const m = vi.hoisted(() => ({
  settings: { destination: "telegram" } as Record<string, unknown> | null,
  url: "" as string | null,
  agent: { budget_period: "day" } as Record<string, unknown> | null,
  decide: vi.fn(async (input: { decision: string }) => ({ state: input.decision })),
  take: vi.fn(async (..._a: unknown[]): Promise<string | null> => "agent-a"),
  lift: vi.fn(async (..._a: unknown[]) => undefined),
  record: vi.fn(async (..._a: unknown[]) => undefined),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  writeOffset: vi.fn(async (..._a: unknown[]) => undefined),
  takeStop: vi.fn(async (..._a: unknown[]): Promise<string | null> => "agent-a"),
  recordStop: vi.fn(async (..._a: unknown[]) => undefined),
  suspend: vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { id: "agent-a" } }) as { ok: boolean }),
  eqs: [] as [string, unknown][],
}));

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: m.url, error: null }),
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => (m.eqs.push([col, v]), q),
        maybeSingle: async () => ({ data: table === "agents" ? m.agent : m.settings, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/state/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/approvals")>()),
  attachTelegramMessage: vi.fn(async () => undefined),
  decideApproval: m.decide,
  claimTelegramPoll: vi.fn(async () => true),
  releaseTelegramPoll: vi.fn(async () => undefined),
  readTelegramOffset: vi.fn(async () => 7),
  writeTelegramOffset: m.writeOffset,
}));
vi.mock("@/lib/state/pause", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/pause")>()),
  takePausePrompt: (...a: unknown[]) => m.take(...a),
  liftPause: (...a: unknown[]) => m.lift(...a),
  recordPausePrompt: (...a: unknown[]) => m.record(...a),
  takeStopPrompt: (...a: unknown[]) => m.takeStop(...a),
  recordStopPrompt: (...a: unknown[]) => m.recordStop(...a),
}));
vi.mock("@/lib/fleet", () => ({ setAgentSuspended: (...a: unknown[]) => m.suspend(...a) }));
const sec = vi.hoisted(() => ({ log: vi.fn(), dispatch: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: (...a: unknown[]) => sec.log(...a) }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: (...a: unknown[]) => sec.dispatch(...a) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => m.audit(...a) }));

import { approvalTextHash, formatPausePrompt, pollTelegramDecisions, sendHeadsUpPrompt, sendPausePrompt } from "@/lib/alerts/approvals";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  m.settings = { destination: "telegram" };
  m.url = TELEGRAM;
  m.agent = { budget_period: "day" };
  m.eqs = [];
  m.take.mockResolvedValue("agent-a");
  m.takeStop.mockResolvedValue("agent-a");
  m.suspend.mockResolvedValue({ ok: true });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const TEXT = "PassControl paused agent-a.";
const tapOf = (update: number, data: string, extra: Record<string, unknown> = {}) => ({
  update_id: update,
  callback_query: { id: `q${update}`, data, message: { message_id: 42, chat: { id: 555 }, text: TEXT, ...extra } },
});
const sent = (method: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/${method}`)).map(([, init]) => JSON.parse(init.body));

describe("the pause prompt", () => {
  it("is plain text with one button naming the minted id, and no mention survives", () => {
    const body = formatPausePrompt(
      { id: PROMPT, agentName: "@boss bot", reached: "today's spend is 85% of its limit ($17.00 of $20.00)", percent: 80, dashboardUrl: "https://pc.example/dashboard/agents/a" },
      "555"
    );
    expect(body).not.toHaveProperty("parse_mode");
    expect(body.chat_id).toBe("555");
    expect(body.text).not.toContain("@");
    expect(body.text).toContain("past its 80% pause line");
    expect(body.text).toContain("today's spend is 85% of its limit ($17.00 of $20.00)");
    expect(body.reply_markup.inline_keyboard).toEqual([[{ text: "Let it go on for an hour", callback_data: `ppl:${PROMPT}` }]]);
  });

  it("is bound to the message Telegram sent it as, and the text it showed", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: { message_id: 42, chat: { id: 555 } } }));
    const ok = await sendPausePrompt("tenant-a", { agentId: "agent-a", agentName: "bot", reached: "x", percent: 80, dashboardUrl: "https://pc.example/d" });
    expect(ok).toBe(true);
    const [body] = sent("sendMessage");
    const id = body.reply_markup.inline_keyboard[0][0].callback_data.slice(4);
    expect(m.record).toHaveBeenCalledWith(id, { uid: "tenant-a", agid: "agent-a", chat: "555", msg: "42", hash: await approvalTextHash(body.text) });
  });

  it("is not sent anywhere but Telegram: the other alerts already say it", async () => {
    m.settings = { destination: "discord" };
    m.url = "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz";
    expect(await sendPausePrompt("tenant-a", { agentId: "agent-a", agentName: "bot", reached: "x", percent: 80, dashboardUrl: "https://pc.example/d" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reading a pause tap", () => {
  it("lets the agent go on through takePausePrompt's binding, audits it, and says until when in UTC", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, `ppl:${PROMPT}`)] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    const res = await pollTelegramDecisions("tenant-a", 0);
    expect(res).toEqual({ state: "ok", decided: 1 });
    expect(m.take).toHaveBeenCalledWith({ userId: "tenant-a", id: PROMPT, chat: "555", message: "42", textHash: await approvalTextHash(TEXT) });
    expect(m.lift).toHaveBeenCalledWith("agent-a", expect.any(Number));
    // Tenant-scoped read of the agent's period, for how long the lift lasts.
    expect(m.eqs).toEqual(expect.arrayContaining([["user_id", "tenant-a"], ["id", "agent-a"]]));
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ userId: "tenant-a", action: "agent.pause_lift", targetId: "agent-a", metadata: expect.objectContaining({ lifted: true, by: "telegram" }) }));
    expect(sent("editMessageText")[0].text).toMatch(/Going on until \d\d:\d\d UTC\.$/);
    expect(sent("answerCallbackQuery")[0].text).toBe("Going on for an hour.");
    expect(m.writeOffset).toHaveBeenCalledWith("tenant-a", 10);
  });

  it("lifts nothing from a tap the binding refuses, and says so", async () => {
    m.take.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, `ppl:${PROMPT}`)] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    expect(await pollTelegramDecisions("tenant-a", 0)).toEqual({ state: "ok", decided: 0 });
    expect(m.lift).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
    expect(sent("answerCallbackQuery")[0].text).toBe("This button was already used, or has expired. Use the agent's page.");
  });

  it("refuses an edited message without consulting the binding", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, `ppl:${PROMPT}`, { edit_date: 1 })] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    await pollTelegramDecisions("tenant-a", 0);
    expect(m.take).not.toHaveBeenCalled();
    expect(m.lift).not.toHaveBeenCalled();
  });

  it("decides a mixed batch, approval and pause, and moves the offset once past both", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, `pca:${APPROVAL}`), tapOf(10, `ppl:${PROMPT}`)] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    expect(await pollTelegramDecisions("tenant-a", 0)).toEqual({ state: "ok", decided: 2 });
    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.lift).toHaveBeenCalledTimes(1);
    expect(m.writeOffset).toHaveBeenCalledTimes(1);
    expect(m.writeOffset).toHaveBeenCalledWith("tenant-a", 11);
  });

  it("still answers a button it does not know", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, "ppx:whatever")] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    await pollTelegramDecisions("tenant-a", 0);
    expect(m.take).not.toHaveBeenCalled();
    expect(sent("answerCallbackQuery")[0].text).toBe("PassControl does not know this button.");
  });
});

// L8b (1.6.0): the heads-up carries "Suspend it now" on Telegram. A tap suspends the
// agent through the fleet's own path (Redis block, cache purge, then the row), for
// this workspace's agent only, and is audited. Its callback is its own: a lift's
// button never suspends and this one never lifts.
describe("the heads-up's suspend button", () => {
  const STOP = "SsSsSsSsSsSsSsSsSsSsSs";
  const alert = {
    type: "budget" as const,
    status: "budget_headsup",
    agentName: "@bot",
    at: new Date("2026-10-22T12:00:00Z"),
    dashboardUrl: "https://pc.example/dashboard/agents/agent-a",
    headsUp: { target: "limit" as const, at: "2026-10-22T15:00:00.000Z", period: "day" as const, spentMicrocents: 16e8, targetMicrocents: 20e8 },
  };

  it("sends the heads-up's own text with one button, and binds it to the message", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: { message_id: 42, chat: { id: 555 } } }));
    expect(await sendHeadsUpPrompt("tenant-a", { agentId: "agent-a", alert })).toBe(true);
    const [body] = sent("sendMessage");
    expect(body).not.toHaveProperty("parse_mode");
    expect(body.text).toContain("is on pace to reach its daily limit of $20.00 around 15:00 UTC");
    expect(body.text).not.toContain("@");
    const button = body.reply_markup.inline_keyboard[0][0];
    expect(button.text).toBe("Suspend it now");
    expect(button.callback_data).toMatch(/^pps:[A-Za-z0-9_-]{22}$/);
    expect(m.recordStop).toHaveBeenCalledWith(
      button.callback_data.slice(4),
      { uid: "tenant-a", agid: "agent-a", chat: "555", msg: "42", hash: await approvalTextHash(body.text) },
      // Out until the day it warns about ends: a button for yesterday's limit means nothing.
      expect.any(Number)
    );
    const seconds = m.recordStop.mock.calls[0]![2] as number;
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(86_400);
    expect(m.record).not.toHaveBeenCalled();
  });

  it("is not sent anywhere but Telegram", async () => {
    m.settings = { destination: "discord" };
    m.url = "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz";
    expect(await sendHeadsUpPrompt("tenant-a", { agentId: "agent-a", alert })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a tap suspends this workspace's agent through the fleet path, audits it, then edits the message", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, `pps:${STOP}`)] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    expect(await pollTelegramDecisions("tenant-a", 0)).toEqual({ state: "ok", decided: 1 });
    expect(m.takeStop).toHaveBeenCalledWith({ userId: "tenant-a", id: STOP, chat: "555", message: "42", textHash: await approvalTextHash(TEXT) });
    expect(m.suspend).toHaveBeenCalledWith(expect.anything(), "tenant-a", "agent-a", true);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "tenant-a", action: "agent.suspend", targetId: "agent-a", metadata: { suspended: true, by: "telegram" } })
    );
    // The operator's security log and webhook see it as they see a dashboard suspend.
    expect(sec.log).toHaveBeenCalledWith("agent.suspend", { user: "tenant-a", agentId: "agent-a", suspended: true, by: "telegram" });
    expect(sec.dispatch).toHaveBeenCalledWith("agent.suspend", { user: "tenant-a", agentId: "agent-a", suspended: true, by: "telegram" });
    expect(m.take).not.toHaveBeenCalled();
    expect(m.lift).not.toHaveBeenCalled();
    const [edit] = sent("editMessageText");
    expect(edit.text).toMatch(/Suspended at \d\d:\d\d UTC\. Resume it from the agent's page\.$/);
  });

  it("a lift's button never suspends", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, `ppl:${PROMPT}`)] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    await pollTelegramDecisions("tenant-a", 0);
    expect(m.takeStop).not.toHaveBeenCalled();
    expect(m.suspend).not.toHaveBeenCalled();
  });

  it("a suspend that fails says so, records nothing and leaves the message as it was", async () => {
    m.suspend.mockResolvedValue({ ok: false });
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, `pps:${STOP}`)] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    expect(await pollTelegramDecisions("tenant-a", 0)).toEqual({ state: "ok", decided: 0 });
    expect(m.audit).not.toHaveBeenCalled();
    expect(sent("editMessageText")).toEqual([]);
    expect(sent("answerCallbackQuery")[0].text).toMatch(/could not suspend/i);
  });

  it("an unbound or reused tap suspends nothing, and an edited message is refused before the record is read", async () => {
    m.takeStop.mockResolvedValue(null);
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(9, `pps:${STOP}`)] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    await pollTelegramDecisions("tenant-a", 0);
    expect(m.suspend).not.toHaveBeenCalled();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ ok: true, result: [tapOf(10, `pps:${STOP}`, { edit_date: 1 })] }));
    fetchMock.mockResolvedValue(json({ ok: true }));
    m.takeStop.mockClear();
    await pollTelegramDecisions("tenant-a", 0);
    expect(m.takeStop).not.toHaveBeenCalled();
  });
});
