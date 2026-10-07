// "Ask me first" at the gateway: the step between reading a call and
// decrypting the token it would use (app/api/v1/svc/[service]/[...path]).
//
// A call under an `ask` rule either finds the owner's yes for exactly this
// request (and uses it, once), or opens the question, asks the owner, and
// waits a little in case the answer is quick. A phone tap usually is, so the
// common case is one call that simply takes a few seconds longer. When the
// wait runs out the agent is told to send the same request again; the
// approval it then finds admits that request once.
//
// The wait is short on purpose. An edge function must start its answer within
// 25 seconds, and the status of this answer (sent, refused or held) is not
// known until the owner decides, so nothing can be streamed early.
//
// Fails closed: an approval store that cannot answer refuses the call. An ask
// rule exists because the owner wanted a human in the way; a Redis fault must
// not remove the human.
import { pollTelegramDecisions, sendApprovalPrompt, type ApprovalPromptInfo } from "@/lib/alerts/approvals";
import { checkApproval, type ApprovalRequest } from "@/lib/state/approvals";

/**
 * Default wait inside one call: well under the edge's 25-second first byte,
 * which also has to cover authentication and the reads before this step.
 */
export const DEFAULT_APPROVAL_WAIT_MS = 15_000;
const MAX_APPROVAL_WAIT_MS = 18_000;
/** Between store reads when there is no Telegram long-poll to wait on. */
const TICK_MS = 1_000;

export function approvalWaitMs(): number {
  const raw = process.env.APPROVAL_WAIT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_APPROVAL_WAIT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_APPROVAL_WAIT_MS;
  return Math.min(Math.floor(value), MAX_APPROVAL_WAIT_MS);
}

export type ApprovalOutcome =
  | { state: "approved"; id: string }
  | { state: "pending" }
  | { state: "denied" }
  | { state: "full" }
  | { state: "unavailable" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function awaitApproval(input: {
  request: ApprovalRequest;
  prompt: Omit<ApprovalPromptInfo, "id">;
  waitMs: number;
}): Promise<ApprovalOutcome> {
  const { request } = input;
  let first;
  try {
    first = await checkApproval(request, { create: true });
  } catch {
    return { state: "unavailable" };
  }
  if (first.state === "approved") return { state: "approved", id: first.id };
  if (first.state === "denied") return { state: "denied" };
  if (first.state === "full") return { state: "full" };
  if (first.state === "none") return { state: "unavailable" };
  if (first.state === "created") {
    await sendApprovalPrompt(request.userId, { ...input.prompt, id: first.id });
  }

  const deadline = Date.now() + input.waitMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    // Telegram's long-poll returns the moment a tap arrives, so it is the wait.
    // Leave a second for the store read after it, and cut the request off at
    // the deadline: a hung Telegram must not carry the call past the edge's
    // 25-second first byte (tests/approval-gate-deadline.test.ts).
    const poll = await pollTelegramDecisions(request.userId, Math.floor(remaining / 1000) - 1, remaining).catch(() => null);
    if (poll?.state !== "ok") await sleep(Math.min(TICK_MS, Math.max(0, deadline - Date.now())));
    let next;
    try {
      next = await checkApproval(request, { create: false });
    } catch {
      return { state: "unavailable" };
    }
    if (next.state === "approved") return { state: "approved", id: next.id };
    if (next.state === "denied") return { state: "denied" };
    // `none`: the question expired while waiting. The agent's retry asks anew.
    if (next.state === "none") return { state: "pending" };
  }
  return { state: "pending" };
}
