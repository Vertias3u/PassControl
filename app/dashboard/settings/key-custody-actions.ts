"use server";
// Stating the workspace's key-custody expectation.
//
// Modelled on app/dashboard/settings/profile-actions.ts, and it inherits that
// file's first rule for the same reason: THE SERVICE-ROLE CLIENT IS DELIBERATE.
// 0032 revoked insert/update/delete on public.users from `authenticated`, and
// 0051 adds no grant back, so a userClient() could not write this column even
// if we wanted it to. The tenant boundary is therefore enforced here, in code —
// `userId` comes from the MFA-verified session and is never taken from an
// argument, because RLS can only ask who owns a row, never whether the session
// writing it cleared a second factor.
//
// ── What this action does NOT do ────────────────────────────────────────────
//
// It changes nothing about how any agent authenticates. research/passport-key-
// protection.md §5: the key lives on the agent's machine and this server has
// never seen it, so an expectation is a statement, not a control. Nothing in
// the proxy, the visa mint, or a signed receipt reads the value this writes.
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import {
  parseKeyCustodyExpectation,
  writeKeyCustodyExpectation,
} from "@/lib/key-custody-expectation";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { ensureProfileRow } from "@/lib/profile/manage";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";

export interface KeyCustodyActionState {
  error?: string;
  expectation?: string | null;
}

const FAILURE_MESSAGE: Record<string, string> = {
  unknown_store:
    "This instance does not know that storage tier, so it could not tell you which agents met it.",
  // Named rather than generic. An operator who applies 0051 and retries will
  // succeed, and nothing else will tell them that.
  unmigrated:
    "This instance has not applied migration 0051, so there is nowhere to record an expectation yet.",
  write_failed: "The expectation could not be saved. Try again.",
};

export async function setKeyCustodyExpectation(value: string): Promise<KeyCustodyActionState> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification to change this."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change this."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }

  // Nothing creates a public.users row at signup — see ensureProfileRow's note —
  // so an operator who has never stored a provider key or made an agent has no
  // row to update, and the write would silently affect zero rows.
  try {
    await ensureProfileRow(serviceClient(), gate.user);
  } catch {
    return { error: "Your workspace settings could not be opened. Please try again." };
  }

  const expectation = parseKeyCustodyExpectation(value);
  const result = await writeKeyCustodyExpectation(serviceClient(), gate.user.id, expectation);
  if (!result.ok) return { error: FAILURE_MESSAGE[result.code] ?? FAILURE_MESSAGE.write_failed };

  await recordAdminAction({
    userId: gate.user.id,
    action: "workspace.key_custody_expectation",
    metadata: { to: expectation ?? "none", via: "dashboard" },
  });

  // The fleet table reads this to mark which agents fall short of it.
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/settings");
  return { expectation };
}
