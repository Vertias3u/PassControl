// "Ask me first": how the owner is asked, and how a Telegram tap becomes a
// decision. The prompt carries agent-chosen text (the path, the body), so it
// is inert on every service. A tap is a decision only through
// decideApproval's own checks (the chat and the message it was sent as),
// and the Bot API is only ever reached at the address built from the
// validated destination.
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const TELEGRAM = `https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=555`;
const DISCORD = "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz";
const ID = "AbCdEfGhIjKlMnOpQrStUv";

const m = vi.hoisted(() => ({
  settings: { destination: "telegram" } as Record<string, unknown> | null,
  url: "" as string | null,
  attach: vi.fn(async () => undefined),
  decide: vi.fn(async (_input: { decision: string }) => ({ state: "approved" })),
  claim: vi.fn(async () => true),
  release: vi.fn(async () => undefined),
  readOffset: vi.fn(async () => 7),
  writeOffset: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: m.url, error: null }),
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: m.settings, error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/state/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/approvals")>()),
  attachTelegramMessage: m.attach,
  decideApproval: m.decide,
  claimTelegramPoll: m.claim,
  releaseTelegramPoll: m.release,
  readTelegramOffset: m.readOffset,
  writeTelegramOffset: m.writeOffset,
}));

import {
  approvalTextHash,
  formatApprovalPrompt,
  pollTelegramDecisions,
  sendApprovalPrompt,
  type ApprovalPromptInfo,
} from "@/lib/alerts/approvals";

const info: ApprovalPromptInfo = {
  id: ID,
  agentName: "poster`bot",
  serviceLabel: "Discord",
  method: "POST",
  path: "/v10/channels/1/messages",
  preview: '{"content":"hi @everyone [click](https://evil.example) `x` <!channel>"}',
  dashboardUrl: "https://pc.example/dashboard/approvals",
};

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  m.settings = { destination: "telegram" };
  m.url = TELEGRAM;
  m.claim.mockResolvedValue(true);
  m.decide.mockImplementation(async (input: { decision: string }) => ({ state: input.decision }));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the approval prompt", () => {
  it("on Telegram: plain text, two buttons naming the approval, no mention", () => {
    const body = formatApprovalPrompt("telegram", info, "555");
    expect(body).not.toHaveProperty("parse_mode");
    expect(body.chat_id).toBe("555");
    expect(body.reply_markup.inline_keyboard).toEqual([
      [
        { text: "Approve", callback_data: `pca:${ID}` },
        { text: "Deny", callback_data: `pcd:${ID}` },
      ],
    ]);
    expect(body.text).toContain("POST /v10/channels/1/messages");
    expect(body.text).toContain("Discord");
    // A plain @name pings on Telegram. Shown as a full-width ＠, so the owner
    // still SEES that the message would mention everyone.
    expect(body.text).not.toContain("@");
    expect(body.text).toContain("＠everyone");
    expect(body.text).toContain(info.dashboardUrl);
  });

  it("on Telegram, a preview it has to cut says so, and offers only Deny", () => {
    const long = { ...info, preview: `${"harmless ".repeat(400)}PAYLOAD` };
    const body = formatApprovalPrompt("telegram", long, "555");
    expect(body.text).not.toContain("PAYLOAD");
    expect(body.text).toMatch(/more characters/);
    expect(body.text).toMatch(/Approvals page/);
    expect(body.reply_markup.inline_keyboard).toEqual([[{ text: "Deny", callback_data: `pcd:${ID}` }]]);
  });

  it("on Discord: no mention resolves, and the preview cannot leave its code span", () => {
    const body = formatApprovalPrompt("discord", info);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const previewLine = body.content.split("\n").find((line) => line.includes("content"))!;
    expect(previewLine.startsWith("`")).toBe(true);
    expect(previewLine.endsWith("`")).toBe(true);
    expect(previewLine.slice(1, -1)).not.toContain("`");
  });

  it("on Slack: escaped, so <!channel> is text", () => {
    const body = formatApprovalPrompt("slack", info);
    expect(body.text).not.toContain("<!channel>");
    expect(body.text).toContain("&lt;!channel&gt;");
    expect(body.text).toContain(`<${info.dashboardUrl}|Review in PassControl>`);
  });

  it("keeps a long preview within Telegram's message limit", () => {
    const body = formatApprovalPrompt("telegram", { ...info, preview: "x".repeat(20000) }, "555");
    expect(body.text.length).toBeLessThan(4096);
  });

  it("on Discord and Slack, a cut preview says so", () => {
    const long = { ...info, preview: "y".repeat(5000) };
    expect(formatApprovalPrompt("discord", long).content).toMatch(/more characters/);
    expect(formatApprovalPrompt("discord", long).content.length).toBeLessThan(2000);
    expect(formatApprovalPrompt("slack", long).text).toMatch(/more characters/);
  });
});

describe("sending the prompt", () => {
  it("posts to the bot's sendMessage and binds the approval to the message it got back", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, result: { message_id: 42, chat: { id: 555 } } }));
    expect(await sendApprovalPrompt("tenant-a", info)).toEqual({ sent: true, channel: "telegram" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body).reply_markup.inline_keyboard[0][0].callback_data).toBe(`pca:${ID}`);
    const sent = JSON.parse(init.body).text as string;
    expect(m.attach).toHaveBeenCalledWith(ID, "555", "42", await approvalTextHash(sent));
  });

  it("asks on Discord with a link, since a webhook has no buttons", async () => {
    m.settings = { destination: "discord" };
    m.url = DISCORD;
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await sendApprovalPrompt("tenant-a", info)).toEqual({ sent: true, channel: "discord" });
    expect(m.attach).not.toHaveBeenCalled();
  });

  it("sends nothing when the workspace has no alert destination", async () => {
    m.settings = null;
    expect(await sendApprovalPrompt("tenant-a", info)).toEqual({ sent: false, channel: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws: a failed send is reported, and the dashboard still has the question", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await sendApprovalPrompt("tenant-a", info)).toEqual({ sent: false, channel: "telegram" });
  });
});

describe("reading Telegram taps", () => {
  const tap = (updateId: number, data: string, chat = 555, message = 42, extra: Record<string, unknown> = {}) => ({
    update_id: updateId,
    callback_query: {
      id: `cq${updateId}`,
      data,
      message: { message_id: message, chat: { id: chat }, text: "PassControl asks", ...extra },
    },
  });

  it("aborts getUpdates at the caller's cap when that comes first", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(json({ ok: true, result: [] }));
    await pollTelegramDecisions("tenant-a", 14, 2_500);
    expect(timeout).toHaveBeenCalledWith(2_500);
    timeout.mockClear();
    await pollTelegramDecisions("tenant-a", 5);
    expect(timeout).toHaveBeenCalledWith(10_000);
    timeout.mockRestore();
  });

  it("does nothing when another poll holds the lock", async () => {
    m.claim.mockResolvedValue(false);
    expect(await pollTelegramDecisions("tenant-a", 5)).toEqual({ state: "busy" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("decides each tap through decideApproval with its chat and message, answers it, and moves the offset", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/getUpdates")
        ? json({ ok: true, result: [tap(7, `pca:${ID}`), tap(8, "something-else"), tap(9, `pcd:${ID}`, 556, 1)] })
        : json({ ok: true, result: true })
    );
    expect(await pollTelegramDecisions("tenant-a", 5)).toEqual({ state: "ok", decided: 2 });

    const [getUpdates] = fetchMock.mock.calls[0]!;
    expect(getUpdates).toContain(`https://api.telegram.org/bot${TOKEN}/getUpdates?`);
    expect(getUpdates).toContain("offset=7");
    const textHash = await approvalTextHash("PassControl asks");
    expect(m.decide).toHaveBeenCalledWith({
      userId: "tenant-a",
      id: ID,
      decision: "approved",
      by: "telegram",
      telegram: { chat: "555", message: "42", textHash },
    });
    expect(m.decide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", telegram: { chat: "556", message: "1", textHash } })
    );
    expect(m.decide).toHaveBeenCalledTimes(2);
    const answered = fetchMock.mock.calls.filter(([url]) => String(url).includes("/answerCallbackQuery"));
    expect(answered).toHaveLength(3);
    expect(m.writeOffset).toHaveBeenCalledWith("tenant-a", 10);
    expect(m.release).toHaveBeenCalled();
  });

  it("removes the buttons from a message it decided, and only that one", async () => {
    m.decide.mockResolvedValueOnce({ state: "approved" }).mockResolvedValueOnce({ state: "missing" });
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/getUpdates")
        ? json({ ok: true, result: [tap(7, `pca:${ID}`), tap(8, `pca:${ID}`, 555, 99)] })
        : json({ ok: true, result: true })
    );
    await pollTelegramDecisions("tenant-a", 5);
    const edits = fetchMock.mock.calls.filter(([url]) => String(url).includes("/editMessageText"));
    expect(edits).toHaveLength(1);
    const body = JSON.parse(edits[0]![1].body);
    expect(body).toMatchObject({ chat_id: "555", message_id: 42 });
    expect(body).not.toHaveProperty("reply_markup");
    expect(body.text).toMatch(/Approved/);
  });

  it("does not decide from a message that was edited after it was sent", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/getUpdates")
        ? json({ ok: true, result: [tap(7, `pca:${ID}`, 555, 42, { edit_date: 1700000000 })] })
        : json({ ok: true, result: true })
    );
    expect(await pollTelegramDecisions("tenant-a", 5)).toEqual({ state: "ok", decided: 0 });
    expect(m.decide).not.toHaveBeenCalled();
    const answered = fetchMock.mock.calls.find(([url]) => String(url).includes("/answerCallbackQuery"))!;
    expect(JSON.parse(answered[1].body).text).toMatch(/changed/);
  });

  it("reports a bot whose updates go to a webhook, and still releases the lock", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, error_code: 409, description: "Conflict" }, 409));
    expect(await pollTelegramDecisions("tenant-a", 5)).toEqual({ state: "conflict" });
    expect(m.release).toHaveBeenCalled();
  });

  it("does not poll a workspace whose alerts are not on Telegram", async () => {
    m.settings = { destination: "discord" };
    m.url = DISCORD;
    expect(await pollTelegramDecisions("tenant-a", 5)).toEqual({ state: "not_telegram" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
