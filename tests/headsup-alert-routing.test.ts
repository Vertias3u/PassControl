// The heads-up (1.6.0, L8) reaches a Telegram workspace with "Suspend it now"
// (L8b), and every other destination as the ordinary alert. It has its own
// 10-minute slot, so a budget alert just before cannot swallow the period's one.
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const m = vi.hoisted(() => ({
  destination: "telegram",
  url: "",
  slot: vi.fn(async (..._a: unknown[]) => true),
  headsUp: vi.fn(async (..._a: unknown[]) => true),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: m.url, error: null }),
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: table === "agents" ? { name: "bot" } : { destination: m.destination, events: ["budget"] },
          error: null,
        }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/state/redis", () => ({ claimAlertSlot: (...a: unknown[]) => m.slot(...a) }));
vi.mock("@/lib/alerts/approvals", () => ({
  sendHeadsUpPrompt: (...a: unknown[]) => m.headsUp(...a),
  sendPausePrompt: vi.fn(async () => false),
}));

import { notifyWorkspace } from "@/lib/alerts/workspace";

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
const headsUp = { target: "limit" as const, at: "2026-10-22T15:00:00.000Z", period: "day" as const, spentMicrocents: 16e8, targetMicrocents: 20e8 };
const send = () =>
  notifyWorkspace({ userId: "tenant-a", agentId: "agent-a", type: "budget", status: "budget_headsup", origin: "https://pc.test", headsUp });

beforeEach(() => {
  vi.clearAllMocks();
  m.destination = "telegram";
  m.url = `https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=555`;
  m.headsUp.mockResolvedValue(true);
  vi.stubGlobal("fetch", fetchMock);
});

describe("the heads-up's delivery", () => {
  it("goes to Telegram with its button, and not a second time as the plain alert", async () => {
    await send();
    expect(m.slot).toHaveBeenCalledWith("tenant-a", "budget_headsup", "agent-a");
    expect(m.headsUp).toHaveBeenCalledWith("tenant-a", expect.objectContaining({ agentId: "agent-a", alert: expect.objectContaining({ status: "budget_headsup", headsUp }) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the plain alert when the button could not be sent", async () => {
    m.headsUp.mockResolvedValue(false);
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("goes everywhere else as the plain alert", async () => {
    m.destination = "discord";
    m.url = "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz";
    await send();
    expect(m.headsUp).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body)).content).toMatch(/on pace to reach its daily limit/);
  });
});
