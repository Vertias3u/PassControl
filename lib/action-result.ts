// What a dashboard server action hands back, and the error type whose message
// may cross to the browser.
//
// Why results and not throws: in a production build Next replaces the message
// of anything a server action THROWS with "An error occurred in the Server
// Components render…". A RETURNED value crosses intact. So the exported actions
// in app/dashboard/actions.ts return an ActionResult (see lib/run-action.ts), and
// app/dashboard/actions-client.ts unwraps it, re-throwing on the client, where
// the message survives and each component's existing catch keeps working.
//
// No imports: this file is bundled into the browser.

/**
 * An error written for the person using the dashboard. Its message is shown to
 * them as-is, so it must never carry a database error, an upstream body, or
 * anything they submitted. Every other error becomes GENERIC_ACTION_ERROR.
 */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

export const GENERIC_ACTION_ERROR = "Something went wrong. Please try again.";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Client side: the value, or an Error with the action's own message. */
export function unwrap<T>(result: ActionResult<T>): T {
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok) return result.value;
    throw new Error(result.error || GENERIC_ACTION_ERROR);
  }
  // Not a result at all: a wrapper and its action disagree. Loud, not silent.
  throw new Error(GENERIC_ACTION_ERROR);
}
