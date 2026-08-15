import { betaFeedbackEmail, betaNudgeEmail, type BetaEmailResult } from "@/lib/beta-email";

export type BetaFollowupKind = "nudge" | "feedback_request";

export type BetaFollowupResult =
  | { code: "sent" }
  | { code: "origin_unavailable" }
  | { code: "already_reserved" }
  | { code: "reservation_failed" }
  | { code: "delivery_failed" }
  | { code: "delivery_state_unresolved" }
  | { code: "accepted_state_unresolved" };

interface DeliverBetaFollowupInput {
  kind: BetaFollowupKind;
  issuer: string | undefined;
  to: string;
  applicationId: string;
  reserve: (action: string) => Promise<{ id: string | null; error: { code?: string } | null }>;
  transition: (eventId: string, action: string) => Promise<{ error: unknown | null }>;
  send: (email: {
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
  }) => Promise<BetaEmailResult>;
}

function canonicalIssuer(value: string | undefined): string | null {
  const candidate = value?.trim().replace(/\/+$/u, "");
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
    if (url.origin !== candidate || (url.protocol !== "https:" && !loopback.has(url.hostname))) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Reserve a follow-up, deliver it, then settle the durable event to the truth.
 * A pending row blocks concurrent/stale retries. Provider acceptance is never
 * recorded before it happens; an unsettled row remains pending for inspection.
 */
export async function deliverBetaFollowup(
  input: DeliverBetaFollowupInput
): Promise<BetaFollowupResult> {
  const origin = canonicalIssuer(input.issuer);
  if (!origin) return { code: "origin_unavailable" };

  // Build every value that can throw before reserving the one-shot operation.
  const content = input.kind === "nudge"
    ? betaNudgeEmail(origin)
    : betaFeedbackEmail(origin);
  const pendingAction = `${input.kind}.pending`;
  const sentAction = `${input.kind}.sent`;
  const failedAction = `${input.kind}.send_failed`;

  const reserved = await input.reserve(pendingAction);
  if (reserved.error?.code === "23505") return { code: "already_reserved" };
  if (reserved.error || !reserved.id) return { code: "reservation_failed" };

  let delivered = false;
  try {
    delivered = (await input.send({
      to: input.to,
      ...content,
      idempotencyKey: `beta-${input.kind}/${input.applicationId}`,
    })).ok;
  } catch {
    delivered = false;
  }

  const settled = await input.transition(
    reserved.id,
    delivered ? sentAction : failedAction
  );
  if (settled.error) {
    return { code: delivered ? "accepted_state_unresolved" : "delivery_state_unresolved" };
  }
  return { code: delivered ? "sent" : "delivery_failed" };
}
