// Injection guard Phase 2: "Clear the hold" on Telegram, next to a held prompt
// (plans/injection-guard.md §4, "Who clears it").
//
// A tap ends a hold, so it is held to Ask-me-first's rules: the button names the
// held approval, the tap counts only from the message it was sent as, with the text
// PassControl sent, in this workspace (lib/state/approvals.ts approvalAgentForTap),
// and an edited message is refused. Clearing does not answer the held question, and
// leaves the message alone: editing it would change the text Approve and Deny are
// bound to.
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const TELEGRAM = `https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=555`;
const APPROVAL = "AbCdEfGhIjKlMnOpQrStUv";

const m = vi.hoisted(() => ({
  agentFor: vi.fn(async (..._a: unknown[]): Promise<string | null> => "agent-a"),
  clear: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  decide: vi.fn(async (input: { decision: string }) => ({ state: input.decision })),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: TELEGRAM, error: null }),
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { destination: "telegram" }, error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/state/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/approvals")>()),
  approvalAgentForTap: (...a: unknown[]) => m.agentFor(...a),
  decideApproval: m.decide,
  claimTelegramPoll: vi.fn(async () => true),
  releaseTelegramPoll: vi.fn(async () => undefined),
  readTelegramOffset: vi.fn(async () => 7),
  writeTelegramOffset: vi.fn(async () => undefined),
}));
vi.mock("@/lib/state/taint", () => ({ clearTaint: (...a: unknown[]) => m.clear(...a) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => m.audit(...a) }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn() }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn(async () => undefined) }));

import { approvalTextHash, formatApprovalPrompt, pollTelegramDecisions } from "@/lib/alerts/approvals";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  m.agentFor.mockResolvedValue("agent-a");
  m.clear.mockResolvedValue(true);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const TEXT = 'PassControl: "bot" asks to call GitHub:';
const tapOf = (data: string, extra: Record<string, unknown> = {}) => ({
  update_id: 9,
  callback_query: { id: "q9", data, message: { message_id: 42, chat: { id: 555 }, text: TEXT, ...extra } },
});
const sent = (method: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/${method}`)).map(([, init]) => JSON.parse(init.body));
const poll = async (update: unknown) => {
  fetchMock.mockResolvedValueOnce(json({ ok: true, result: [update] }));
  fetchMock.mockResolvedValue(json({ ok: true }));
  return pollTelegramDecisions("tenant-a", 0);
};

const INFO = {
  id: APPROVAL,
  agentName: "bot",
  serviceLabel: "GitHub",
  method: "POST",
  path: "/repos/acme/web/issues",
  preview: '{"title":"x"}',
  dashboardUrl: "https://pc.example/dashboard/approvals",
};

describe("the held prompt's Clear button", () => {
  it("is offered on a tainted hold, on its own row under Approve and Deny", () => {
    const body = formatApprovalPrompt("telegram", { ...INFO, heldBecause: "Held by the injection guard: …", offerClear: true }, "555");
    expect(body.reply_markup.inline_keyboard).toEqual([
      [
        { text: "Approve", callback_data: `pca:${APPROVAL}` },
        { text: "Deny", callback_data: `pcd:${APPROVAL}` },
      ],
      [{ text: "Clear the hold", callback_data: `pcc:${APPROVAL}` }],
    ]);
  });

  it("is not offered on an ordinary Ask-me-first prompt", () => {
    const body = formatApprovalPrompt("telegram", INFO, "555");
    expect(JSON.stringify(body.reply_markup)).not.toContain("pcc:");
  });
});

describe("reading a Clear tap", () => {
  it("clears the agent its binding names, audits it, decides nothing, and leaves the message alone", async () => {
    expect(await poll(tapOf(`pcc:${APPROVAL}`))).toEqual({ state: "ok", decided: 1 });
    expect(m.agentFor).toHaveBeenCalledWith({ userId: "tenant-a", id: APPROVAL, chat: "555", message: "42", textHash: await approvalTextHash(TEXT) });
    expect(m.clear).toHaveBeenCalledWith("agent-a");
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "tenant-a", action: "agent.injection_clear", targetType: "agent", targetId: "agent-a", metadata: { cleared: true, by: "telegram" } })
    );
    expect(m.decide).not.toHaveBeenCalled();
    expect(sent("editMessageText")).toEqual([]);
    expect(sent("answerCallbackQuery")[0].text).toMatch(/Hold cleared.*still waits/);
  });

  it("clears nothing from a tap the binding refuses", async () => {
    m.agentFor.mockResolvedValue(null);
    expect(await poll(tapOf(`pcc:${APPROVAL}`))).toEqual({ state: "ok", decided: 0 });
    expect(m.clear).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
    expect(sent("answerCallbackQuery")[0].text).toMatch(/agent's page/);
  });

  it("refuses an edited message without asking the binding", async () => {
    expect(await poll(tapOf(`pcc:${APPROVAL}`, { edit_date: 1 }))).toEqual({ state: "ok", decided: 0 });
    expect(m.agentFor).not.toHaveBeenCalled();
    expect(m.clear).not.toHaveBeenCalled();
  });

  it("says so when Redis cannot clear it", async () => {
    m.clear.mockRejectedValue(new Error("redis down"));
    expect(await poll(tapOf(`pcc:${APPROVAL}`))).toEqual({ state: "ok", decided: 0 });
    expect(m.audit).not.toHaveBeenCalled();
    expect(sent("answerCallbackQuery")[0].text).toMatch(/could not clear/);
  });
});
