// Recording what the injection guard found (plans/injection-guard.md §4–§5, Phase 1).
//
// A coding agent re-sends the whole conversation on every call, so one injected tool
// result arrives again at every later turn. Only a block not seen before may become a
// row, or the table fills with copies and (in Phase 2) the owner's "clear" would be undone
// by the very next call. Redis remembers what was seen; the table's unique index is the
// backstop when Redis forgets or fails.
import { describe, expect, it, vi } from "vitest";

import { recordInjectionFindings, type FindingsDb, type SeenStore } from "@/lib/injection-findings";
import type { InjectionFinding } from "@/lib/injection-guard";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const finding = (n: number, over: Partial<InjectionFinding> = {}): InjectionFinding => ({
  path: `messages[${n}].content[0].content`,
  source: "tool_result",
  families: ["instruction_override"],
  severity: "high",
  contentHmac: n.toString(16).padStart(64, "0"),
  ...over,
});

/** A Redis stand-in with SET NX semantics, optionally broken. */
function seenStore(broken = false, { releaseBroken = false } = {}): SeenStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    async claim(key) {
      if (broken) throw new Error("redis down");
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
    async release(key) {
      if (broken || releaseBroken) throw new Error("redis down");
      keys.delete(key);
    },
  };
}

// `existing`: HMACs the table already holds, which its unique index ignores; `select`
// then returns only the rows inserted, as PostgREST does with ignoreDuplicates.
function db(error: { code?: string; message?: string } | null = null, existing = new Set<string>()) {
  const upsert = vi.fn((rows: unknown[], _opts: unknown) => ({
    select: async (_columns: string) =>
      error
        ? { data: null, error }
        : {
            data: (rows as { content_hmac: string }[]).filter((r) => !existing.has(r.content_hmac)).map((r) => ({ content_hmac: r.content_hmac })),
            error: null,
          },
  }));
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ error: null }));
  const client: FindingsDb = { from: () => ({ upsert }), rpc };
  return { client, upsert, rpc };
}

const base = { userId: USER, agentId: AGENT, provider: "anthropic", model: "claude-haiku-4-5" };

describe("recordInjectionFindings", () => {
  it("writes a new block as one row, with no text in it", async () => {
    const { client, upsert } = db();
    const out = await recordInjectionFindings({ db: client, seen: seenStore(), ...base, findings: [finding(1)] });
    expect(out).toEqual({ state: "recorded", recorded: [finding(1)] });
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0]!;
    expect(rows).toEqual([
      {
        user_id: USER,
        agent_id: AGENT,
        surface: "proxy",
        source: "tool_result",
        path: "messages[1].content[0].content",
        families: ["instruction_override"],
        severity: "high",
        detector: "pc-heuristic-1",
        normalization_version: 1,
        content_hmac: finding(1).contentHmac,
        provider: "anthropic",
        model: "claude-haiku-4-5",
      },
    ]);
    expect(opts).toEqual({ onConflict: "user_id,agent_id,content_hmac,detector", ignoreDuplicates: true });
  });

  it("the same block re-sent on the next call writes nothing", async () => {
    const { client, upsert } = db();
    const seen = seenStore();
    await recordInjectionFindings({ db: client, seen, ...base, findings: [finding(1)] });
    const again = await recordInjectionFindings({ db: client, seen, ...base, findings: [finding(1), finding(2)] });
    expect(again).toEqual({ state: "recorded", recorded: [finding(2)] });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1]![0]).toHaveLength(1);
  });

  it("nothing new is no write at all", async () => {
    const { client, upsert } = db();
    const seen = seenStore();
    await recordInjectionFindings({ db: client, seen, ...base, findings: [finding(1)] });
    expect(await recordInjectionFindings({ db: client, seen, ...base, findings: [finding(1)] })).toEqual({ state: "nothing_new" });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("the seen-key is per agent and per detector, and carries only the HMAC", async () => {
    const seen = seenStore();
    await recordInjectionFindings({ db: db().client, seen, ...base, findings: [finding(1)] });
    expect([...seen.keys].filter((k) => k.startsWith("injection_seen:"))).toEqual([`injection_seen:${AGENT}:pc-heuristic-1:${finding(1).contentHmac}`]);
  });

  it("Redis down: every finding goes to the table, whose unique index de-duplicates", async () => {
    const { client, upsert } = db();
    const out = await recordInjectionFindings({ db: client, seen: seenStore(true), ...base, findings: [finding(1), finding(2)] });
    expect(out).toEqual({ state: "recorded", recorded: [finding(1), finding(2)] });
    expect(upsert.mock.calls[0]![0]).toHaveLength(2);
  });

  it.each([
    ["42P01", { code: "42P01" }],
    ["PGRST205", { code: "PGRST205" }],
  ])("a database before 0089 (%s) is reported, never thrown", async (_code, error) => {
    const out = await recordInjectionFindings({ db: db(error).client, seen: seenStore(), ...base, findings: [finding(1)] });
    expect(out).toEqual({ state: "unavailable", unrecorded: [finding(1)] });
  });

  it("any other write error is reported, never thrown", async () => {
    const out = await recordInjectionFindings({ db: db({ code: "23514" }).client, seen: seenStore(), ...base, findings: [finding(1)] });
    expect(out).toEqual({ state: "failed", unrecorded: [finding(1)] });
  });

  it.each([
    ["failed", { code: "23514" }],
    ["unavailable", { code: "PGRST204" }],
  ])("a write that is %s gives its claims back, so the next sighting is recorded", async (state, error) => {
    const seen = seenStore();
    expect(await recordInjectionFindings({ db: db(error).client, seen, ...base, findings: [finding(1), finding(2)] })).toEqual({
      state,
      unrecorded: [finding(1), finding(2)],
    });
    expect([...seen.keys].filter((k) => k.startsWith("injection_seen:"))).toEqual([]);
    const { client, upsert } = db();
    const out = await recordInjectionFindings({ db: client, seen, ...base, findings: [finding(1), finding(2)] });
    expect(out).toEqual({ state: "recorded", recorded: [finding(1), finding(2)] });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("a claim that cannot be given back is still reported, never thrown", async () => {
    const seen = seenStore(false, { releaseBroken: true });
    const out = await recordInjectionFindings({ db: db({ code: "23514" }).client, seen, ...base, findings: [finding(1)] });
    expect(out).toEqual({ state: "failed", unrecorded: [finding(1)] });
  });

  it("a block whose row already exists is not new, even when its Redis key has expired", async () => {
    // The owner cleared a taint a day ago; the same block arrives again. Redis no longer
    // remembers it, the table does, and the hold must not count it again.
    const { client, upsert } = db(null, new Set([finding(1).contentHmac]));
    const out = await recordInjectionFindings({ db: client, seen: seenStore(), ...base, findings: [finding(1), finding(2)] });
    expect(out).toEqual({ state: "recorded", recorded: [finding(2)] });
    expect(upsert.mock.calls[0]![0]).toHaveLength(2);
    expect(await recordInjectionFindings({ db: db(null, new Set([finding(3).contentHmac])).client, seen: seenStore(), ...base, findings: [finding(3)] })).toEqual({
      state: "nothing_new",
    });
  });

  it("ages the agent's old rows out at most once a day, after a write", async () => {
    const { client, rpc } = db();
    const seen = seenStore();
    await recordInjectionFindings({ db: client, seen, ...base, findings: [finding(1)] });
    await recordInjectionFindings({ db: client, seen, ...base, findings: [finding(2)] });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("prune_injection_findings", { p_agent_id: AGENT, p_user_id: USER });
  });

  it("no findings is a no-op", async () => {
    const { client, upsert, rpc } = db();
    expect(await recordInjectionFindings({ db: client, seen: seenStore(), ...base, findings: [] })).toEqual({ state: "nothing_new" });
    expect(upsert).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a model name the table would refuse is dropped, not the row", async () => {
    const { client, upsert } = db();
    await recordInjectionFindings({ db: client, seen: seenStore(), ...base, model: "bad model; drop", findings: [finding(1)] });
    expect((upsert.mock.calls[0]![0] as { model: unknown }[])[0]!.model).toBeNull();
  });
});
