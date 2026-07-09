"use server";
// Control Tower server actions. Ownership is enforced via the user-scoped
// Supabase client (RLS) before any privileged kill-switch / Redis write.
import { revalidatePath } from "next/cache";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import { validateProviderKeyInput, validateRotateInput } from "@/lib/validate";
import { logSecurityEvent } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";
import { recordAdminAction } from "@/lib/audit";
import { generateApiKey } from "@/lib/apikeys";
import * as fleet from "@/lib/fleet";

async function requireUser() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new Error("not_authenticated");
  return { db, user };
}

/** Log the real DB error server-side; surface a generic message to the caller so
 *  no database internals (table names, constraints, SQL) leak in a response.
 *  The message is sanitized (CR/LF/control chars stripped, bounded) so it can't
 *  forge or split log lines (log injection). */
function failGeneric(context: string, error: { message?: string } | null): never {
  const raw = error?.message ?? String(error);
  const safe = raw.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").slice(0, 300);
  console.error(`[dashboard:${context}]`, safe);
  throw new Error("Something went wrong. Please try again.");
}

/** Per-tenant master kill: flip Redis killswitch:tenant:<uid>; suspend+purge every owned agent. */
export async function setMasterKill(on: boolean) {
  const { db, user } = await requireUser();
  await fleet.setTenantKill(db, user.id, on);
  logSecurityEvent("killswitch.master", { user: user.id, on });
  await dispatchSecurityAlert("killswitch.master", { user: user.id, on });
  await recordAdminAction({ userId: user.id, action: "killswitch.master", metadata: { on } });
  revalidatePath("/");
}

/** Per-agent kill toggle. The session authenticates the owner; the server-only
 * fleet mutation enforces that owner with an explicit user_id filter. */
export async function setAgentSuspended(agentId: string, suspended: boolean) {
  const { user } = await requireUser();
  // Status is deliberately not client-updatable: use the server-only client
  // with fleet's explicit user_id filter so a revoked passport stays terminal.
  const r = await fleet.setAgentSuspended(serviceClient(), user.id, agentId, suspended);
  if (!r.ok) throw new Error("not_authorized");
  logSecurityEvent("agent.suspend", { user: user.id, agentId, suspended });
  await dispatchSecurityAlert("agent.suspend", { user: user.id, agentId, suspended });
  await recordAdminAction({
    userId: user.id,
    action: "agent.suspend",
    targetType: "agent",
    targetId: agentId,
    metadata: { suspended },
  });
  revalidatePath("/");
}

/** Register a new agent passport (public key generated in the browser). */
export async function createAgent(input: {
  name: string;
  passportPubkey: string;
  scopes: { provider: string; models: string[] }[];
  budget_tokens?: number | null;
  budget_cents?: number | null;
}) {
  const { db, user } = await requireUser();
  // Ensure profile row exists (FK target).
  await db.from("users").upsert({ id: user.id, email: user.email }).select("id");
  const r = await fleet.createAgent(db, user.id, input);
  if (!r.ok) {
    console.error("[dashboard:createAgent]", r.code, r.message ?? "");
    throw new Error(r.message ?? "Something went wrong. Please try again.");
  }
  await recordAdminAction({
    userId: user.id,
    action: "agent.create",
    targetType: "agent",
    targetId: r.value.id,
    metadata: { name: r.value.name },
  });
  revalidatePath("/");
}

export async function updateAgentBudgets(
  agentId: string,
  input: { budget_tokens: number | null; budget_cents: number | null }
) {
  const { db, user } = await requireUser();
  const r = await fleet.updateAgent(db, user.id, agentId, input);
  if (!r.ok) {
    console.error("[dashboard:updateAgentBudgets]", r.code, r.message ?? "");
    throw new Error(r.message ?? "Something went wrong. Please try again.");
  }
  await recordAdminAction({
    userId: user.id,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    metadata: { fields: "budget_tokens,budget_cents" },
  });
  revalidatePath("/");
}

/** Add a provider key via the SECURITY DEFINER RPC (plaintext never stored in app tables). */
export async function addProviderKey(input: { provider: string; label: string; key: string }) {
  const { db, user } = await requireUser();
  const clean = validateProviderKeyInput(input);
  const { error } = await db.rpc("store_provider_key", {
    p_provider: clean.provider,
    p_label: clean.label,
    p_plaintext: clean.key,
  });
  if (error) failGeneric("addProviderKey", error);
  await recordAdminAction({
    userId: user.id,
    action: "provider_key.add",
    targetType: "provider_key",
    metadata: { provider: clean.provider, label: clean.label },
  });
  revalidatePath("/");
}

/** Rotate a provider key behind an owned credential row. */
export async function rotateProviderKey(input: { credentialId: string; key: string }) {
  const { db, user } = await requireUser();
  const clean = validateRotateInput(input);
  const { error } = await db.rpc("rotate_provider_key", {
    p_credential_id: clean.credentialId,
    p_plaintext: clean.key,
  });
  if (error) failGeneric("rotateProviderKey", error);
  await recordAdminAction({
    userId: user.id,
    action: "provider_key.rotate",
    targetType: "provider_key",
    targetId: clean.credentialId,
  });
  revalidatePath("/");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mint a developer API key for the public control-plane API. The full token is
 *  returned ONCE here and never stored (only its hash + display prefix are). */
export async function createApiKey(input: { name: string; scope: "read" | "write" }): Promise<{
  token: string;
  prefix: string;
}> {
  const { db, user } = await requireUser();
  const name = String(input?.name ?? "").trim();
  if (name.length < 1 || name.length > 80) throw new Error("Name must be 1–80 characters.");
  if (input?.scope !== "read" && input?.scope !== "write") throw new Error("Scope must be read or write.");

  const { token, prefix, hash } = await generateApiKey();
  const { error } = await db.from("api_keys").insert({
    user_id: user.id,
    name,
    key_prefix: prefix,
    key_hash: hash,
    scope: input.scope,
  });
  if (error) failGeneric("createApiKey", error);

  await recordAdminAction({
    userId: user.id,
    action: "apikey.create",
    targetType: "api_key",
    metadata: { name, scope: input.scope, prefix },
  });
  revalidatePath("/");
  return { token, prefix };
}

/** Revoke an API key (soft delete). Ownership enforced by RLS — the update
 *  returns 0 rows if the key isn't the caller's. */
export async function revokeApiKey(id: string): Promise<void> {
  const { db, user } = await requireUser();
  if (!UUID_RE.test(String(id))) throw new Error("Invalid key id.");
  const { data, error } = await db
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .select("id, key_prefix")
    .maybeSingle();
  if (error) failGeneric("revokeApiKey", error);
  if (!data) throw new Error("Key not found or already revoked.");

  await recordAdminAction({
    userId: user.id,
    action: "apikey.revoke",
    targetType: "api_key",
    targetId: id,
    metadata: { prefix: data.key_prefix },
  });
  revalidatePath("/");
}
