"use server";

import { mfaAuthorizedUser } from "@/lib/mfa";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import { armTenantKill } from "@/lib/state/killswitch";
import { redis } from "@/lib/state/redis";
import { purgeAccountRuntimeState } from "@/lib/account-lifecycle";
import { captureError } from "@/lib/observability";

export type DeleteAccountResult =
  | { ok: true; cleanupPending: boolean }
  | { ok: false; error: string };

interface DeletionInventory {
  agentIds: string[];
  controlApiKeyIds: string[];
}

function parseDeletionInventory(value: unknown): DeletionInventory | null {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  if (!Array.isArray(row.agent_ids) || !Array.isArray(row.control_api_key_ids)) return null;
  if (!row.agent_ids.every((id) => typeof id === "string")) return null;
  if (!row.control_api_key_ids.every((id) => typeof id === "string")) return null;
  return {
    agentIds: row.agent_ids,
    controlApiKeyIds: row.control_api_key_ids,
  };
}

export async function deleteAccount(confirmation: string): Promise<DeleteAccountResult> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      ok: false,
      error: gate.reason === "step_up_required"
        ? "Complete two-factor verification before deleting this account."
        : "Your authenticated session could not be verified.",
    };
  }
  const user = gate.user;
  if (confirmation.trim() !== "DELETE MY ACCOUNT") {
    return { ok: false, error: "Type DELETE MY ACCOUNT exactly to continue." };
  }

  // A live visa can outlast the database row it was minted from. Arm first so
  // no request can use a still-cached provider credential during erasure. The
  // database function captures every cleanup id only after taking the profile
  // lock, so a concurrent child insert cannot be omitted from the inventory.
  try {
    await armTenantKill(user.id, true);
  } catch {
    return { ok: false, error: "The emergency stop could not be armed. Nothing was deleted." };
  }

  const admin = serviceClient();

  // READ THE AVATAR PATH FIRST. delete_account_data (0024) cascades foreign
  // keys, and public.users is one of the rows it deletes — so after the RPC
  // there is nothing left to read the storage key from, and every avatar this
  // account ever uploaded would be orphaned in the bucket with no row anywhere
  // that names it. Nothing else can find it afterwards; there is no sweep.
  //
  // Reading it early costs one query on a path that is already doing far more,
  // and the value is null for the overwhelming majority of accounts.
  const { data: avatarRow } = await admin
    .from("users")
    .select("avatar_path")
    .eq("id", user.id)
    .maybeSingle();
  const avatarPath =
    avatarRow && typeof avatarRow.avatar_path === "string" ? avatarRow.avatar_path : null;

  const { data: deletionData, error: databaseError } = await admin.rpc("delete_account_data", {
    p_user_id: user.id,
  });
  if (databaseError) {
    await armTenantKill(user.id, false).catch(() => {});
    return { ok: false, error: "Account data could not be deleted. Please try again." };
  }
  const inventory = parseDeletionInventory(deletionData);
  if (!inventory) {
    await captureError(new Error("Account deletion returned an invalid cleanup inventory"), {
      route: "dashboard/settings/account-delete",
      event: "account_delete_inventory_invalid",
    });
  }

  // Storage is outside the RPC's reach — it cascades foreign keys, not buckets.
  // A failure here leaves an image nothing references, which is a quota
  // nuisance rather than a disclosure (the avatar_key that addressed it went
  // with the row), so it is reported and does not abort the deletion.
  let avatarOrphaned = false;
  if (avatarPath) {
    const removal = await admin.storage.from("avatars").remove([avatarPath]);
    avatarOrphaned = Boolean(removal.error);
    if (avatarOrphaned) {
      await captureError(new Error("Account deletion could not remove the stored avatar"), {
        route: "dashboard/settings/account-delete",
        event: "account_delete_avatar_orphaned",
      });
    }
  }

  const { error: authError } = await admin.auth.admin.deleteUser(user.id);
  if (authError) {
    await captureError(authError, {
      route: "dashboard/settings/account-delete",
      event: "account_delete_auth_failed",
    });
    // Database data and credentials are already gone. Keep the tenant kill armed
    // until an operator completes Auth cleanup; failing open here would briefly
    // re-admit a still-valid visa through a stale encrypted provider-key cache.
    return {
      ok: false,
      error: "Your data was erased, but sign-in cleanup needs operator attention. Contact hello@vertias.eu.",
    };
  }

  try {
    if (!inventory) return { ok: true, cleanupPending: true };
    await purgeAccountRuntimeState(
      redis(),
      user.id,
      inventory.agentIds,
      inventory.controlApiKeyIds
    );
    await armTenantKill(user.id, false);
    // An orphaned avatar is still incomplete cleanup, and this file already
    // refuses to say "Success!" when a cleanup step fails.
    return { ok: true, cleanupPending: avatarOrphaned };
  } catch (error) {
    await captureError(error, {
      route: "dashboard/settings/account-delete",
      event: "account_delete_redis_cleanup_failed",
    });
    // Temporary Redis data expires naturally; retain the kill key rather than
    // weakening revocation while a stale encrypted provider-key cache may live.
    return { ok: true, cleanupPending: true };
  }
}
