import { captureError } from "@/lib/observability";

export interface BetaEmail {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export interface BetaEmailResult {
  ok: boolean;
  providerId?: string;
}

/**
 * Send a text-only transactional beta email. There is deliberately no HTML,
 * open pixel, click wrapper, or analytics parameter. The raw invitation token
 * exists only in this request body and is never stored or logged.
 */
export async function sendBetaEmail(email: BetaEmail): Promise<BetaEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.PASSCONTROL_BETA_FROM_EMAIL?.trim();
  if (!apiKey || !from) return { ok: false };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": email.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
      }),
      cache: "no-store",
    });
    if (!response.ok) {
      await captureError(new Error("beta email provider refused request"), {
        route: "beta-email",
        method: "POST",
        status: response.status,
        code: "provider_refused",
      });
      return { ok: false };
    }
    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return { ok: true, providerId: typeof body.id === "string" ? body.id : undefined };
  } catch (error) {
    await captureError(error, {
      route: "beta-email",
      method: "POST",
      code: "provider_unavailable",
    });
    return { ok: false };
  }
}

export function betaInviteEmail(inviteUrl: string) {
  return {
    subject: "Your PassControl Cloud beta invitation",
    text: [
      "You are invited to the free PassControl Cloud beta.",
      "",
      `Create your account: ${inviteUrl}`,
      "",
      "This personal, one-time link expires in 7 days. Do not forward it.",
      "PassControl will never ask you to email a provider key or agent credential.",
      "",
      "Questions: hello@vertias.eu",
    ].join("\n"),
  };
}

export function betaNudgeEmail(origin: string) {
  return {
    subject: "Need help with your first PassControl call?",
    text: [
      "Your PassControl workspace has not recorded its first governed call yet.",
      "",
      `Continue in the dashboard: ${origin}/dashboard`,
      "The activation guide shows the next exact step and the stored refusal reason if a call was blocked.",
      "",
      "Reply to this email if you are stuck. Do not send provider keys, Direct Agent Keys, passports, or recovery codes.",
    ].join("\n"),
  };
}

export function betaFeedbackEmail(origin: string) {
  return {
    subject: "How did your first PassControl call go?",
    text: [
      "Your workspace recorded a successful governed call. I would value the setup feedback while it is fresh.",
      "",
      `Share feedback: ${origin}/dashboard/feedback`,
      "",
      "The form asks only about setup. Do not include provider keys, agent credentials, prompts, or model responses.",
    ].join("\n"),
  };
}
