"use server";
// Control Tower server actions. Ownership is enforced via the user-scoped
// Supabase client (RLS) before any privileged kill-switch / Redis write.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import {
  validateAgentInput,
  validateProviderKeyInput,
  validateRotateInput,
} from "@/lib/validate";
import { logSecurityEvent } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";
import { recordAdminAction } from "@/lib/audit";
import { generateApiKey } from "@/lib/apikeys";
import {
  authHeaders,
  isProvider,
  modelListingUrl,
  type ProviderId,
} from "@/lib/providers";
import { rateLimit } from "@/lib/ratelimit";
import { open, seal } from "@/lib/crypto/aesgcm";
import { stashKeyImport, takeKeyImport } from "@/lib/state/redis";
import * as fleet from "@/lib/fleet";

async function requireUser() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new Error("not_authenticated");
  return { db, user };
}

/** Log only the DB machine code; surface a generic message to the caller so no
 *  database internals or reflected credential material can leave this action. */
function failGeneric(
  context: string,
  error: { code?: string; message?: string } | null
): never {
  // Error messages from a credential RPC are not a safe log input: a database
  // or upstream can reflect submitted values. Keep only the bounded machine
  // code, which is sufficient to correlate the failure without risking a key.
  const safeCode = String(error?.code ?? "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40) || "unknown";
  console.error(`[dashboard:${context}]`, safeCode);
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

/**
 * Change what an agent is permitted to call.
 *
 * `userId` is taken from the session and is deliberately NOT a parameter — it
 * is the whole tenant boundary here, and `fleet.updateAgent` filters on it.
 *
 * The change does not take effect instantly: the proxy gates on the scope
 * SNAPSHOT carried in the visa, so an agent holding a live visa keeps its old
 * scope until that visa expires. The editor renders that delay from
 * `visaTtlSeconds()`. Use suspend or the kill switch when you need "now".
 */
export async function updateAgentScopes(
  agentId: string,
  scopes: { provider: string; models: string[] }[]
) {
  const { db, user } = await requireUser();
  // Read the current value first, so the audit row can answer "what was this
  // widened FROM". `fields: "allowed_scopes"` records that something changed
  // and nothing about whether someone opened an agent up to `*`.
  const { data: before } = await db
    .from("agents")
    .select("allowed_scopes")
    .eq("user_id", user.id)
    .eq("id", agentId)
    .maybeSingle();

  const r = await fleet.updateAgent(db, user.id, agentId, { scopes });
  if (!r.ok) {
    console.error("[dashboard:updateAgentScopes]", r.code, r.message ?? "");
    throw new Error(r.message ?? "Something went wrong. Please try again.");
  }
  await recordAdminAction({
    userId: user.id,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      fields: "allowed_scopes",
      from: JSON.stringify(before?.allowed_scopes ?? null),
      to: JSON.stringify(scopes),
    },
  });
  // The editor lives on the agent's own page; revalidating "/" alone would
  // leave the value the operator just changed still on screen.
  revalidatePath(`/dashboard/agents/${agentId}`);
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

const KEY_IMPORT_TENANT_LIMIT = 5;
const KEY_IMPORT_IP_LIMIT = 30;
const KEY_IMPORT_PROBE_WINDOW_S = 60;
const KEY_IMPORT_HANDOFF_TTL_S = 10 * 60;
const KEY_IMPORT_HANDOFF_TTL_MS = KEY_IMPORT_HANDOFF_TTL_S * 1000;

type ProbeSuccess = {
  ok: true;
  provider: ProviderId;
  mode: "detected" | "manual";
  models: string[];
  handoff: string;
};

type ProbeFailure = {
  ok: false;
  error: "invalid_key" | "rate_limited";
  message: string;
};

function clientIp(h: Headers): string {
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown"
  );
}

function modelIds(payload: unknown, rawKey: string): string[] {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const rows = Array.isArray(payload) ? payload : Array.isArray(record?.data) ? record.data : [];
  const unique = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = String((row as { id?: unknown }).id ?? "").trim();
    if (!id || id.length > 200 || id.includes(rawKey)) continue;
    unique.add(id);
    if (unique.size === 50) break;
  }
  return [...unique];
}

/**
 * Authenticated dashboard-only provider probe. The raw key is sent only in the
 * provider auth header. The browser receives model ids plus an encrypted,
 * tenant-bound handoff, never the plaintext key or an upstream error body.
 */
export async function probeProviderKey(input: {
  provider: string;
  key: string;
}): Promise<ProbeSuccess | ProbeFailure> {
  const { user } = await requireUser();
  const clean = validateProviderKeyInput({ provider: input?.provider, label: "", key: input?.key });
  if (!isProvider(clean.provider)) throw new Error("Unknown provider.");
  const provider = clean.provider;

  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  const [tenantLimit, ipLimit] = await Promise.all([
    rateLimit(
      `key-import-probe:tenant:${user.id}`,
      KEY_IMPORT_TENANT_LIMIT,
      KEY_IMPORT_PROBE_WINDOW_S
    ),
    rateLimit(
      `key-import-probe:ip:${ip}`,
      KEY_IMPORT_IP_LIMIT,
      KEY_IMPORT_PROBE_WINDOW_S
    ),
  ]);
  if (!tenantLimit.success || !ipLimit.success) {
    return {
      ok: false,
      error: "rate_limited",
      message: "Too many detection attempts. Please wait a minute and try again.",
    };
  }

  let mode: "detected" | "manual" = "manual";
  let models: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(modelListingUrl(provider), {
      method: "GET",
      headers: { accept: "application/json", ...authHeaders(provider, clean.key) },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 401) {
      return { ok: false, error: "invalid_key", message: "That key didn't work." };
    }
    if (response.ok) {
      models = modelIds(await response.json(), clean.key);
      mode = models.length ? "detected" : "manual";
    }
    // Any other status is intentionally manual-mode. In particular, a valid
    // key may lack model-list permission; its raw upstream body is never read.
  } catch {
    // Network failures and timeouts degrade to manual model selection. Never
    // log the exception: fetch implementations can reflect request details.
  } finally {
    clearTimeout(timer);
  }

  // The sealed key stays SERVER-SIDE in Redis; the browser receives only an
  // unguessable id. Sending the ciphertext to the client would put material
  // encrypted under CACHE_ENC_KEY — the same long-lived key protecting the
  // provider-key cache — into a JS heap, React DevTools, and any intermediary
  // log, and would leave it replayable for the whole TTL.
  const handoff = crypto.randomUUID();
  await stashKeyImport(
    user.id,
    handoff,
    await seal(JSON.stringify({
      version: 1,
      userId: user.id,
      provider,
      key: clean.key,
      expiresAt: Date.now() + KEY_IMPORT_HANDOFF_TTL_MS,
    })),
    KEY_IMPORT_HANDOFF_TTL_S
  );
  return { ok: true, provider, mode, models, handoff };
}

interface KeyImportHandoff {
  version: 1;
  userId: string;
  provider: ProviderId;
  key: string;
  expiresAt: number;
}

function parseKeyImportHandoff(value: string | null): KeyImportHandoff | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<KeyImportHandoff>;
    if (
      parsed.version !== 1 ||
      typeof parsed.userId !== "string" ||
      typeof parsed.provider !== "string" ||
      !isProvider(parsed.provider) ||
      typeof parsed.key !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed as KeyImportHandoff;
  } catch {
    return null;
  }
}

/** Complete a probed import through the existing Vault and fleet actions. */
export async function completeKeyImport(input: {
  handoff: string;
  provider: string;
  label: string;
  name: string;
  passportPubkey: string;
  models: string[];
}): Promise<{ provider: ProviderId; scope: { provider: ProviderId; models: string[] }[] }> {
  const { user } = await requireUser();
  // Redeem by id. takeKeyImport deletes unconditionally, so a replayed id after
  // this point finds nothing — the handoff is single-use, not merely expiring.
  const token = String(input?.handoff ?? "");
  const sealed = token.length > 0 && token.length <= 200
    ? await takeKeyImport(user.id, token)
    : null;
  const handoff = sealed ? parseKeyImportHandoff(await open(sealed)) : null;
  if (
    !handoff ||
    handoff.userId !== user.id ||
    handoff.provider !== input?.provider ||
    handoff.expiresAt < Date.now()
  ) {
    throw new Error("This key import has expired. Start again.");
  }

  const keyInput = validateProviderKeyInput({
    provider: input.provider,
    label: input.label,
    key: handoff.key,
  });
  const agentInput = validateAgentInput({
    name: input.name,
    passportPubkey: input.passportPubkey,
    scopes: [{ provider: input.provider, models: input.models }],
    budget_tokens: null,
    budget_cents: null,
  });
  const provider = handoff.provider;
  const scope = agentInput.scopes.map((entry) => ({
    provider: entry.provider as ProviderId,
    models: entry.models,
  }));

  // These are the existing sanctioned paths: store_provider_key via
  // addProviderKey, then the canonical fleet mutation via createAgent.
  await addProviderKey(keyInput);
  await createAgent(agentInput);
  return { provider, scope };
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
