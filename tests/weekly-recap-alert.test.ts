import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/lib/recap", async (original) => ({
  ...await original<typeof import("@/lib/recap")>(), readWeeklyRecap: mocks.read,
}));
vi.mock("@/lib/state/redis", () => ({ redis: () => ({ set: mocks.set, get: mocks.get }) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => { throw new Error("unexpected client"); } }));

import { runWeeklyRecaps } from "@/lib/alerts/recap";
import { buildWeeklyRecap, weeklyRecapPeriod } from "@/lib/recap";

const MONDAY = new Date("2026-10-26T01:30:00Z");
const SLACK = "https://hooks.slack.com/services/" + "T123/B123/abcdefgh12345678";
const DISCORD = "https://discord.com/api/webhooks/" + "123456/abcdefghijklmnopqrstuv";
const TELEGRAM = "https://api.telegram.org/bot" + "123456:abcdefghijklmnopqrstuvwxyz123456/sendMessage?chat_id=-12345";
const fetchMock = vi.fn();
const held = new Map<string, number>();

type Config = { user_id: string; destination: string; url: string | null };
function database(rows: Config[]) {
  const reads: { table: string; columns: string; filters: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async (_name: string, args: { p_user_id: string }) => ({
    data: rows.find((r) => r.user_id === args.p_user_id)?.url ?? null, error: null,
  }));
  const from = vi.fn((table: string) => {
    const read = { table, columns: "", filters: {} as Record<string, unknown> };
    reads.push(read);
    const q = {
      select(columns: string) { read.columns = columns; return q; },
      eq(k: string, v: unknown) { read.filters[k] = v; return q; },
      order() { return q; },
      async range(start: number, end: number) {
        return { data: rows.slice(start, end + 1).map(({ user_id }) => ({ user_id })), error: null };
      },
      async maybeSingle() {
        const selected = rows.filter((r) => Object.entries(read.filters).every(([k, v]) => r[k as keyof Config] === v));
        // An omitted tenant predicate actually exposes another tenant's row.
        return { data: selected[0] ?? null, error: null };
      },
    };
    return q;
  });
  return { db: { from, rpc } as unknown as SupabaseClient, from, rpc, reads };
}
const config = (user_id: string, destination = "slack", url: string | null = SLACK): Config => ({ user_id, destination, url });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY);
  held.clear();
  mocks.get.mockImplementation(async (k: string) => (held.get(k) ?? 0) > Date.now() ? "1" : null);
  mocks.set.mockImplementation(async (k: string, _value: string, opts: { nx: boolean; ex: number }) => {
    if (opts.nx && (held.get(k) ?? 0) > Date.now()) return null;
    held.set(k, Date.now() + opts.ex * 1000);
    return "OK";
  });
  mocks.read.mockImplementation(async (uid: string, at: Date) => ({
    ...buildWeeklyRecap(weeklyRecapPeriod(at), []), text: `C6 recap for ${uid}`,
  }));
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("weekly recap delivery", () => {
  it.each([
    ["slack", SLACK, "text"], ["discord", DISCORD, "content"], ["telegram", TELEGRAM, "text"],
  ])("sends C6 text only to the workspace's own %s destination", async (kind, url, field) => {
    const { db, rpc, reads } = database([config("a", kind, url), config("b", "discord", DISCORD)]);
    expect(await runWeeklyRecaps(db, MONDAY)).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(mocks.read).toHaveBeenCalledWith("a", MONDAY);
    expect(mocks.read).toHaveBeenCalledWith("b", MONDAY);
    expect(rpc.mock.calls).toEqual([
      ["get_workspace_alert_url_for_user", { p_user_id: "a" }],
      ["get_workspace_alert_url_for_user", { p_user_id: "b" }],
    ]);
    expect(reads.filter((r) => r.columns !== "user_id")).toEqual([
      { table: "workspace_alerts", columns: "destination", filters: { user_id: "a" } },
      { table: "workspace_alerts", columns: "destination", filters: { user_id: "b" } },
    ]);
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0]![0]).toBe(kind === "telegram" ? TELEGRAM.split("?")[0] : url);
    expect(JSON.parse(String(calls[0]![1].body))[field]).toBe("C6 recap for a");
    expect(JSON.parse(String(calls[1]![1].body)).content).toBe("C6 recap for b");
    expect(calls.every(([, init]) => init.redirect === "manual")).toBe(true);
  });

  it("claims with SET NX through the next Monday, including concurrent cron runs", async () => {
    const { db } = database([config("a")]);
    const results = await Promise.all([runWeeklyRecaps(db, MONDAY), runWeeklyRecaps(db, MONDAY)]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenCalledWith("weekly_recap:a:2026-10-26T00:00:00.000Z", "1", { nx: true, ex: 599400 });
    await runWeeklyRecaps(db, MONDAY);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses separate workspace and week keys, expiring at the UTC boundary", async () => {
    const { db } = database([config("a"), config("b")]);
    vi.setSystemTime(new Date("2026-11-01T23:59:59.001Z"));
    await runWeeklyRecaps(db, new Date());
    expect(mocks.set).toHaveBeenCalledWith(expect.stringContaining("weekly_recap:a:"), "1", { nx: true, ex: 1 });
    vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
    await runWeeklyRecaps(db, new Date());
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(held.size).toBe(4);
  });

  it("does nothing successfully for no configured destinations", async () => {
    const { db, rpc } = database([]);
    expect(await runWeeklyRecaps(db, MONDAY)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips absent or invalid destinations without reading the recap or claiming", async () => {
    const { db } = database([config("a", "slack", null), config("b", "slack", DISCORD)]);
    expect(await runWeeklyRecaps(db, MONDAY)).toEqual({ sent: 0, skipped: 2, failed: 0 });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("retries an unavailable recap on a later daily run and sends empty weeks", async () => {
    const { db } = database([config("a")]);
    mocks.read.mockResolvedValueOnce({ state: "unavailable", text: null, period: weeklyRecapPeriod(MONDAY) });
    expect((await runWeeklyRecaps(db, MONDAY)).failed).toBe(1);
    expect(mocks.set).not.toHaveBeenCalled();
    const tuesday = new Date("2026-10-27T01:30:00Z");
    vi.setSystemTime(tuesday);
    mocks.read.mockResolvedValueOnce(buildWeeklyRecap(weeklyRecapPeriod(tuesday), []));
    expect((await runWeeklyRecaps(db, tuesday)).sent).toBe(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).text).toContain("No activity for");
  });

  it.each(["read", "redis", "send", "response", "vault", "settings"])("isolates a workspace's %s failure and never logs secrets", async (failure) => {
    const { db, rpc, from } = database([config("a"), config("b")]);
    const secret = "sk-" + "dontLogThisSecret";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    if (failure === "read") mocks.read.mockRejectedValueOnce(new Error(secret));
    if (failure === "redis") mocks.get.mockRejectedValueOnce(new Error(secret));
    if (failure === "send") fetchMock.mockRejectedValueOnce(new Error(secret));
    if (failure === "response") fetchMock.mockResolvedValueOnce(new Response(secret, { status: 500 }));
    if (failure === "vault") rpc.mockResolvedValueOnce({ data: null, error: { message: secret } } as never);
    if (failure === "settings") from.mockImplementationOnce(from.getMockImplementation()!).mockImplementationOnce(() => { throw new Error(secret); });
    expect(await runWeeklyRecaps(db, MONDAY)).toEqual({ sent: 1, skipped: 0, failed: 1 });
    expect(JSON.stringify(fetchMock.mock.calls.map((c) => c[1].body))).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("retains the claim after a send error to avoid repeating an ambiguous delivery", async () => {
    const { db } = database([config("a")]);
    fetchMock.mockRejectedValueOnce(new Error("reply lost"));
    expect((await runWeeklyRecaps(db, MONDAY)).failed).toBe(1);
    expect((await runWeeklyRecaps(db, MONDAY)).skipped).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("pages destination IDs without loading any unscoped settings or secrets", async () => {
    const { db, reads } = database(Array.from({ length: 501 }, (_, i) => config(`u${i}`, "slack", null)));
    expect((await runWeeklyRecaps(db, MONDAY)).skipped).toBe(501);
    expect(reads.filter((r) => r.columns === "user_id")).toHaveLength(2);
    expect(reads.filter((r) => r.columns !== "user_id").every((r) => typeof r.filters.user_id === "string")).toBe(true);
  });

  it("splits a long recap within Discord's limit without dropping C6 text", async () => {
    const { db } = database([config("a", "discord", DISCORD)]);
    const text = "line of recap\n".repeat(600);
    mocks.read.mockResolvedValueOnce({ ...buildWeeklyRecap(weeklyRecapPeriod(MONDAY), []), text });
    expect((await runWeeklyRecaps(db, MONDAY)).sent).toBe(1);
    const chunks = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1].body)).content as string);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((s) => s.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(mocks.set).toHaveBeenCalledOnce();
  });
});
