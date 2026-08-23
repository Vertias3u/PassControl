"use server";
// Listing this agent on the operator's public /@handle page.
//
// Behind mfaAuthorizedUser like every other mutation on this screen, and for
// the reason passport-actions.ts states: a server action is addressable over
// HTTP by its id, so the redirect on the page protects the page and not this.
// It matters more here than usual — this is the only control in the dashboard
// whose effect is visible to strangers.
//
// The service-role client is used because 0011 replaced the table-wide grant on
// public.agents with a column allowlist and 0033 deliberately did not add
// `published` or `public_label` to it. The tenant boundary is therefore in
// code: the userId comes from the verified session and lib/profile/publish.ts
// filters on it.
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { setAgentPublished, type PublishedAgentRecord } from "@/lib/profile/publish";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublishAgentState {
  agent?: PublishedAgentRecord;
  error?: string;
  notice?: string;
}

async function actingUser(): Promise<{ userId: string } | { error: string }> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification to change what is published."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change what is published."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  return { userId: gate.user.id };
}

function explain(code: string): string {
  switch (code) {
    // The message says WHY, because "a label is required" alone sounds like
    // bureaucracy rather than the point: the internal name is not safe to show.
    case "label_required":
      return "Give this agent a public name before listing it. Its internal name is not published — internal names often identify customers.";
    case "label_too_long":
      return "That public name is too long (60 characters maximum).";
    case "no_agent":
      return "That agent could not be found.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export async function publishAgent(
  agentId: string,
  input: { published: boolean; label?: string }
): Promise<PublishAgentState> {
  if (!UUID_RE.test(agentId ?? "")) return { error: "That agent could not be found." };

  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const result = await setAgentPublished(serviceClient(), acting.userId, agentId, input);
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "agent.publish",
    targetType: "agent",
    targetId: agentId,
    // Neither name is recorded — not the internal one, and not the public
    // label either. The agent id already identifies the row, so the wording
    // would add nothing an auditor needs, and admin_audit is tenant-readable
    // and served by GET /api/control/v1/audit. What matters here is WHEN this
    // agent became visible to strangers, which is the boolean.
    metadata: { via: "dashboard", published: input.published },
  });

  revalidatePath(`/dashboard/agents/${agentId}`);
  revalidatePath("/dashboard/settings");
  return {
    agent: result.data,
    notice: input.published
      ? "Listed on your public profile — visible once your profile is public too."
      : "Removed from your public profile.",
  };
}
