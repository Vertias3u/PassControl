// "Ask me first": the owner's yes or no on one service call, held in Redis.
//
// A service rule with `ask: true` (lib/services/rules.ts) admits a call only
// after the workspace's owner approves THAT call. The gateway turns the call
// into a fingerprint (lib/approvals/fingerprint.ts: method, path, query, the
// headers it forwards, the body), and this module answers one question about
// it: has the owner said yes to exactly this?
//
// ── What each transition guarantees ─────────────────────────────────────────
//
//   check   one Lua script. An approved fingerprint is admitted AND used in the
//           same step, so two identical retries racing get one admission
//           between them: an approved Discord post goes out once. Pending and
//           denied are reported, never reset. With `create`, a fingerprint seen
//           for the first time opens one pending approval, under a per-
//           workspace cap so an agent cannot open unbounded prompts.
//   decide  one Lua script, pending → approved | denied, once. The record names
//           its workspace and the decision must name the same one. A Telegram
//           tap must also come from the message PassControl sent for this
//           approval, in the chat it was sent to: an agent that holds the same
//           bot could otherwise post its own button carrying the id.
//
// Nothing here is durable on purpose. An approval lives minutes: a question
// nobody answered in 15 minutes expires, and a yes not used in 10 is gone. The
// audit row and the receipt of the call that went (or was refused) are the
// durable record.
//
// Keys:
//   apv:<id>        hash: the approval
//   apvfp:<fp>      the approval id for a fingerprint
//   apvq:<uid>      sorted set: a workspace's PENDING approvals, by creation time
//   apvtg:lock:<uid>, apvtg:off:<uid>   the Telegram poller (lib/alerts/approvals.ts)
import { redis } from "./redis";

/** How long a question waits for an answer. */
export const PENDING_TTL_S = 15 * 60;
/** How long a yes waits for the agent's retry. */
export const APPROVED_TTL_S = 10 * 60;
/** How long a no keeps answering the agent's retries. */
export const DENIED_TTL_S = 15 * 60;
/** Open questions per workspace. A legitimate burst is a handful. */
export const MAX_PENDING_APPROVALS = 20;
/** Longest stored path. */
export const APPROVAL_PATH_MAX = 300;
/**
 * Longest query-and-body the owner is asked about, stored whole so the
 * Approvals page shows ALL of it. The gateway refuses a larger request rather
 * than ask about its start (lib/approvals/gate.ts's caller).
 */
export const APPROVAL_PREVIEW_MAX = 16 * 1024;

const k = {
  record: (id: string) => `apv:${id}`,
  fingerprint: (fp: string) => `apvfp:${fp}`,
  queue: (uid: string) => `apvq:${uid}`,
  pollLock: (uid: string) => `apvtg:lock:${uid}`,
  pollOffset: (uid: string) => `apvtg:off:${uid}`,
};

export interface ApprovalRequest {
  userId: string;
  agentId: string;
  service: string;
  method: string;
  /** The path sent upstream, for the owner to read. */
  path: string;
  /** The start of the body, for the owner to read. Never the whole body. */
  preview: string;
  fingerprint: string;
}

export type ApprovalCheck =
  | { state: "approved"; id: string }
  | { state: "pending"; id: string }
  | { state: "denied"; id: string }
  | { state: "created"; id: string }
  | { state: "none"; id?: undefined }
  | { state: "full"; id?: undefined };

export interface Approval {
  id: string;
  state: "pending" | "approved" | "denied" | "used";
  agentId: string;
  service: string;
  method: string;
  path: string;
  preview: string;
  createdAt: number;
  telegram: { chat: string; message: string } | null;
}

// KEYS[1] fingerprint key, KEYS[2] the workspace's pending queue.
// ARGV: create ('1'|'0'), new id, now ms, pending ttl s, cap, then the record's
// fields as alternating name/value pairs.
const CHECK_LUA = `
local id = redis.call('GET', KEYS[1])
if id then
  local rk = 'apv:' .. id
  local st = redis.call('HGET', rk, 'state')
  if st == 'approved' then
    redis.call('HSET', rk, 'state', 'used')
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[2], id)
    return {'approved', id}
  end
  if st == 'pending' or st == 'denied' then
    return {st, id}
  end
  redis.call('DEL', KEYS[1])
end
if ARGV[1] ~= '1' then return {'none', ''} end
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - ttl * 1000)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return {'full', ''} end
local nid = ARGV[2]
local rk = 'apv:' .. nid
redis.call('HSET', rk, 'state', 'pending', 'created', ARGV[3], unpack(ARGV, 6))
redis.call('EXPIRE', rk, ttl)
redis.call('SET', KEYS[1], nid, 'EX', ttl)
redis.call('ZADD', KEYS[2], now, nid)
redis.call('EXPIRE', KEYS[2], ttl)
return {'created', nid}
`;

// KEYS[1] the record, KEYS[2] the workspace's pending queue.
// ARGV: uid, decision, approved ttl, denied ttl, decided by, now ms, id,
// telegram chat ('' for none), telegram message, hash of the message's text.
const DECIDE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'missing' end
if redis.call('HGET', KEYS[1], 'uid') ~= ARGV[1] then return 'missing' end
if ARGV[8] ~= '' then
  if redis.call('HGET', KEYS[1], 'tg_chat') ~= ARGV[8] then return 'missing' end
  if redis.call('HGET', KEYS[1], 'tg_msg') ~= ARGV[9] then return 'missing' end
  if redis.call('HGET', KEYS[1], 'tg_hash') ~= ARGV[10] then return 'missing' end
end
local st = redis.call('HGET', KEYS[1], 'state')
if st ~= 'pending' then return st end
local ttl = ARGV[3]
if ARGV[2] == 'denied' then ttl = ARGV[4] end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'by', ARGV[5], 'decided', ARGV[6])
redis.call('EXPIRE', KEYS[1], ttl)
local fp = redis.call('HGET', KEYS[1], 'fp')
if fp then redis.call('SET', 'apvfp:' .. fp, ARGV[7], 'EX', ttl) end
redis.call('ZREM', KEYS[2], ARGV[7])
return ARGV[2]
`;

// KEYS[1] the record. ARGV: chat, message, hash of the text sent. Only an
// existing record, so a late send cannot recreate an expired one.
const ATTACH_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'tg_chat', ARGV[1], 'tg_msg', ARGV[2], 'tg_hash', ARGV[3])
return 1
`;

function newApprovalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** An approval id as this module mints them: 22 base64url characters. */
export function isApprovalId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/u.test(value);
}

// @upstash/redis parses any stored value that reads as JSON, so a body preview
// of `{"content":"hi"}` would come back an object. Free text is stored behind a
// prefix that no JSON value starts with, and the prefix is removed on read.
const TEXT = "~";
const clip = (value: string, max: number) => TEXT + value.slice(0, max);

/**
 * Whether the owner has approved this exact request, using the approval if so.
 * Throws when Redis cannot answer: the caller refuses the call (fail closed).
 */
export async function checkApproval(request: ApprovalRequest, opts: { create: boolean }): Promise<ApprovalCheck> {
  const fields = [
    "uid", request.userId,
    "agid", request.agentId,
    "svc", TEXT + request.service,
    "method", TEXT + request.method,
    "path", clip(request.path, APPROVAL_PATH_MAX),
    "preview", clip(request.preview, APPROVAL_PREVIEW_MAX),
    "fp", request.fingerprint,
  ];
  const res = (await redis().eval(
    CHECK_LUA,
    [k.fingerprint(request.fingerprint), k.queue(request.userId)],
    [opts.create ? "1" : "0", newApprovalId(), String(Date.now()), String(PENDING_TTL_S), String(MAX_PENDING_APPROVALS), ...fields]
  )) as [string, string];
  const [state, id] = res;
  switch (state) {
    case "approved":
    case "pending":
    case "denied":
    case "created":
      return { state, id };
    case "full":
      return { state: "full" };
    default:
      return { state: "none" };
  }
}

export type ApprovalDecision = "approved" | "denied";

/**
 * The owner's answer. Returns the approval's state afterwards: the decision
 * just made, the one made first, or `missing` (expired, another workspace's,
 * or a Telegram tap that did not come from this approval's message).
 */
export async function decideApproval(input: {
  userId: string;
  id: string;
  decision: ApprovalDecision;
  by: "dashboard" | "telegram";
  /**
   * The message the tap came from, and a hash of the text it showed. The text
   * must be the text PassControl sent: an agent holding the same bot could
   * otherwise edit the question above the real buttons.
   */
  telegram?: { chat: string; message: string; textHash: string };
}): Promise<{ state: ApprovalDecision | "used" | "pending" | "missing" }> {
  if (!isApprovalId(input.id)) return { state: "missing" };
  // A Telegram decision without the message it came from is not one.
  if (input.by === "telegram" && (!input.telegram?.chat || !input.telegram.message || !input.telegram.textHash)) {
    return { state: "missing" };
  }
  const res = (await redis().eval(
    DECIDE_LUA,
    [k.record(input.id), k.queue(input.userId)],
    [
      input.userId,
      input.decision,
      String(APPROVED_TTL_S),
      String(DENIED_TTL_S),
      input.by,
      String(Date.now()),
      input.id,
      input.by === "telegram" ? input.telegram!.chat : "",
      input.by === "telegram" ? input.telegram!.message : "",
      input.by === "telegram" ? input.telegram!.textHash : "",
    ]
  )) as string;
  if (res === "approved" || res === "denied" || res === "used" || res === "pending") return { state: res };
  return { state: "missing" };
}

/** Bind an approval to the Telegram message that asks about it, and the text it shows. */
export async function attachTelegramMessage(id: string, chat: string, message: string, textHash: string): Promise<void> {
  await redis().eval(ATTACH_LUA, [k.record(id)], [chat, message, textHash]);
}

function toApproval(id: string, raw: Record<string, unknown> | null): Approval | null {
  if (!raw || typeof raw.state !== "string") return null;
  const text = (key: string) => {
    const value = raw[key] === undefined || raw[key] === null ? "" : String(raw[key]);
    return value.startsWith(TEXT) ? value.slice(TEXT.length) : value;
  };
  const state = text("state");
  if (state !== "pending" && state !== "approved" && state !== "denied" && state !== "used") return null;
  const chat = text("tg_chat");
  const message = text("tg_msg");
  return {
    id,
    state,
    agentId: text("agid"),
    service: text("svc"),
    method: text("method"),
    path: text("path"),
    preview: text("preview"),
    createdAt: Number(text("created")) || 0,
    telegram: chat && message ? { chat, message } : null,
  };
}

/** One approval, for its own workspace only. */
export async function readApproval(userId: string, id: string): Promise<Approval | null> {
  if (!isApprovalId(id)) return null;
  const raw = await redis().hgetall<Record<string, unknown>>(k.record(id));
  if (!raw || String(raw.uid ?? "") !== userId) return null;
  return toApproval(id, raw);
}

/** A workspace's open questions, oldest first. */
export async function listPendingApprovals(userId: string): Promise<Approval[]> {
  const ids = (await redis().zrange<string[]>(k.queue(userId), 0, -1)).filter(isApprovalId);
  if (ids.length === 0) return [];
  const pipe = redis().pipeline();
  for (const id of ids) pipe.hgetall(k.record(id));
  const rows = (await pipe.exec()) as (Record<string, unknown> | null)[];
  const out: Approval[] = [];
  ids.forEach((id, i) => {
    const raw = rows[i] ?? null;
    if (!raw || String(raw.uid ?? "") !== userId) return;
    const approval = toApproval(id, raw);
    if (approval?.state === "pending") out.push(approval);
  });
  return out;
}

// ── The Telegram poller's lock and offset ────────────────────────────────────

/** One long-poll per workspace at a time; Telegram ends the older of two anyway. */
export async function claimTelegramPoll(userId: string, ttlSeconds = 30): Promise<boolean> {
  return (await redis().set(k.pollLock(userId), 1, { nx: true, ex: ttlSeconds })) === "OK";
}

export async function releaseTelegramPoll(userId: string): Promise<void> {
  await redis().del(k.pollLock(userId));
}

/** The next update id to ask Telegram for (0: from the oldest it holds). */
export async function readTelegramOffset(userId: string): Promise<number> {
  const value = Number(await redis().get(k.pollOffset(userId)));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export async function writeTelegramOffset(userId: string, offset: number): Promise<void> {
  // A day: Telegram keeps undelivered updates for 24 hours.
  await redis().set(k.pollOffset(userId), offset, { ex: 24 * 60 * 60 });
}
