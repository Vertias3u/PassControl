"use server";

import { headers } from "next/headers";
import { betaApplicationIp, parseBetaApplication, betaRateLimitSubject } from "@/lib/beta-launch";
import { rateLimitFailClosed } from "@/lib/ratelimit";
import { serviceClient } from "@/lib/supabase";
import { captureError } from "@/lib/observability";

export type BetaApplicationState =
  | { status: "error"; message: string }
  | { status: "success"; message: string }
  | undefined;

const GENERIC_SUCCESS =
  "Application received. If there is a fit for this beta, Vertias will contact you by email.";

async function applicationIp(): Promise<string> {
  return betaApplicationIp(await headers());
}

export async function applyForBeta(
  _previous: BetaApplicationState,
  formData: FormData
): Promise<BetaApplicationState> {
  if (String(formData.get("company_website") ?? "").trim()) {
    return { status: "success", message: GENERIC_SUCCESS };
  }

  const parsed = parseBetaApplication(formData);
  if (!parsed.ok) return { status: "error", message: parsed.error };

  try {
    const ipSubject = betaRateLimitSubject("ip", await applicationIp());
    const emailSubject = betaRateLimitSubject("email", parsed.value.email);
    const [ipLimit, emailLimit] = await Promise.all([
      rateLimitFailClosed(`beta-application:ip:${ipSubject}`, 12, 60 * 60),
      rateLimitFailClosed(`beta-application:email:${emailSubject}`, 3, 24 * 60 * 60),
    ]);
    if (ipLimit.unreadable || emailLimit.unreadable) {
      return { status: "error", message: "Applications are temporarily unavailable. Try again later." };
    }
    if (!ipLimit.success || !emailLimit.success) {
      return { status: "success", message: GENERIC_SUCCESS };
    }

    const { error } = await serviceClient().from("beta_applications").insert({
      email_normalized: parsed.value.email,
      integration: parsed.value.integration,
      provider: parsed.value.provider,
      monthly_call_bucket: parsed.value.monthlyCallBucket,
      use_case: parsed.value.useCase,
      contact_consent_at: new Date().toISOString(),
    });
    if (error && error.code !== "23505") {
      await captureError(new Error("beta application insert failed"), {
        route: "/beta",
        method: "POST",
        code: "application_insert_failed",
      });
      return { status: "error", message: "Applications are temporarily unavailable. Try again later." };
    }
    return { status: "success", message: GENERIC_SUCCESS };
  } catch (error) {
    await captureError(error, {
      route: "/beta",
      method: "POST",
      code: "application_unavailable",
    });
    return { status: "error", message: "Applications are temporarily unavailable. Try again later." };
  }
}
