// The soft pause's lift (1.6.0, L4): "let it go on for an hour".
//
// One key per agent with a TTL, so a lift ends on its own and nothing has to remember
// to end it. The key is per agent, not per tenant, because an agent id names one
// tenant's agent already; the TENANT check is where a lift is set (the dashboard
// action and the Telegram tap both confirm the agent is the caller's first).
//
// A lift only skips the pause check. The hard budget's atomic reserve runs after it
// either way, so a lift can never let an agent spend past its limit.
import { redis } from "./redis";
import { PAUSE_LIFT_SECONDS } from "@/lib/budget-pause";

const key = (agentId: string) => `pause_lift:${agentId}`;
const promptKey = (id: string) => `pause_prompt:${id}`;
const openKey = (agentId: string) => `pause_prompt_open:${agentId}`;
// The heads-up's "Suspend it now" (L8b): its own keys, so an id minted for one
// button is never found under the other's.
const stopKey = (id: string) => `pause_stop:${id}`;
const stopOpenKey = (agentId: string) => `pause_stop_open:${agentId}`;
const stopPollKey = (agentId: string) => `pause_stop_poll:${agentId}`;
/** How often an agent's calls may read Telegram for its "Suspend it now" tap. */
const STOP_POLL_EVERY_S = 10;

/** How long a Telegram "let it go on" button stays good. */
export const PAUSE_PROMPT_TTL_S = 12 * 3600;

/** Whether the owner has let this agent go on. Throws when Redis cannot answer: the caller stays paused. */
export async function readPauseLift(agentId: string): Promise<boolean> {
  return (await redis().get(key(agentId))) !== null;
}

/** When the lift ends (ms since epoch), or null with no lift. For the agent page; throws like readPauseLift. */
export async function readPauseLiftEnd(agentId: string, nowMs: number): Promise<number | null> {
  const ttl = Number(await redis().ttl(key(agentId)));
  return Number.isFinite(ttl) && ttl > 0 ? nowMs + ttl * 1000 : null;
}

/** Let a paused agent go on for `seconds` (at most an hour). */
export async function liftPause(agentId: string, seconds: number): Promise<void> {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > PAUSE_LIFT_SECONDS) {
    throw new Error("A pause lift lasts between one second and an hour.");
  }
  await redis().set(key(agentId), "1", { ex: seconds });
}

/** End a lift early: the agent is paused again at its next call, if it is still past the line. */
export async function endPauseLift(agentId: string): Promise<void> {
  await redis().del(key(agentId));
}

// ── The Telegram button (1.6.0, L4b) ────────────────────────────────────────────
//
// Built like an Ask-me-first approval (lib/state/approvals.ts), because a tap here
// lets an agent spend again. The button carries a minted id, never the agent id: on
// self-host the agent may hold the same bot and could post a look-alike button. The
// record binds the id to the workspace, the agent, the chat and message it was sent
// as, and a hash of the text it showed; a tap must match all of them, and each id
// lifts once. A tap that does not match consumes nothing, so a forgery cannot burn
// the owner's real button.

export interface PausePrompt {
  uid: string;
  agid: string;
  chat: string;
  msg: string;
  hash: string;
}

/** A prompt id as this module mints them: 22 base64url characters. */
export function newPausePromptId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Bind a sent button to its message. Also marks the agent as having a button out, so a paused call drains taps. */
export async function recordPausePrompt(id: string, prompt: PausePrompt): Promise<void> {
  await redis().set(promptKey(id), JSON.stringify(prompt), { ex: PAUSE_PROMPT_TTL_S });
  await redis().set(openKey(prompt.agid), id, { ex: PAUSE_PROMPT_TTL_S });
}

/** Whether a Telegram button for this agent may be waiting to be read. */
export async function pausePromptOpen(agentId: string): Promise<boolean> {
  return (await redis().get(openKey(agentId))) !== null;
}

/**
 * The agent a tap lets go on, or null. The tap must come from the message the
 * button was sent as, in its chat, still showing the text it was sent with, in the
 * workspace whose poll read it; and only the first matching tap counts.
 */
export async function takePausePrompt(input: { userId: string; id: string; chat: string; message: string; textHash: string }): Promise<string | null> {
  return takeBound(promptKey, openKey, input);
}

async function takeBound(
  recordKey: (id: string) => string,
  openKeyOf: (agentId: string) => string,
  input: { userId: string; id: string; chat: string; message: string; textHash: string }
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(input.id)) return null;
  const raw = await redis().get<unknown>(recordKey(input.id));
  // @upstash/redis parses JSON it reads back; a test double may not.
  const record = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<PausePrompt> | null;
  if (
    !record ||
    record.uid !== input.userId ||
    record.chat !== input.chat ||
    record.msg !== input.message ||
    record.hash !== input.textHash ||
    typeof record.agid !== "string"
  ) {
    return null;
  }
  if (Number(await redis().del(recordKey(input.id))) !== 1) return null;
  await redis().del(openKeyOf(record.agid));
  return record.agid;
}

// ── The heads-up's "Suspend it now" (1.6.0, L8b) ────────────────────────────────
//
// The same binding as the lift's button, under its own keys. Its open key tells the
// gateway to read taps, off the request path, on the agent's calls while it is out.

/**
 * Bind a sent "Suspend it now" button to its message, and mark it out for
 * `seconds`: until the period it warns about ends, never past the button's 12 h.
 */
export async function recordStopPrompt(id: string, prompt: PausePrompt, seconds = PAUSE_PROMPT_TTL_S): Promise<void> {
  const ex = Math.max(1, Math.min(PAUSE_PROMPT_TTL_S, Math.floor(seconds)));
  await redis().set(stopKey(id), JSON.stringify(prompt), { ex });
  await redis().set(stopOpenKey(prompt.agid), id, { ex });
}

/**
 * Whether this call may read Telegram for the tap: one call per agent every ten
 * seconds. Each read is a database read of the destination and a Telegram request,
 * and the agents with a button out are the ones calling fastest.
 */
export async function claimStopPoll(agentId: string): Promise<boolean> {
  return (await redis().set(stopPollKey(agentId), "1", { ex: STOP_POLL_EVERY_S, nx: true })) !== null;
}

/** Whether a "Suspend it now" button for this agent may be waiting to be read. */
export async function stopPromptOpen(agentId: string): Promise<boolean> {
  return (await redis().get(stopOpenKey(agentId))) !== null;
}

/** The agent a "Suspend it now" tap names, or null: takePausePrompt's checks, its own record. */
export async function takeStopPrompt(input: { userId: string; id: string; chat: string; message: string; textHash: string }): Promise<string | null> {
  return takeBound(stopKey, stopOpenKey, input);
}
