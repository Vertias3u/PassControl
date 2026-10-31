// Injection guard Phase 2: the taint store and when a finding taints, run against a REAL
// Redis through SRH (plans/injection-guard.md §4).
//
// What it must guarantee, each one a way the hold could be useless or unclearable:
//   - a taint ends on its own (TTL), and is per agent;
//   - only a NEW high block taints or extends it: a re-sent block never does, so a long
//     conversation is not tainted for as long as it runs;
//   - after the owner's Clear, the same block sent again does not re-taint, even when
//     the day-long seen-key has expired (the row in the table is what remembers it);
//   - a new hostile block after Clear does taint;
//   - monitor mode never taints, and a low finding never does.
//
// Needs the local stack (docker compose -f docker/compose.yml up -d); skips loudly
// when SRH is unreachable, fails the lane on CI.
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
  console.warn(`[taint.redis.test] SKIPPED: no SRH at ${URL_}.`);
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
process.env.VISA_SECRET ??= "test-visa-secret-0123456789abcdef0123456789abcdef";
const taint = await import("../lib/state/taint");
const findings = await import("../lib/injection-findings");
const { redis } = await import("../lib/state/redis");

const agents: string[] = [];
function agent(): string {
  const id = `taint-test-${crypto.randomUUID()}`;
  agents.push(id);
  return id;
}

afterEach(async () => {
  if (!gate.run) return;
  for (const id of agents.splice(0)) {
    const keys = await redis().keys(`*${id}*`);
    if (keys.length) await redis().del(...keys);
  }
});

// The table's unique index, (user_id, agent_id, content_hmac, detector): a duplicate is
// ignored, and `select` returns only the rows actually inserted, as PostgREST does.
function fakeTable() {
  const rows = new Set<string>();
  return {
    rows,
    db: {
      from() {
        return {
          upsert(batch: Array<Record<string, string>>) {
            const inserted = batch.filter((r) => {
              const k = `${r.user_id}|${r.agent_id}|${r.content_hmac}|${r.detector}`;
              if (rows.has(k)) return false;
              rows.add(k);
              return true;
            });
            return {
              select: async () => ({ data: inserted.map((r) => ({ content_hmac: r.content_hmac })), error: null }),
            };
          },
        };
      },
      rpc: async () => ({ error: null }),
    },
  };
}

type Finding = import("../lib/injection-guard").InjectionFinding;
const high = (hmac: string): Finding => ({
  path: "messages[3].content[0].content",
  source: "tool_result",
  families: ["instruction_override"],
  severity: "high",
  contentHmac: hmac,
});
const low = (hmac: string): Finding => ({ ...high(hmac), families: ["authority_claim"], severity: "low" });

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);

/** One call's findings through the record step and the taint step, as the routes do it. */
async function call(table: ReturnType<typeof fakeTable>, agentId: string, list: Finding[], mode: "monitor" | "hold", now: number) {
  const outcome = await findings.recordInjectionFindings({
    db: table.db as never,
    seen: findings.redisSeenStore(),
    userId: "user-1",
    agentId,
    provider: "anthropic",
    model: "claude-test",
    findings: list,
  });
  return taint.taintFromFindings({ agentId, mode, outcome, surface: "proxy", now });
}

describe.skipIf(!gate.run)("the taint store", () => {
  it("is empty for an agent never tainted", async () => {
    expect(await taint.readTaint(agent(), T0)).toBeNull();
  });

  it("taints for 30 minutes, with a TTL on the key, and only that agent", async () => {
    const a = agent();
    const b = agent();
    const set = await taint.taintAgent(a, { families: ["instruction_override"], surface: "proxy" }, T0);
    expect(set).toMatchObject({ since: T0, until: T0 + 30 * 60_000, families: ["instruction_override"], surface: "proxy" });
    expect(await taint.readTaint(a, T0 + 1000)).toMatchObject({ until: T0 + 30 * 60_000 });
    const ttl = Number(await redis().ttl(taint.taintKey(a)));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30 * 60);
    expect(await taint.readTaint(b, T0)).toBeNull();
  });

  it("a later taint extends the end, keeps the start, and adds the families", async () => {
    const a = agent();
    await taint.taintAgent(a, { families: ["instruction_override"], surface: "proxy" }, T0);
    const later = await taint.taintAgent(a, { families: ["exfil_directive"], surface: "sidecar" }, T0 + 10 * 60_000);
    expect(later).toMatchObject({ since: T0, until: T0 + 40 * 60_000, surface: "sidecar" });
    expect(later.families).toEqual(["instruction_override", "exfil_directive"]);
  });

  it("reads a taint whose end has passed as none", async () => {
    const a = agent();
    await taint.taintAgent(a, { families: ["hidden_text"], surface: "proxy" }, T0);
    expect(await taint.readTaint(a, T0 + 31 * 60_000)).toBeNull();
  });

  it("clears, and says whether there was one to clear", async () => {
    const a = agent();
    await taint.taintAgent(a, { families: ["hidden_text"], surface: "proxy" }, T0);
    expect(await taint.clearTaint(a)).toBe(true);
    expect(await taint.readTaint(a, T0)).toBeNull();
    expect(await taint.clearTaint(a)).toBe(false);
  });

  it("throws on a stored value it cannot read, so each caller applies its own posture", async () => {
    const a = agent();
    await redis().set(taint.taintKey(a), "not json", { ex: 60 });
    await expect(taint.readTaint(a, T0)).rejects.toThrow();
  });
});

describe.skipIf(!gate.run)("only a new high block taints", () => {
  it("a new high finding in hold mode taints the agent", async () => {
    const a = agent();
    const t = await call(fakeTable(), a, [high("h1")], "hold", T0);
    expect(t).toMatchObject({ until: T0 + 30 * 60_000 });
    expect(await taint.readTaint(a, T0)).not.toBeNull();
  });

  it("monitor mode records but never taints, and a low finding never taints", async () => {
    const a = agent();
    const table = fakeTable();
    expect(await call(table, a, [high("h1")], "monitor", T0)).toBeNull();
    expect(await call(table, a, [low("l1")], "hold", T0)).toBeNull();
    expect(await taint.readTaint(a, T0)).toBeNull();
    expect(table.rows.size).toBe(2);
  });

  it("a re-sent block does not extend the taint", async () => {
    const a = agent();
    const table = fakeTable();
    await call(table, a, [high("h1")], "hold", T0);
    expect(await call(table, a, [high("h1")], "hold", T0 + 20 * 60_000)).toBeNull();
    expect(await taint.readTaint(a, T0 + 20 * 60_000)).toMatchObject({ until: T0 + 30 * 60_000 });
  });

  it("after Clear, the same block sent again does not re-taint", async () => {
    const a = agent();
    const table = fakeTable();
    await call(table, a, [high("h1")], "hold", T0);
    await taint.clearTaint(a);
    expect(await call(table, a, [high("h1")], "hold", T0 + 60_000)).toBeNull();
    expect(await taint.readTaint(a, T0 + 60_000)).toBeNull();
  });

  it("after Clear, the same block does not re-taint even once the day-long seen-key has expired", async () => {
    const a = agent();
    const table = fakeTable();
    await call(table, a, [high("h1")], "hold", T0);
    await taint.clearTaint(a);
    await redis().del(findings.seenKey(a, "h1"));
    expect(await call(table, a, [high("h1")], "hold", T0 + 25 * 3600_000)).toBeNull();
    expect(await taint.readTaint(a, T0 + 25 * 3600_000)).toBeNull();
  });

  it("after Clear, a NEW hostile block does taint", async () => {
    const a = agent();
    const table = fakeTable();
    await call(table, a, [high("h1")], "hold", T0);
    await taint.clearTaint(a);
    expect(await call(table, a, [high("h1"), high("h2")], "hold", T0 + 60_000)).toMatchObject({ since: T0 + 60_000 });
  });
});
