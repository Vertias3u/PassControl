// The soft pause's lift (1.6.0, L4): the owner lets a paused agent go on for a while.
//
// One Redis key per agent with a TTL, so a lift ends on its own. Reading it is the
// one place the pause fails CLOSED: past the line, a lift that cannot be read keeps
// the agent paused (the proxy's caller treats a throw as "no lift"), because the
// owner chose the pause and only the owner lets it go.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, { value: string; ex?: number }>();
const r = {
  set: vi.fn(async (k: string, v: string, opts?: { ex?: number; nx?: boolean }) => {
    if (opts?.nx && store.has(k)) return null;
    store.set(k, { value: v, ex: opts?.ex });
    return "OK";
  }),
  get: vi.fn(async (k: string) => store.get(k)?.value ?? null),
  del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
};
vi.mock("@/lib/state/redis", () => ({ redis: () => r }));

import {
  endPauseLift,
  liftPause,
  newPausePromptId,
  pausePromptOpen,
  readPauseLift,
  recordPausePrompt,
  claimStopPoll,
  recordStopPrompt,
  stopPromptOpen,
  takePausePrompt,
  takeStopPrompt,
} from "@/lib/state/pause";

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("the pause lift", () => {
  it("is set per agent with the TTL it is given, so it ends on its own", async () => {
    await liftPause("agent-a", 1800);
    expect(store.get("pause_lift:agent-a")).toEqual({ value: "1", ex: 1800 });
    expect(await readPauseLift("agent-a")).toBe(true);
    expect(await readPauseLift("agent-b")).toBe(false);
  });

  it("refuses a TTL that is not a positive whole number of seconds, rather than a lift with no end", async () => {
    await expect(liftPause("agent-a", 0)).rejects.toThrow();
    await expect(liftPause("agent-a", Number.NaN)).rejects.toThrow();
    await expect(liftPause("agent-a", 7200)).rejects.toThrow();
    expect(store.size).toBe(0);
  });

  it("can be ended early (Keep paused)", async () => {
    await liftPause("agent-a", 3600);
    await endPauseLift("agent-a");
    expect(await readPauseLift("agent-a")).toBe(false);
  });

  it("throws when Redis cannot answer, so the caller can stay paused", async () => {
    r.get.mockRejectedValueOnce(new Error("redis down"));
    await expect(readPauseLift("agent-a")).rejects.toThrow("redis down");
  });
});

// The Telegram button (L4b): a minted id bound to the message it was sent as.
describe("the Telegram pause prompt", () => {
  const prompt = { uid: "tenant-a", agid: "agent-a", chat: "555", msg: "42", hash: "h1" };
  const tap = (over: Partial<{ userId: string; chat: string; message: string; textHash: string }> & { id: string }) => ({
    userId: "tenant-a",
    chat: "555",
    message: "42",
    textHash: "h1",
    ...over,
  });

  it("mints ids that name nothing: 22 base64url characters, different each time", () => {
    const a = newPausePromptId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newPausePromptId()).not.toBe(a);
  });

  it("lets the agent go on from the message it was sent as, once", async () => {
    const id = newPausePromptId();
    await recordPausePrompt(id, prompt);
    expect(await pausePromptOpen("agent-a")).toBe(true);
    expect(await takePausePrompt(tap({ id }))).toBe("agent-a");
    expect(await pausePromptOpen("agent-a")).toBe(false);
    expect(await takePausePrompt(tap({ id }))).toBeNull();
  });

  it("refuses a look-alike: another message, chat, text or workspace, and keeps the real button good", async () => {
    const id = newPausePromptId();
    await recordPausePrompt(id, prompt);
    expect(await takePausePrompt(tap({ id, message: "43" }))).toBeNull();
    expect(await takePausePrompt(tap({ id, chat: "556" }))).toBeNull();
    expect(await takePausePrompt(tap({ id, textHash: "h2" }))).toBeNull();
    expect(await takePausePrompt(tap({ id, userId: "tenant-b" }))).toBeNull();
    expect(await takePausePrompt(tap({ id: "not-an-id" }))).toBeNull();
    expect(await takePausePrompt(tap({ id }))).toBe("agent-a");
  });
});

// L8b (1.6.0): the heads-up's "Suspend it now" button. Built like the lift's, under
// its own keys: a lift id must never be redeemable as a suspend, or the reverse, so
// a button for one can never be made to do the other.
describe("the stop prompt", () => {
  const prompt = { uid: "tenant-a", agid: "agent-a", chat: "555", msg: "42", hash: "h1" };
  const tap = (over: Record<string, string> = {}) => ({ userId: "tenant-a", chat: "555", message: "42", textHash: "h1", id: "", ...over });

  it("suspends from the message it was sent as, once, and says while it is out", async () => {
    const id = newPausePromptId();
    await recordStopPrompt(id, prompt);
    expect(await stopPromptOpen("agent-a")).toBe(true);
    expect(await pausePromptOpen("agent-a")).toBe(false);
    expect(await takeStopPrompt(tap({ id }))).toBe("agent-a");
    expect(await stopPromptOpen("agent-a")).toBe(false);
    expect(await takeStopPrompt(tap({ id }))).toBeNull();
  });

  it("refuses a look-alike and keeps the real button good", async () => {
    const id = newPausePromptId();
    await recordStopPrompt(id, prompt);
    for (const over of [{ message: "43" }, { chat: "556" }, { textHash: "h2" }, { userId: "tenant-b" }, { id: "short" }] as Record<string, string>[]) {
      expect(await takeStopPrompt(tap({ id, ...over }))).toBeNull();
    }
    expect(await takeStopPrompt(tap({ id }))).toBe("agent-a");
  });

  it("is never redeemable as a lift, and a lift's id never as a stop", async () => {
    const stop = newPausePromptId();
    const lift = newPausePromptId();
    await recordStopPrompt(stop, prompt);
    await recordPausePrompt(lift, prompt);
    expect(await takePausePrompt(tap({ id: stop }))).toBeNull();
    expect(await takeStopPrompt(tap({ id: lift }))).toBeNull();
    expect(await takeStopPrompt(tap({ id: stop }))).toBe("agent-a");
    expect(await takePausePrompt(tap({ id: lift }))).toBe("agent-a");
  });

  it("is out no longer than it is given, at most the button's twelve hours", async () => {
    await recordStopPrompt(newPausePromptId(), prompt, 3 * 3600);
    expect(store.get("pause_stop_open:agent-a")!.ex).toBe(3 * 3600);
    await recordStopPrompt(newPausePromptId(), prompt, 99 * 3600);
    expect(store.get("pause_stop_open:agent-a")!.ex).toBe(12 * 3600);
  });

  it("lets one call in ten seconds read the taps, per agent", async () => {
    expect(await claimStopPoll("agent-a")).toBe(true);
    expect(await claimStopPoll("agent-a")).toBe(false);
    expect(await claimStopPoll("agent-b")).toBe(true);
    expect(store.get("pause_stop_poll:agent-a")!.ex).toBe(10);
  });
});
