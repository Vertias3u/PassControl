// Conformance: the Lean model of the budget ledger (proofs/budget/Budget/Model.lean)
// against the REAL Lua on a REAL Redis through SRH.
//
// The proofs in proofs/budget are about a model. This file is what ties the model to
// the code: seeded random sequences go through the exported functions of
// lib/state/holds.ts, in concurrent bursts, and after every burst the real counters
// and hold records must equal what the model reaches for SOME order of that burst
// (each script is atomic, so some order is what really happened). The replies must
// match in that same order.
//
// The block marked MODEL mirrors Model.lean definition for definition. Change one,
// change the other. Money code is not fixed from here: a failure is reported.
import { describe, it, expect, afterEach } from "vitest";
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
const live = gate.run;
if (gate.fail) throw new Error(gate.fail);
if (!live) {
  // eslint-disable-next-line no-console
  console.warn(`[holds-model.redis.test] SKIPPED — no SRH at ${URL_}.`);
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const {
  openHold, settleKnown, settleUnknown, releaseUndispatched, resolveHold,
  consumeDispatchPermission, raiseSpentFloor,
} = await import("../lib/state/holds");
const { redis } = await import("../lib/state/redis");

// ── MODEL (mirrors proofs/budget/Budget/Model.lean) ─────────────────────────

type St = "opn" | "settled" | "released" | "resolved";
type Phase = "pre" | "dispatched";
interface Hold { st: St; ph: Phase; et: number; ec: number; appT: number; appC: number }
type Holds = [string, Hold][];

// def get
function get(hs: Holds, a: string): Hold | null {
  for (const [b, h] of hs) if (b === a) return h;
  return null;
}
// def put
function put(hs: Holds, a: string, h2: Hold): Holds {
  const out: Holds = [];
  let done = false;
  for (const [b, h] of hs) {
    if (!done && b === a) { out.push([b, h2]); done = true; } else out.push([b, h]);
  }
  return out;
}
// def del
function del(hs: Holds, a: string): Holds {
  const out: Holds = [];
  let done = false;
  for (const [b, h] of hs) {
    if (!done && b === a) done = true; else out.push([b, h]);
  }
  return out;
}
// def heldT / heldC / sumT / sumC
const heldT = (h: Hold) => (h.st === "opn" ? h.et : 0);
const heldC = (h: Hold) => (h.st === "opn" ? h.ec : 0);
const sumT = (hs: Holds) => hs.reduce((n, [, h]) => n + heldT(h), 0);
const sumC = (hs: Holds) => hs.reduce((n, [, h]) => n + heldC(h), 0);

interface State { reserved: number; spent: number; reservedCost: number; spentCost: number; holds: Holds }
const init: State = { reserved: 0, spent: 0, reservedCost: 0, spentCost: 0, holds: [] };

type Outcome =
  | { k: "complete"; tokensKnown: boolean; moneyKnown: boolean }
  | { k: "usageUnknown" } | { k: "notDispatched" } | { k: "resolved" };

// def charge
const charge = (known: number, est: number, certain: boolean) =>
  certain ? known : known > est ? known : est;
// def appliedT / appliedC
function appliedT(o: Outcome, known: number, est: number): number {
  switch (o.k) {
    case "complete": return charge(known, est, o.tokensKnown);
    case "usageUnknown": return charge(known, est, false);
    case "notDispatched": return 0;
    case "resolved": return known;
  }
}
function appliedC(o: Outcome, known: number, est: number): number {
  switch (o.k) {
    case "complete": return charge(known, est, o.moneyKnown);
    case "usageUnknown": return charge(known, est, false);
    case "notDispatched": return 0;
    case "resolved": return known;
  }
}
// def closeSt
const closeSt = (o: Outcome): St =>
  o.k === "notDispatched" ? "released" : o.k === "resolved" ? "resolved" : "settled";
// def capRefuses
const capRefuses = (cap: number | null, total: number) => cap !== null && (cap === 0 || total > cap);
// def settleable
function settleable(s: State, a: string, o: Outcome): Hold | null {
  const h = get(s.holds, a);
  if (h === null) return null;
  return h.st === "opn" && !(o.k === "notDispatched" && h.ph !== "pre") ? h : null;
}
// def Hold.close
const close = (h: Hold, o: Outcome, kt: number, kc: number): Hold =>
  ({ ...h, st: closeSt(o), appT: appliedT(o, kt, h.et), appC: appliedC(o, kc, h.ec) });

type Step =
  | { k: "openHold"; a: string; tokenCap: number | null; costCap: number | null; et: number; ec: number }
  | { k: "settle"; a: string; o: Outcome; knownT: number; knownC: number }
  | { k: "dispatch"; a: string }
  | { k: "raise"; floorT: number; floorC: number }
  | { k: "expire"; a: string };

// def step
function step(s: State, x: Step): State {
  switch (x.k) {
    case "openHold": {
      if (get(s.holds, x.a) !== null) return s;
      if (capRefuses(x.tokenCap, s.reserved + x.et + s.spent)) return s;
      if (capRefuses(x.costCap, s.reservedCost + x.ec + s.spentCost)) return s;
      return {
        ...s,
        reserved: s.reserved + x.et,
        reservedCost: s.reservedCost + x.ec,
        holds: [[x.a, { st: "opn", ph: "pre", et: x.et, ec: x.ec, appT: 0, appC: 0 }], ...s.holds],
      };
    }
    case "settle": {
      const h = settleable(s, x.a, x.o);
      if (h === null) return s;
      return {
        reserved: s.reserved - h.et,
        spent: s.spent + appliedT(x.o, x.knownT, h.et),
        reservedCost: s.reservedCost - h.ec,
        spentCost: s.spentCost + appliedC(x.o, x.knownC, h.ec),
        holds: put(s.holds, x.a, close(h, x.o, x.knownT, x.knownC)),
      };
    }
    case "dispatch": {
      const h = get(s.holds, x.a);
      if (h === null) return s;
      return h.st === "opn" && h.ph === "pre"
        ? { ...s, holds: put(s.holds, x.a, { ...h, ph: "dispatched" }) }
        : s;
    }
    case "raise":
      return {
        ...s,
        spent: x.floorT > s.spent ? x.floorT : s.spent,
        spentCost: x.floorC > s.spentCost ? x.floorC : s.spentCost,
      };
    case "expire": {
      const h = get(s.holds, x.a);
      if (h === null) return s;
      return h.st === "opn" ? s : { ...s, holds: del(s.holds, x.a) };
    }
  }
}

// ── END MODEL ───────────────────────────────────────────────────────────────

// What the real function must ANSWER for a step taken in model state `s`. Not part
// of the proved model (the proofs are about state); read off the scripts' return
// codes so the linearisation is pinned by replies as well as by the final state.
function expectedReply(s: State, x: Step): string {
  switch (x.k) {
    case "openHold": {
      if (get(s.holds, x.a) !== null) return `open:replay:${s.reserved}:${s.reservedCost}`;
      if (capRefuses(x.tokenCap, s.reserved + x.et + s.spent)) return "open:deny:tokens";
      if (capRefuses(x.costCap, s.reservedCost + x.ec + s.spentCost)) return "open:deny:cost";
      return `open:ok:${s.reserved + x.et}:${s.reservedCost + x.ec}`;
    }
    case "settle": {
      const h = get(s.holds, x.a);
      if (h === null) return "settle:anomaly";
      if (h.st !== "opn") return `settle:replay:${h.appT}:${h.appC}`;
      if (x.o.k === "notDispatched" && h.ph !== "pre") return "settle:conflict";
      return `settle:applied:${appliedT(x.o, x.knownT, h.et)}:${appliedC(x.o, x.knownC, h.ec)}`;
    }
    case "dispatch": {
      const h = get(s.holds, x.a);
      if (h === null) return "dispatch:missing";
      if (h.st !== "opn") return "dispatch:terminal";
      return h.ph === "pre" ? "dispatch:granted" : "dispatch:already_dispatched";
    }
    case "raise":
      return `raise:${x.floorT > s.spent || x.floorC > s.spentCost}`;
    case "expire":
      return "expire";
  }
}

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

async function realReply(agentId: string, epoch: string, x: Step): Promise<string> {
  switch (x.k) {
    case "openHold": {
      const r = await openHold({
        agentId, attemptId: x.a, estimate: x.et, estimateMicrocents: x.ec,
        capTokens: x.tokenCap, capMicrocents: x.costCap,
        budgetState: { epoch, established: true }, nowMs: NOW,
      });
      if (!r.ok) return `open:deny:${r.reason ?? "?"}`;
      return `open:${r.replay ? "replay" : "ok"}:${r.reserved}:${r.reservedMicrocents}`;
    }
    case "settle": {
      const p = { agentId, attemptId: x.a, tokens: x.knownT, microcents: x.knownC };
      const r =
        x.o.k === "complete"
          ? await settleKnown({
              ...p, nowMs: NOW,
              tokenCertainty: x.o.tokensKnown ? "known" : "unknown",
              moneyCertainty: x.o.moneyKnown ? "known" : "unknown",
            })
          : x.o.k === "usageUnknown" ? await settleUnknown({ ...p, nowMs: NOW })
          : x.o.k === "notDispatched" ? await releaseUndispatched({ agentId, attemptId: x.a })
          : await resolveHold(p);
      if (r.anomaly) return "settle:anomaly";
      if (r.conflict) return "settle:conflict";
      if (r.degraded) return "settle:degraded";
      return `settle:${r.applied ? "applied" : "replay"}:${r.appliedTokens}:${r.appliedMicrocents}`;
    }
    case "dispatch": {
      const r = await consumeDispatchPermission({ agentId, attemptId: x.a });
      return `dispatch:${r.granted ? "granted" : r.reason}`;
    }
    case "raise": {
      const r = await raiseSpentFloor({ agentId, tokens: x.floorT, microcents: x.floorC });
      return `raise:${r.raised}`;
    }
    case "expire":
      throw new Error("expire is driven by the test, never fired in a burst");
  }
}

const holdKey = (agid: string, a: string) => `hold:${agid}:${a}`;

/** The real ledger, in the model's vocabulary. */
async function readReal(agid: string, ids: string[]): Promise<State> {
  const r = redis();
  const [reserved, spent, reservedCost, spentCost] = await r.mget<(number | string | null)[]>(
    `reserved:${agid}`, `spent:${agid}`, `reserved_cost:${agid}`, `spent_cost:${agid}`
  );
  const p = r.pipeline();
  for (const a of ids) p.hgetall(holdKey(agid, a));
  const recs = (await p.exec()) as (Record<string, unknown> | null)[];
  const holds: Holds = [];
  ids.forEach((a, i) => {
    const h = recs[i];
    if (!h || Object.keys(h).length === 0) return;
    const st = String(h.st);
    holds.push([a, {
      st: st === "open" ? "opn" : (st as St),
      ph: String(h.ph) === "pre_dispatch" ? "pre" : "dispatched",
      et: Number(h.et), ec: Number(h.ec),
      appT: Number(h.at ?? 0), appC: Number(h.ac ?? 0),
    }]);
  });
  // A missing counter must not read as zero here: NaN never equals the model.
  const n = (v: unknown) => (v === null || v === undefined ? NaN : Number(v));
  return { reserved: n(reserved), spent: n(spent), reservedCost: n(reservedCost), spentCost: n(spentCost), holds };
}

/** Order-free projection of a state, for comparison. */
function canon(s: State, ids: string[]): string {
  return JSON.stringify({
    reserved: s.reserved, spent: s.spent, reservedCost: s.reservedCost, spentCost: s.spentCost,
    holds: ids.map((a) => [a, get(s.holds, a)]),
  });
}

function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length <= 1) { yield xs; return; }
  for (let i = 0; i < xs.length; i++) {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) yield [xs[i]!, ...rest];
  }
}

/** The model state after `burst` in some order that explains every reply and the real state, or null. */
function linearise(s: State, burst: Step[], replies: string[], real: string, ids: string[]): State | null {
  for (const order of permutations(burst.map((_, i) => i))) {
    let cur = s;
    let ok = true;
    for (const i of order) {
      if (expectedReply(cur, burst[i]!) !== replies[i]) { ok = false; break; }
      cur = step(cur, burst[i]!);
    }
    if (ok && canon(cur, ids) === real) return cur;
  }
  return null;
}

// Seeded, so a failure names a seed that reproduces it.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const used: string[] = [];
afterEach(async () => {
  const r = redis();
  for (const agid of used.splice(0)) {
    const keys = await r.keys(`hold:${agid}:*`);
    await r.del(`reserved:${agid}`, `spent:${agid}`, `reserved_cost:${agid}`, `spent_cost:${agid}`,
      `holds:${agid}`, `epoch:${agid}`, `acctfmt:${agid}`, `pbase:${agid}`, ...keys);
  }
});

const SEEDS = 40;
const BURSTS = 16;
const INIT = "init";
const seen: Record<string, number> = {};

async function runSeed(seed: number): Promise<void> {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: T[]): T => xs[int(0, xs.length - 1)]!;
  // Amounts lean on the edges (0, 1, the top of the range) a fifth of the time: a
  // mutation that only misbehaves at exactly 1 survived uniform draws (review, 2026-11-10).
  const amount = (hi: number) => (rnd() < 0.2 ? pick([0, 1, hi]) : int(0, hi));

  const agid = `test-${crypto.randomUUID()}`;
  used.push(agid);
  const pool = ["a1", "a2", "a3", "a4", "a5"];
  const ids = [INIT, ...pool];

  // The agent's caps for this sequence. Mostly fixed, as a policy is; sometimes a
  // call carries a different one, as it does when the owner edits the budget.
  const tokenCap = pick<number | null>([null, 0, 60, 120, 200]);
  const costCap = pick<number | null>([null, 0, 6000, 12000, 20000]);

  // First initialisation (out of scope for the proofs) mints the generation and
  // seeds the four counters. It is itself an open of an empty, uncapped hold.
  const first = await openHold({
    agentId: agid, attemptId: INIT, estimate: 0, estimateMicrocents: 0,
    capTokens: null, capMicrocents: null, budgetState: { epoch: null, established: false }, nowMs: NOW,
  });
  expect(first.ok).toBe(true);
  const epoch = first.epochToPersist!;
  let model = step(init, { k: "openHold", a: INIT, tokenCap: null, costCap: null, et: 0, ec: 0 });
  expect(canon(await readReal(agid, ids), ids)).toBe(canon(model, ids));

  const genOutcome = (): Outcome =>
    pick<Outcome>([
      { k: "complete", tokensKnown: true, moneyKnown: true },
      { k: "complete", tokensKnown: true, moneyKnown: false },
      { k: "complete", tokensKnown: rnd() < 0.5, moneyKnown: rnd() < 0.5 },
      { k: "usageUnknown" }, { k: "notDispatched" }, { k: "notDispatched" }, { k: "resolved" },
    ]);
  const genStep = (): Step => {
    const roll = rnd();
    const a = pick(pool);
    if (roll < 0.4) {
      return {
        k: "openHold", a,
        tokenCap: rnd() < 0.9 ? tokenCap : pick<number | null>([null, 0, 90]),
        costCap: rnd() < 0.9 ? costCap : pick<number | null>([null, 0, 9000]),
        et: amount(50), ec: amount(5000),
      };
    }
    if (roll < 0.68) return { k: "settle", a, o: genOutcome(), knownT: amount(70), knownC: amount(7000) };
    if (roll < 0.9) return { k: "dispatch", a };
    return { k: "raise", floorT: int(0, 150), floorC: int(0, 15000) };
  };

  for (let b = 0; b < BURSTS; b++) {
    // Time passing: a closed record's TTL fires. An open one has no TTL to fire.
    if (rnd() < 0.25) {
      const a = pick(pool);
      const h = get(model.holds, a);
      if (h !== null) {
        const ttl = await redis().ttl(holdKey(agid, a));
        if (h.st === "opn") expect(ttl, `seed ${seed}: an open hold carries a TTL`).toBe(-1);
        else {
          expect(ttl, `seed ${seed}: a closed hold has no TTL`).toBeGreaterThan(0);
          await redis().del(holdKey(agid, a));
        }
      }
      model = step(model, { k: "expire", a });
      seen.expire = (seen.expire ?? 0) + 1;
    }

    const burst: Step[] = [];
    const size = int(1, 4);
    for (let i = 0; i < size; i++) {
      // A replay: the very same step again, in the same burst.
      if (burst.length > 0 && rnd() < 0.3) burst.push(pick(burst));
      else burst.push(genStep());
    }
    const replies = await Promise.all(burst.map((x) => realReply(agid, epoch, x)));
    for (const r of replies) {
      const kind = r.split(":").slice(0, 2).join(":");
      seen[kind] = (seen[kind] ?? 0) + 1;
    }
    const real = await readReal(agid, ids);
    const next = linearise(model, burst, replies, canon(real, ids), ids);
    if (next === null) {
      throw new Error(
        `seed ${seed}, burst ${b}: the real ledger did something the model does not allow.\n` +
        `before: ${canon(model, ids)}\nburst: ${JSON.stringify(burst)}\n` +
        `replies: ${JSON.stringify(replies)}\nreal after: ${canon(real, ids)}`
      );
    }
    model = next;

    // The proved properties, read straight off the real keys.
    expect(real.reserved, `seed ${seed}: conservation (tokens)`).toBe(sumT(real.holds));
    expect(real.reservedCost, `seed ${seed}: conservation (cost)`).toBe(sumC(real.holds));
  }
}

describe.skipIf(!live)("budget ledger conforms to the Lean model (real Redis)", () => {
  it("every burst is explained by some order of the model's steps", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) await runSeed(seed);
    // Not vacuous: each kind of answer was actually exercised.
    for (const kind of [
      "open:ok", "open:replay", "open:deny", "settle:applied", "settle:replay", "settle:anomaly",
      "settle:conflict", "dispatch:granted", "dispatch:already_dispatched", "dispatch:terminal",
      "dispatch:missing", "raise:true", "raise:false", "expire",
    ]) {
      expect(seen[kind] ?? 0, `never exercised: ${kind}`).toBeGreaterThan(0);
    }
  }, 300_000);

  it("the checker can fail: a settle the model does not allow is rejected", () => {
    // A hold of 10 released in full while the counters say nothing was released.
    const s = step(init, { k: "openHold", a: "x", tokenCap: null, costCap: null, et: 10, ec: 100 });
    const burst: Step[] = [{ k: "settle", a: "x", o: { k: "notDispatched" }, knownT: 0, knownC: 0 }];
    const wrong: State = { ...s, holds: put(s.holds, "x", { ...get(s.holds, "x")!, st: "released" }) };
    expect(linearise(s, burst, ["settle:applied:0:0"], canon(wrong, ["x"]), ["x"])).toBeNull();
    expect(linearise(s, burst, ["settle:applied:0:0"], canon(step(s, burst[0]!), ["x"]), ["x"])).not.toBeNull();
  });
});
