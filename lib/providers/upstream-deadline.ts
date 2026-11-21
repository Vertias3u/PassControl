// How long the gateway waits for a provider to BEGIN answering, counted from the
// moment the agent's request arrived (not from the upstream call: the checks before
// it, and an "Ask me first" wait, spend the same clock).
//
// Why it exists: Vercel's Edge runtime must begin sending a response within 25 s
// (vercel.com/docs/functions/runtimes/edge, "Maximum duration", read 2026-11-21).
// A function cut there never runs its settlement, so the budget hold stays open
// until a human resolves it, and no audit row or receipt is written. Giving up a
// little earlier turns that into an ordinary "dispatched, no answer" settlement:
// the estimate is charged (the provider may still bill the call), the row and the
// receipt are written, and the agent is told to stream.
//
// What it does NOT do: it never cuts a response that has begun. A stream that
// started in time may run on; Vercel's own 300 s streaming cap is not handled here.
// Off Vercel nothing cuts the call, so there is no deadline unless an operator sets
// UPSTREAM_FIRST_BYTE_DEADLINE_MS.

/** Under the 25 s edge limit, with room to write the refusal and schedule the settle. */
export const UPSTREAM_DEADLINE_ON_VERCEL_MS = 22_000;

export function upstreamFirstByteDeadlineMs(
  env: Record<string, string | undefined> = process.env
): number | null {
  const raw = env.UPSTREAM_FIRST_BYTE_DEADLINE_MS;
  const set = raw !== undefined && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
  const usable = set !== null && Number.isSafeInteger(set) ? set : null;
  if (env.VERCEL === "1") return usable === null ? UPSTREAM_DEADLINE_ON_VERCEL_MS : Math.min(usable, UPSTREAM_DEADLINE_ON_VERCEL_MS);
  return usable;
}

/** What the agent is told. Streaming makes the provider begin answering at once. */
export const UPSTREAM_TIMEOUT_MESSAGE =
  "The provider had not begun answering by this gateway's deadline. It may still bill the call, so the call was charged at its estimate. Streaming (\"stream\": true) makes the answer begin at once and avoids this.";
