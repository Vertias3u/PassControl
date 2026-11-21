// Mission-bound visas (idea 11): the mission DOCUMENT.
//
// A mission is one job's authority, fixed and approved by the owner BEFORE the agent
// reads anything hostile: goal, exact models, exact service methods and paths,
// local-tool items, a money cap, a time window and a sub-agent count. It is bound to
// one tenant and one agent, carries a nonce so an old approval cannot be replayed as
// a new mission, has one canonical form, and is identified by a domain-separated
// SHA-256 of that form. The owner signs that hash with a key registered to their
// account, never with the agent's passport key.
//
// Pure and edge-safe: @noble only, no node:crypto.
//
// ── What a mission does NOT do (say this wherever a mission is described) ──────
// It limits what a hijacked agent can REACH. It does not stop prompt injection:
// content the agent reads can still steer it to misuse something INSIDE the
// envelope, e.g. a permitted repository can receive bad content. And the `tools`
// section is enforced by a local hook, which is a guard rail, not a boundary.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { utf8ToBytes } from "@/lib/encoding";
import { isServiceId } from "@/lib/services/catalog";
import { parseServiceRules } from "@/lib/services/rules";
import { parseToolItem, toolItemContains, toolItemKey } from "@/cli/mission-tools.mjs";

export const MISSION_VERSION = 1;
/** One job, not a standing grant: a week at most. */
export const MISSION_MAX_LIFETIME_S = 7 * 24 * 3600;
export const MISSION_MAX_ITEMS = 200;
export const MISSION_GOAL_MAX = 1000;
/** Hash input prefix. A mission hash can never collide with another signed object. */
const HASH_DOMAIN = "passcontrol-mission-v1\n";
// What the owner approves is a TRANSITION, not this hash alone, and with a passkey:
// the hosted approval flow.

export type MissionServiceMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "CALL";
export interface MissionModel {
  provider: string;
  model: string;
}
export interface MissionService {
  service: string;
  method: MissionServiceMethod;
  path: string;
}
export type MissionToolItem =
  | { kind: "workspace"; root: string; write: boolean }
  | { kind: "shell"; class: string }
  | { kind: "host"; host: string; via: "web" | "browser" | "shell" }
  | { kind: "tool"; name: string }
  | { kind: "memory_write" };

export interface MissionDocument {
  v: 1;
  goal: string;
  tenant: string;
  agent: string;
  nonce: string;
  starts: number;
  expires: number;
  /** Micro-cents for the whole job, every model call under it. */
  money: number;
  /** Delegated workers (and local Agent spawns) the job may start, in total. */
  subagents: number;
  models: MissionModel[];
  services: MissionService[];
  tools: MissionToolItem[];
}

export type MissionParse = { ok: true; mission: MissionDocument } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/u;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
// Exact model ids only. A wildcard here would be a standing grant, not a job.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const TOP_KEYS = "agent,expires,goal,models,money,nonce,services,starts,subagents,tenant,tools,v";
const MAX_SAFE_MONEY = 1_000_000 * 100 * 1_000_000; // $1,000,000 in micro-cents

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const nonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("non-integer number in a mission");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  throw new Error("non-JSON value in a mission");
}

/** A set: sorted by canonical form, duplicates collapsed. Order never changes a hash. */
function asSet<T>(items: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(canonicalJson(item), item);
  return [...byKey.keys()].sort().map((k) => byKey.get(k)!);
}

function parseService(raw: unknown): MissionService | null {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== "method,path,service") return null;
  const { service, method, path } = raw;
  if (!isServiceId(service) || typeof path !== "string" || typeof method !== "string") return null;
  // The exact pattern language and write rules of the service route (lib/services/rules.ts):
  // validated by its own parser, so a mission can never express what a rule cannot.
  const rule = method === "CALL" ? { call: path } : { method, path };
  const read = parseServiceRules({ [service]: { allow: [rule] } }, service);
  if (read.kind !== "rules" || read.rules.allow.length !== 1) return null;
  const parsed = read.rules.allow[0]!;
  if (method === "CALL" ? parsed.method !== "CALL" : parsed.method !== method) return null;
  return { service, method: method as MissionServiceMethod, path };
}

/** Strict parse. Any unknown key, type or value refuses the whole document. */
export function parseMission(raw: unknown): MissionParse {
  try {
    if (!isRecord(raw)) return { ok: false, reason: "not_object" };
    if (Object.keys(raw).sort().join(",") !== TOP_KEYS) return { ok: false, reason: "keys" };
    if (raw.v !== MISSION_VERSION) return { ok: false, reason: "version" };
    if (typeof raw.goal !== "string" || raw.goal.trim() === "" || raw.goal.length > MISSION_GOAL_MAX) {
      return { ok: false, reason: "goal" };
    }
    if (/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/u.test(raw.goal)) return { ok: false, reason: "goal_controls" };
    if (typeof raw.tenant !== "string" || !UUID.test(raw.tenant)) return { ok: false, reason: "tenant" };
    if (typeof raw.agent !== "string" || !UUID.test(raw.agent)) return { ok: false, reason: "agent" };
    if (typeof raw.nonce !== "string" || !NONCE.test(raw.nonce)) return { ok: false, reason: "nonce" };
    if (!nonNegInt(raw.starts) || !nonNegInt(raw.expires) || raw.expires <= raw.starts) return { ok: false, reason: "window" };
    if (raw.expires - raw.starts > MISSION_MAX_LIFETIME_S) return { ok: false, reason: "lifetime" };
    if (!nonNegInt(raw.money) || raw.money > MAX_SAFE_MONEY) return { ok: false, reason: "money" };
    if (!nonNegInt(raw.subagents) || raw.subagents > 100) return { ok: false, reason: "subagents" };
    for (const field of ["models", "services", "tools"] as const) {
      const list = raw[field];
      if (!Array.isArray(list) || list.length > MISSION_MAX_ITEMS) return { ok: false, reason: field };
    }
    const models: MissionModel[] = [];
    for (const m of raw.models as unknown[]) {
      if (!isRecord(m) || Object.keys(m).sort().join(",") !== "model,provider") return { ok: false, reason: "model" };
      if (typeof m.provider !== "string" || !PROVIDER.test(m.provider)) return { ok: false, reason: "model" };
      if (typeof m.model !== "string" || !MODEL.test(m.model)) return { ok: false, reason: "model" };
      models.push({ provider: m.provider, model: m.model });
    }
    const services: MissionService[] = [];
    for (const s of raw.services as unknown[]) {
      const parsed = parseService(s);
      if (!parsed) return { ok: false, reason: "service" };
      services.push(parsed);
    }
    const tools: MissionToolItem[] = [];
    for (const t of raw.tools as unknown[]) {
      const parsed = parseToolItem(t) as MissionToolItem | null;
      if (!parsed) return { ok: false, reason: "tool" };
      tools.push(parsed);
    }
    return {
      ok: true,
      mission: {
        v: 1,
        goal: raw.goal,
        tenant: raw.tenant,
        agent: raw.agent,
        nonce: raw.nonce,
        starts: raw.starts,
        expires: raw.expires,
        money: raw.money,
        subagents: raw.subagents,
        models: asSet(models),
        services: asSet(services),
        tools: asSet(tools),
      },
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** The one canonical string of a mission. Throws on an invalid document. */
export function canonicalMission(doc: MissionDocument): string {
  const parsed = parseMission(doc);
  if (!parsed.ok) throw new Error(`invalid mission: ${parsed.reason}`);
  return canonicalJson(parsed.mission);
}

/** The mission's identity: SHA-256 over a domain prefix and the canonical form, hex. */
export function hashMission(doc: MissionDocument): string {
  return bytesToHex(sha256(utf8ToBytes(HASH_DOMAIN + canonicalMission(doc))));
}

function segmentsOf(path: string): string[] {
  return path.slice(1).split("/");
}

/**
 * Does service pattern `outer` admit every concrete path `inner` admits?
 * `*` is one segment, `**` one or more trailing segments. Decided segment by
 * segment; anything not provably contained is NOT contained, so an undecidable
 * change goes to the owner (as draft-mcguinness-oauth-mission does: refuse when the
 * subset relation cannot decide).
 */
export function servicePatternContains(outer: string, inner: string): boolean {
  const a = segmentsOf(outer);
  const b = segmentsOf(inner);
  const aTail = a.at(-1) === "**";
  const bTail = b.at(-1) === "**";
  if (!aTail) {
    if (bTail || a.length !== b.length) return false;
    return a.every((s, i) => (s === "*" ? b[i] !== "**" : s === b[i]));
  }
  const prefix = a.length - 1;
  // inner's shortest concrete path has b.length segments; outer needs at least prefix+1.
  if (b.length < prefix + 1) return false;
  for (let i = 0; i < prefix; i++) {
    const s = a[i]!;
    const t = b[i]!;
    if (t === "**") return false;
    if (s !== "*" && s !== t) return false;
  }
  return true;
}

function serviceContains(outer: MissionService, inner: MissionService): boolean {
  if (outer.service !== inner.service || outer.method !== inner.method) return false;
  if (outer.method === "CALL") return outer.path.toLowerCase() === inner.path.toLowerCase();
  return servicePatternContains(outer.path, inner.path);
}

export type MissionComparison = { kind: "same" | "narrower" | "wider"; reasons: string[] };

/**
 * Classify `next` against `current`. Narrower applies automatically; wider ALWAYS
 * needs the owner's signature; a malformed candidate is wider. Identity fields
 * (goal, tenant, agent, nonce) may not change at all: a different job is a new mission.
 */
export function compareMissions(current: MissionDocument, next: MissionDocument): MissionComparison {
  const a = parseMission(current);
  const b = parseMission(next);
  if (!a.ok || !b.ok) return { kind: "wider", reasons: ["not a valid mission"] };
  const x = a.mission;
  const y = b.mission;
  const reasons: string[] = [];
  for (const field of ["goal", "tenant", "agent", "nonce"] as const) {
    if (x[field] !== y[field]) reasons.push(`${field} changed`);
  }
  if (y.starts < x.starts) reasons.push("starts earlier");
  if (y.expires > x.expires) reasons.push("expires later");
  if (y.money > x.money) reasons.push("money cap raised");
  if (y.subagents > x.subagents) reasons.push("more sub-agents");
  for (const m of y.models) {
    if (!x.models.some((o) => o.provider === m.provider && o.model === m.model)) reasons.push(`new model ${m.provider}/${m.model}`);
  }
  for (const s of y.services) {
    if (!x.services.some((o) => serviceContains(o, s))) reasons.push(`service not contained: ${s.service} ${s.method} ${s.path}`);
  }
  for (const t of y.tools) {
    if (!x.tools.some((o) => toolItemContains(o, t))) reasons.push(`tool item not contained: ${toolItemKey(t)}`);
  }
  if (reasons.length) return { kind: "wider", reasons };
  return { kind: canonicalJson(x) === canonicalJson(y) ? "same" : "narrower", reasons: [] };
}
