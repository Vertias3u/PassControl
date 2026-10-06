// "Ask me first": the approval store, run as REAL Lua against a REAL Redis
// through SRH, the same @upstash/redis REST path production uses.
//
// What it must guarantee, each one a way an approval could let through more
// than the owner said yes to:
//   - an approval is used ONCE: two identical retries racing get one admission;
//   - a denial stays a denial for every retry, it does not reset to pending;
//   - a decision names its workspace: another tenant's id decides nothing;
//   - a Telegram tap is accepted only from the message PassControl sent;
//   - a flood of distinct requests cannot open unbounded prompts.
//
// Needs the local stack (docker compose -f docker/compose.yml up -d); skips
// loudly when SRH is unreachable, fails the lane on CI.
import { afterEach, describe, expect, it } from "vitest";
import { redisGate } from "./support/redis-gate";

const URL_ = process.env.TEST_UPSTASH_REDIS_REST_URL ?? "http://localhost:8079";
const TOKEN = process.env.TEST_UPSTASH_REDIS_REST_TOKEN ?? "passcontrol_local_dev_token";

async function srhReachable(): Promise<boolean> {
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(["PING"]),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const gate = redisGate({
  reachable: await srhReachable(),
  ci: process.env.CI === "true" || process.env.CI === "1",
  url: URL_,
});
if (gate.fail) throw new Error(gate.fail);
if (!gate.run) {
  // eslint-disable-next-line no-console
  console.warn(`[approvals.redis.test] SKIPPED: no SRH at ${URL_}.`);
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const approvals = await import("../lib/state/approvals");
const { redis } = await import("../lib/state/redis");

const users: string[] = [];
function tenant(): string {
  const id = `test-${crypto.randomUUID()}`;
  users.push(id);
  return id;
}
const fingerprints: string[] = [];
const fp = () => {
  const value = `fp-${crypto.randomUUID()}`;
  fingerprints.push(value);
  return value;
};
const request = (userId: string, fingerprint = fp()) => ({
  userId,
  agentId: "agent-1",
  service: "discord",
  method: "POST",
  path: "/v10/channels/1/messages",
  preview: '{"content":"hello"}',
  fingerprint,
});

afterEach(async () => {
  for (const value of fingerprints.splice(0)) {
    const id = await redis().get<string>(`apvfp:${value}`);
    if (id) await redis().del(`apv:${id}`);
    await redis().del(`apvfp:${value}`);
  }
  for (const userId of users.splice(0)) {
    for (const item of await approvals.listPendingApprovals(userId)) {
      await redis().del(`apv:${item.id}`);
    }
    await redis().del(`apvq:${userId}`, `apvtg:lock:${userId}`, `apvtg:off:${userId}`);
  }
});

describe.runIf(gate.run)("the approval store", () => {
  it("opens one pending approval per request, however often the agent retries", async () => {
    const user = tenant();
    const req = request(user);
    const first = await approvals.checkApproval(req, { create: true });
    expect(first.state).toBe("created");
    const again = await approvals.checkApproval(req, { create: true });
    expect(again).toEqual({ state: "pending", id: first.id });
    const pending = await approvals.listPendingApprovals(user);
    expect(pending.map((p) => p.id)).toEqual([first.id]);
    expect(pending[0]).toMatchObject({ agentId: "agent-1", service: "discord", method: "POST", preview: '{"content":"hello"}' });
  });

  it("does not create anything when asked only to look", async () => {
    const user = tenant();
    expect(await approvals.checkApproval(request(user), { create: false })).toEqual({ state: "none" });
    expect(await approvals.listPendingApprovals(user)).toEqual([]);
  });

  it("admits an approved request exactly once, even to two retries racing", async () => {
    const user = tenant();
    const req = request(user);
    const { id } = await approvals.checkApproval(req, { create: true });
    expect(await approvals.decideApproval({ userId: user, id: id!, decision: "approved", by: "dashboard" })).toEqual({
      state: "approved",
    });
    const [a, b] = await Promise.all([
      approvals.checkApproval(req, { create: false }),
      approvals.checkApproval(req, { create: false }),
    ]);
    expect([a.state, b.state].sort()).toEqual(["approved", "none"]);
    // And the same request again later is a NEW question, not a free pass.
    expect((await approvals.checkApproval(req, { create: true })).state).toBe("created");
  });

  it("keeps a denial for every retry", async () => {
    const user = tenant();
    const req = request(user);
    const { id } = await approvals.checkApproval(req, { create: true });
    await approvals.decideApproval({ userId: user, id: id!, decision: "denied", by: "dashboard" });
    expect(await approvals.checkApproval(req, { create: true })).toEqual({ state: "denied", id });
    expect(await approvals.checkApproval(req, { create: true })).toEqual({ state: "denied", id });
    expect(await approvals.listPendingApprovals(user)).toEqual([]);
  });

  it("decides once: a second decision reports the first and changes nothing", async () => {
    const user = tenant();
    const req = request(user);
    const { id } = await approvals.checkApproval(req, { create: true });
    await approvals.decideApproval({ userId: user, id: id!, decision: "denied", by: "dashboard" });
    expect(await approvals.decideApproval({ userId: user, id: id!, decision: "approved", by: "dashboard" })).toEqual({
      state: "denied",
    });
    expect((await approvals.checkApproval(req, { create: false })).state).toBe("denied");
  });

  it("refuses a decision from another workspace", async () => {
    const owner = tenant();
    const other = tenant();
    const req = request(owner);
    const { id } = await approvals.checkApproval(req, { create: true });
    expect(await approvals.decideApproval({ userId: other, id: id!, decision: "approved", by: "dashboard" })).toEqual({
      state: "missing",
    });
    expect((await approvals.checkApproval(req, { create: false })).state).toBe("pending");
  });

  it("accepts a Telegram tap only on the message it sent, in the chat it sent it to", async () => {
    const user = tenant();
    const req = request(user);
    const { id } = await approvals.checkApproval(req, { create: true });
    await approvals.attachTelegramMessage(id!, "555", "42", "h");
    const tap = (chat: string, message: string) =>
      approvals.decideApproval({
        userId: user,
        id: id!,
        decision: "approved",
        by: "telegram",
        telegram: { chat, message, textHash: "h" },
      });
    expect(await tap("555", "43")).toEqual({ state: "missing" });
    expect(await tap("556", "42")).toEqual({ state: "missing" });
    expect((await approvals.checkApproval(req, { create: false })).state).toBe("pending");
    expect(await tap("555", "42")).toEqual({ state: "approved" });
  });

  it("refuses a Telegram tap on an approval that was never sent to Telegram", async () => {
    const user = tenant();
    const { id } = await approvals.checkApproval(request(user), { create: true });
    expect(
      await approvals.decideApproval({
        userId: user,
        id: id!,
        decision: "approved",
        by: "telegram",
        telegram: { chat: "555", message: "42", textHash: "h" },
      })
    ).toEqual({ state: "missing" });
  });

  it("keeps a large preview whole, for the Approvals page to show", async () => {
    const user = tenant();
    const preview = `${"harmless ".repeat(1000)}PAYLOAD`;
    const { id } = await approvals.checkApproval({ ...request(user), preview }, { create: true });
    expect((await approvals.readApproval(user, id!))!.preview).toBe(preview);
  });

  it("refuses a tap on a message whose text is not the text PassControl sent", async () => {
    const user = tenant();
    const req = request(user);
    const { id } = await approvals.checkApproval(req, { create: true });
    await approvals.attachTelegramMessage(id!, "555", "42", "hash-of-sent-text");
    const tap = (textHash: string) =>
      approvals.decideApproval({
        userId: user,
        id: id!,
        decision: "approved",
        by: "telegram",
        telegram: { chat: "555", message: "42", textHash },
      });
    expect(await tap("hash-of-rewritten-text")).toEqual({ state: "missing" });
    expect(await tap("hash-of-sent-text")).toEqual({ state: "approved" });
  });

  it("caps the open questions per workspace", async () => {
    const user = tenant();
    for (let i = 0; i < approvals.MAX_PENDING_APPROVALS; i++) {
      expect((await approvals.checkApproval(request(user), { create: true })).state).toBe("created");
    }
    expect(await approvals.checkApproval(request(user), { create: true })).toEqual({ state: "full" });
  });

  it("reads one approval back for its owner only", async () => {
    const user = tenant();
    const { id } = await approvals.checkApproval(request(user), { create: true });
    expect(await approvals.readApproval(user, id!)).toMatchObject({ id, state: "pending", service: "discord" });
    expect(await approvals.readApproval(tenant(), id!)).toBeNull();
  });

  it("lets one Telegram poller run at a time, and remembers the offset", async () => {
    const user = tenant();
    expect(await approvals.claimTelegramPoll(user)).toBe(true);
    expect(await approvals.claimTelegramPoll(user)).toBe(false);
    await approvals.releaseTelegramPoll(user);
    expect(await approvals.claimTelegramPoll(user)).toBe(true);
    expect(await approvals.readTelegramOffset(user)).toBe(0);
    await approvals.writeTelegramOffset(user, 1234);
    expect(await approvals.readTelegramOffset(user)).toBe(1234);
  });
});
