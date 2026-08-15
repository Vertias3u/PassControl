"use server";

import { userClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase";

export type BetaFeedbackState = { ok: boolean; message: string } | undefined;

export async function saveBetaFeedback(
  _previous: BetaFeedbackState,
  formData: FormData
): Promise<BetaFeedbackState> {
  const db = await userClient();
  const { data: auth, error: authError } = await db.auth.getUser();
  if (authError || !auth.user) return { ok: false, message: "Sign in again before sending feedback." };

  const rating = Number(formData.get("setup_rating"));
  const feedback = String(formData.get("feedback") ?? "").trim();
  const contactPermitted = formData.get("contact_permitted") === "on";
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, message: "Choose a setup rating from 1 to 5." };
  }
  if (feedback.length < 10 || feedback.length > 2_000) {
    return { ok: false, message: "Feedback must be 10 to 2,000 characters." };
  }

  const admin = serviceClient();
  const [{ data: application, error: applicationError }, { count: successfulCalls, error: logError }] =
    await Promise.all([
      admin.from("beta_applications").select("id").eq("user_id", auth.user.id).eq("status", "accepted").maybeSingle(),
      admin.from("agent_logs").select("id", { count: "exact", head: true }).eq("user_id", auth.user.id).eq("status", "ok"),
    ]);
  if (applicationError || logError || !application || (successfulCalls ?? 0) === 0) {
    return { ok: false, message: "Feedback opens after this workspace records its first successful governed call." };
  }

  const { error } = await admin.from("beta_feedback").upsert({
    user_id: auth.user.id,
    application_id: application.id,
    setup_rating: rating,
    feedback,
    contact_permitted: contactPermitted,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  return error
    ? { ok: false, message: "Feedback could not be saved. Try again." }
    : { ok: true, message: "Feedback saved. Thank you—this goes directly into the beta review." };
}
