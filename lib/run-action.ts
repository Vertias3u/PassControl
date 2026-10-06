// Server side of lib/action-result.ts: run an action body and turn whatever it
// throws into a result the browser can read. Kept apart from action-result.ts so
// nothing here (logging, future observability) reaches the client bundle.
import { ActionError, GENERIC_ACTION_ERROR, type ActionResult } from "@/lib/action-result";

/**
 * Next signals redirect(), notFound() and dynamic-usage bail-outs by throwing
 * an error with a string `digest`. Those are control flow, not failures, and
 * must keep propagating or a redirect would turn into an error message.
 */
function isNextControlFlow(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { digest?: unknown }).digest === "string"
  );
}

export async function runAction<T>(name: string, body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    if (error instanceof ActionError) return { ok: false, error: error.message };
    // Next used to log the thrown error; returning it instead would make
    // production failures invisible. The error's NAME only: its message can
    // echo what was submitted (a provider key, for instance).
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[dashboard:${name}]`, kind);
    return { ok: false, error: GENERIC_ACTION_ERROR };
  }
}
