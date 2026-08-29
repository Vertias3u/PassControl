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
import { IDLE_WINDOW_MS } from "@/lib/control/auth";
import { ensureProfileRow } from "@/lib/profile/manage";
import { generateApiKey } from "@/lib/apikeys";
import {
  authHeaders,
  isProvider,
  modelListingUrl,
  type ProviderId,
} from "@/lib/providers";
import { purgeAgentCaches, purgeAgentFallbacks, purgeProviderKeysCache } from "@/lib/state/redis";
import { rateLimit, rateLimitFailClosed } from "@/lib/ratelimit";
import {
  GRANT_TTL_S,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  resolveUserCode,
  type PendingDevice,
} from "@/lib/state/device-auth";
import { normalizeUserCode } from "@/lib/device-codes";
import { open, seal } from "@/lib/crypto/aesgcm";
import { stashKeyImport, takeKeyImport } from "@/lib/state/redis";
import * as fleet from "@/lib/fleet";
import { mfaAuthorizedUser } from "@/lib/mfa";

async function requireUser() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new Error("not_authenticated");
  return { db, user };
}

type RequiredUser = Awaited<ReturnType<typeof requireUser>>;
type CreateAgentInput = {
  name: string;
  passportPubkey: string;
  scopes: { provider: string; models: string[] }[];
  budget_tokens?: number | null;
  budget_cents?: number | null;
};
type ProviderKeyInput = { provider: string; label: string; key: string };

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

/** Per-tenant master kill: flip Redis `killswitch:tenant:<uid>`, and nothing else.
 *
 * It does NOT suspend agent rows and does NOT purge the provider-key cache. Both claims
 * used to sit here and both were false: `purgeAgentCaches` is reached only from the
 * per-agent suspend and revoke paths (lib/fleet.ts), and `setTenantKill` is deliberately
 * independent of per-agent suspension so that disarming a tenant can never reactivate an
 * agent that was separately suspended or revoked (lib/fleet.ts:729-731).
 *
 * The Redis flag is the whole enforcement: the proxy reads it per call at check 2. */
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

// The gate lives here rather than on the exported wrapper so that every caller —
// standalone issuance today, the key-import on-ramp, whatever reuses this next —
// inherits it. Registering a passport is credential minting: the gateway will mint
// visas for that public key against this tenant's provider key and budget, which is
// the same blast radius a Direct Agent Key has and must clear the same gate.
async function createAgentForUser(
  { db, user }: RequiredUser,
  input: CreateAgentInput
): Promise<{ id: string; name: string; createdAt: string }> {
  await requireCredentialMfa(db, user);
  // Ensure profile row exists (FK target). Service role, not `db`: 0032 revokes
  // INSERT on public.users from `authenticated` for the same reason 0028 revoked
  // it on `agents`. This call used to run under the caller's JWT AND discard its
  // error, so after that revoke it would have failed silently and surfaced as an
  // unrelated foreign-key error from createAgent below.
  await ensureProfileRow(serviceClient(), user);
  // Service role, not `db`. 0028 revokes INSERT on `agents` from `authenticated`,
  // because the user-scoped write went over PostgREST under the caller's own JWT
  // and RLS can only ask who owns the row — never whether this session cleared a
  // second factor. An aal1 attacker could therefore replay this exact insert with
  // their own passport_pubkey and mint visas against the tenant's provider key.
  // The gate above is now the only way in, and `user.id` comes from the verified
  // server-side user (requireUser -> getUser), never from client input.
  const r = await fleet.createAgent(serviceClient(), user.id, input);
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
  return r.value;
}

/** Register a new agent passport (public key generated in the browser). */
export async function createAgent(
  input: CreateAgentInput
): Promise<{ agentId: string; createdAt: string }> {
  const created = await createAgentForUser(await requireUser(), input);
  return { agentId: created.id, createdAt: created.createdAt };
}

/**
 * The credential gate. Be precise about what it does and does not enforce:
 *
 *  - It is the STRICT helper (`mfaAuthorizedUser`), whose factor list comes from
 *    the auth server and whose unknown/error paths fail closed. It never reads the
 *    unsigned `session.user` cookie wrapper and never trusts a caller-threaded user.
 *  - An account WITH a verified factor must be at aal2. An aal1 session is refused.
 *  - An account with NO verified factor passes. That is not a hole being tolerated:
 *    there is no second factor to step up to, so the only alternatives are letting
 *    it through or locking every un-enrolled operator out of their own credentials.
 *    `lib/mfa.ts` decides this from the SERVER's factor list, so a forged cookie
 *    cannot invent a factor to deny service with either.
 *
 * So this is "second factor enforced wherever a second factor exists", not
 * "second factor enforced universally". Any wording that claims the latter is wrong.
 */
async function requireCredentialMfa(
  db: Awaited<ReturnType<typeof userClient>>,
  user: Awaited<ReturnType<typeof db.auth.getUser>>["data"]["user"]
): Promise<void> {
  // The strict helper performs its own network validation; it never trusts a
  // caller-threaded user or the unsigned session.user cookie wrapper.
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok || gate.user.id !== user?.id) {
    throw new Error(
      !gate.ok && gate.reason === "step_up_required"
        // Neutral about the verb on purpose: this gate also guards revocation, and
        // telling an operator who just pressed Revoke that they must verify "before
        // creating credentials" reads like they hit the wrong button.
        ? "Complete two-factor verification before changing credentials."
        : "Your authentication assurance could not be verified. Try again."
    );
  }
}

/** Create the browser-first on-ramp: one agent plus one reveal-once bearer key.
 * The key is returned from this action once and is never logged or persisted. */
export async function issueDirectAgent(input: {
  name: string;
  scopes: { provider: string; models: string[] }[];
  budget_tokens?: number | null;
  budget_cents?: number | null;
  keyName: string;
  expiresAt?: string | null;
}): Promise<{
  agentId: string;
  keyId: string;
  key: string;
  name: string;
  keyName: string;
  expiresAt: string | null;
}> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);
  // Service role, not `db` — see createAgentForUser above and 0032.
  try {
    await ensureProfileRow(serviceClient(), user);
  } catch {
    // A bounded machine code, which is all failGeneric wants to log — the
    // underlying Postgres message is not a safe log input.
    failGeneric("issueDirectAgent.profile", { code: "profile_row_unavailable" });
  }

  const result = await fleet.createDirectAgent(serviceClient(), user.id, input);
  if (!result.ok) throw new Error(result.message ?? "The Direct Agent Key could not be created.");

  await recordAdminAction({
    userId: user.id,
    action: "agent.create",
    targetType: "agent",
    targetId: result.value.agentId,
    metadata: {
      name: result.value.name,
      auth_method: "direct_key",
      key_name: result.value.keyName,
      suffix: result.value.key.slice(-8),
      expires_at: result.value.expiresAt,
    },
  });
  // The raw key exists only in this return value. Revalidating here can
  // remount DirectAgentConnect before it commits the credential to reveal-once
  // state; the component refreshes after the operator acknowledges storage.
  return result.value;
}

/** Add a named installation credential to an existing owned agent. */
export async function issueDirectAgentKey(
  agentId: string,
  input: { name: string; expiresAt?: string | null }
): Promise<{ keyId: string; key: string; name: string; expiresAt: string | null }> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);
  if (!UUID_RE.test(String(agentId))) throw new Error("This agent is unavailable.");
  const result = await fleet.createAgentAccessKey(serviceClient(), user.id, agentId, input);
  if (!result.ok) throw new Error(result.message ?? "The Direct Agent Key could not be created.");
  await recordAdminAction({
    userId: user.id,
    action: "agent.direct_key.create",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      name: result.value.name,
      suffix: result.value.key.slice(-8),
      expires_at: result.value.expiresAt,
    },
  });
  // The raw key exists only in this return value. DirectAgentKeyPanel refreshes
  // the agent page after the reveal-once acknowledgement, never before it.
  return result.value;
}

/** Revoke one bearer credential. This never deletes its immutable log links.
 *
 * This is the one REVOCATION behind the credential gate, while `revokeApiKey`,
 * `setAgentSuspended` and `setMasterKill` deliberately stay on `requireUser()`.
 * That asymmetry is intentional, and the rule behind it is:
 *
 *   **Every credential keeps at least one stop reachable without a step-up.**
 *
 * A Direct Agent Key is a data-plane credential bound to one agent, and the
 * gateway checks tenant kill and per-agent suspend on every call before it
 * resolves anything (`app/api/v1/[provider]/[...path]/route.ts`, step 2). So an
 * operator who cannot complete a step-up can still stop a leaking key instantly
 * with Suspend or the kill switch — both ungated — and what the gate defers is
 * only the permanent, irreversible lifecycle write.
 *
 * A `pc_` control-plane key has no such backstop: `lib/control/handler.ts` and
 * `lib/control/auth.ts` consult neither the kill switch nor agent suspension, so
 * `api_keys.revoked_at` IS the only stop that exists. Gating `revokeApiKey` would
 * make stopping that leak harder than creating it, which is the trade this file
 * refuses. `tests/credential-action-mfa.test.ts` pins both halves, including the
 * fact that the control plane reads no kill state — if that ever changes, this
 * rationale has to be revisited rather than inherited.
 */
export async function revokeDirectAgentKey(agentId: string, keyId: string): Promise<void> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);
  if (!UUID_RE.test(String(agentId)) || !UUID_RE.test(String(keyId))) {
    throw new Error("This credential is unavailable.");
  }
  const result = await fleet.revokeAgentAccessKey(serviceClient(), user.id, agentId, keyId);
  if (!result.ok) throw new Error(result.message ?? "This credential could not be revoked.");
  await recordAdminAction({
    userId: user.id,
    action: "agent.direct_key.revoke",
    targetType: "agent",
    targetId: agentId,
    metadata: { name: result.value.name, suffix: result.value.suffix },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  revalidatePath("/dashboard");
}

/** Upgrade a direct-first agent to passport signing in place. The private half
 * is generated and retained by the browser; this action accepts only public key material. */
export async function attachAgentPassport(agentId: string, passportPubkey: string): Promise<void> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);
  if (!UUID_RE.test(String(agentId))) throw new Error("This agent is unavailable.");
  const result = await fleet.attachAgentPassport(
    serviceClient(),
    user.id,
    agentId,
    passportPubkey
  );
  if (!result.ok) throw new Error(result.message ?? "The signing passport could not be attached.");
  await recordAdminAction({
    userId: user.id,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      fields: "passport_pubkey",
      via: "dashboard",
      from: JSON.stringify(null),
      to: JSON.stringify(result.value.passportPubkey),
      upgraded_from: "direct_key",
    },
  });
  // Do not revalidate here. The browser still holds the newly generated private
  // half only in component state; refreshing this route would unmount the
  // reveal-once dialog and destroy the key before the operator acknowledges it.
  // DirectAgentPassportUpgrade refreshes after the acknowledgement instead.
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
      via: "dashboard",
      from: JSON.stringify(before?.allowed_scopes ?? null),
      to: JSON.stringify(scopes),
    },
  });
  // The editor lives on the agent's own page; revalidating "/" alone would
  // leave the value the operator just changed still on screen.
  revalidatePath(`/dashboard/agents/${agentId}`);
  revalidatePath("/");
}

/**
 * Change which other providers the gateway may retry a failed call on.
 *
 * `userId` is taken from the session and is deliberately NOT a parameter, the
 * same tenant boundary updateAgentScopes rests on.
 *
 * ── Why this one purges and updateAgentScopes does not ───────────────────────
 *
 * Scope is a visa snapshot: there is nothing to purge, the change simply lands
 * on the next visa. Fallbacks are read live through a 60-second Redis cache
 * (lib/state/fallbacks.ts), and the direction that matters is REMOVAL — an
 * operator taking a provider off this list is usually doing it because calls
 * must stop being billed there. Waiting out a cache window for that is not
 * acceptable, so the purge is explicit.
 *
 * Best-effort, exactly as in addProviderKey: a Redis failure costs at most 60
 * seconds of a stale list, which must never be a reason to fail the operator's
 * save and leave the database and the screen disagreeing.
 */
export async function updateAgentFallbacks(
  agentId: string,
  fallbacks: { provider: string; model: string }[]
) {
  const { db, user } = await requireUser();
  // Read first, so the audit row can answer "which provider was this pointed at
  // BEFORE" — the question that matters when an unexpected provider bill turns
  // up. `fields: "fallbacks"` alone cannot answer it.
  const { data: before } = await db
    .from("agents")
    .select("fallbacks")
    .eq("user_id", user.id)
    .eq("id", agentId)
    .maybeSingle();

  const r = await fleet.updateAgent(db, user.id, agentId, { fallbacks });
  if (!r.ok) {
    console.error("[dashboard:updateAgentFallbacks]", r.code, r.message ?? "");
    throw new Error(r.message ?? "Something went wrong. Please try again.");
  }
  await purgeAgentFallbacks(user.id, agentId).catch(() => {});
  await recordAdminAction({
    userId: user.id,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      fields: "fallbacks",
      via: "dashboard",
      from: JSON.stringify(before?.fallbacks ?? null),
      to: JSON.stringify(fallbacks),
    },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  revalidatePath("/");
}

async function addProviderKeyForUser(
  { db, user }: RequiredUser,
  input: ProviderKeyInput,
  revalidate: boolean
): Promise<void> {
  // Gated on the helper, same reasoning as createAgentForUser. completeKeyImport
  // calls both and therefore checks twice; two auth round-trips on one onboarding
  // click is the right price for not having an "already checked" parameter, which
  // is exactly the bypass-shaped API lib/mfa.ts refuses to offer.
  await requireCredentialMfa(db, user);
  const clean = validateProviderKeyInput(input);
  // Service role, and the tenant is now an explicit argument. 0030 drops the
  // auth.uid()-derived RPCs: they were execute-able by `authenticated`, so an
  // aal1 session could reach them straight over /rest/v1/rpc and skip the gate
  // above. `user.id` comes from requireUser()/getUser() in this same request —
  // RLS is bypassed here, so this argument IS the tenant boundary.
  const { error } = await serviceClient().rpc("store_provider_key_for_user", {
    p_user_id: user.id,
    p_provider: clean.provider,
    p_label: clean.label,
    p_plaintext: clean.key,
  });
  if (error) failGeneric("addProviderKey", error);
  // The exhaustion branch caches this tenant's provider list for 5 minutes to
  // decide what an agent could fail over to. Adding a key is the only mutation
  // that changes the answer (rotate replaces a secret behind a row that already
  // existed), so one purge here is the whole invalidation story. Best-effort:
  // a failed purge costs at most 5 minutes of a not-yet-advertised alternative,
  // which must never be a reason to fail the operator's key import.
  await purgeProviderKeysCache(user.id).catch(() => {});
  await recordAdminAction({
    userId: user.id,
    action: "provider_key.add",
    targetType: "provider_key",
    metadata: { provider: clean.provider, label: clean.label },
  });
  if (revalidate) revalidatePath("/");
}

/** Add a provider key via the SECURITY DEFINER RPC (plaintext never stored in app tables). */
export async function addProviderKey(input: ProviderKeyInput) {
  await addProviderKeyForUser(await requireUser(), input, true);
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
}): Promise<{
  agentId: string;
  createdAt: string;
  provider: ProviderId;
  scope: { provider: ProviderId; models: string[] }[];
}> {
  const auth = await requireUser();
  const { user } = auth;
  // Redeem by id. takeKeyImport is an atomic GETDEL, so a replayed id after this
  // point finds nothing — the handoff is single-use, not merely expiring, and
  // two racing redemptions cannot both succeed. That last clause was untrue until
  // 2026-08-27; see tests/key-import-atomic.test.ts.
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

  // Use the same sanctioned Vault and fleet mutations as the standalone
  // actions, but deliberately defer their route revalidation. The browser has
  // generated the private passport and cannot commit it to reveal-once React
  // state until this action returns. Revalidating here remounts the on-ramp and
  // destroys that secret. KeyImportOnramp refreshes only after acknowledgement.
  await addProviderKeyForUser(auth, keyInput, false);
  const created = await createAgentForUser(auth, agentInput);
  return { agentId: created.id, createdAt: created.createdAt, provider, scope };
}

/**
 * Drop the gateway's sealed copy of a provider key for every agent of a tenant.
 *
 * The proxy caches the SEALED key at `key:<agentId>:<provider>` for
 * KEY_CACHE_TTL_S = 60. Nothing invalidated it, so rotating, switching or
 * deleting a credential left the previous secret being injected for up to a
 * minute — which during the 2026-08-17 incident was indistinguishable from the
 * fix not having worked, and sent the operator looking for a second bug.
 *
 * Per AGENT, because that is how the key is scoped, while a credential is per
 * TENANT — so one credential mutation has to fan out across the tenant's agents.
 * Bounded deliberately: past the cap the 60-second TTL is left to do the work
 * rather than turning one key save into an unbounded pipeline. Best-effort in
 * both directions, exactly as the fallbacks purge above: a Redis failure must
 * never fail the operator's save and leave the database and the screen
 * disagreeing. The cost of a miss is one cache window.
 */
const KEY_PURGE_AGENT_CAP = 200;

async function purgeProviderKeyForTenant(
  { db, user }: RequiredUser,
  provider: string
): Promise<void> {
  try {
    const { data } = await db
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .limit(KEY_PURGE_AGENT_CAP);
    await Promise.all(
      (data ?? []).map((agent: { id: string }) =>
        purgeAgentCaches(agent.id, [provider]).catch(() => {})
      )
    );
  } catch {
    // Deliberately empty — see above.
  }
}

/** The provider a credential row belongs to, or null when it is not this tenant's. */
async function ownedCredentialProvider(
  { db, user }: RequiredUser,
  credentialId: string
): Promise<string | null> {
  const { data } = await db
    .from("provider_credentials")
    .select("provider")
    .eq("user_id", user.id)
    .eq("id", credentialId)
    .maybeSingle();
  return typeof data?.provider === "string" ? data.provider : null;
}

/** Rotate a provider key behind an owned credential row. */
export async function rotateProviderKey(input: { credentialId: string; key: string }) {
  const auth = await requireUser();
  const { db, user } = auth;
  // Replacing the secret behind a credential row is the same authority as storing
  // one: the new key is what the proxy will inject from here on.
  await requireCredentialMfa(db, user);
  const clean = validateRotateInput(input);
  // Read the provider BEFORE the write: it is what the cache purge is keyed on,
  // and after a rotate the row still exists but we would be re-reading it for no
  // reason. After a delete it would be gone entirely — same shape, so both paths
  // read first and stay consistent.
  const provider = await ownedCredentialProvider(auth, clean.credentialId);
  const { error } = await serviceClient().rpc("rotate_provider_key_for_user", {
    p_user_id: user.id,
    p_credential_id: clean.credentialId,
    p_plaintext: clean.key,
  });
  if (error) failGeneric("rotateProviderKey", error);
  if (provider) await purgeProviderKeyForTenant(auth, provider);
  await recordAdminAction({
    userId: user.id,
    action: "provider_key.rotate",
    targetType: "provider_key",
    targetId: clean.credentialId,
  });
  revalidatePath("/");
}

/**
 * Choose which stored credential the gateway injects for a provider.
 *
 * Gated like a mint. It creates no secret, but it redirects every subsequent
 * call — and the spend behind it — onto a different upstream account, which is
 * the same authority as having stored the key.
 */
export async function setActiveProviderKey(input: { credentialId: string }) {
  const auth = await requireUser();
  const { db, user } = auth;
  await requireCredentialMfa(db, user);
  const credentialId = String(input?.credentialId ?? "").trim();
  if (!UUID_RE.test(credentialId)) throw new Error("Invalid credential id.");
  const provider = await ownedCredentialProvider(auth, credentialId);
  // Refuse here rather than letting the RPC's own 'credential not found' answer
  // it: this keeps a cross-tenant id indistinguishable from a missing one at the
  // action boundary, before any write is attempted.
  if (!provider) throw new Error("That credential could not be found.");
  const { error } = await serviceClient().rpc("set_active_provider_key_for_user", {
    p_user_id: user.id,
    p_credential_id: credentialId,
  });
  if (error) failGeneric("setActiveProviderKey", error);
  await purgeProviderKeyForTenant(auth, provider);
  await recordAdminAction({
    userId: user.id,
    action: "provider_key.activate",
    targetType: "provider_key",
    targetId: credentialId,
    metadata: { provider },
  });
  revalidatePath("/");
}

/**
 * Delete a stored credential and its Vault secret.
 *
 * The database refuses the ACTIVE credential (0027) rather than promoting a
 * replacement, so a delete can never quietly change which upstream account is
 * billed. That refusal is surfaced as its own sentence — a generic failure here
 * would read as a bug rather than as the deliberate "switch first" rule.
 */
export async function deleteProviderKey(input: { credentialId: string }) {
  const auth = await requireUser();
  const { db, user } = auth;
  await requireCredentialMfa(db, user);
  const credentialId = String(input?.credentialId ?? "").trim();
  if (!UUID_RE.test(credentialId)) throw new Error("Invalid credential id.");
  const provider = await ownedCredentialProvider(auth, credentialId);
  if (!provider) throw new Error("That credential could not be found.");
  const { error } = await serviceClient().rpc("delete_provider_key_for_user", {
    p_user_id: user.id,
    p_credential_id: credentialId,
  });
  if (error) {
    if (String(error.message ?? "").includes("active_credential")) {
      throw new Error(
        "That is the credential the gateway is using. Switch to another one first, then delete it."
      );
    }
    failGeneric("deleteProviderKey", error);
  }
  await purgeProviderKeyForTenant(auth, provider);
  await purgeProviderKeysCache(user.id).catch(() => {});
  await recordAdminAction({
    userId: user.id,
    action: "provider_key.delete",
    targetType: "provider_key",
    targetId: credentialId,
    metadata: { provider },
  });
  revalidatePath("/");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ONE place a `pc_` control-plane key is written. Not exported — this file is
 * "use server", so an export is an HTTP-addressable endpoint, and this must only
 * be reachable through a caller that has already decided the request is legitimate.
 *
 * Two callers today: `createApiKey` (the Settings form) and `approveCliDevice`
 * (`passcontrol login`). A third must reuse this rather than add an insert, and
 * `tests/credential-mint-server-only.test.ts` fails the build if it does otherwise
 * — it asserts this module contains exactly one api_keys insert. That guard exists
 * because every OTHER assertion in that file only checks that the mints we already
 * know about are done safely, which says nothing about one nobody enumerated.
 */
async function mintApiKeyForUser(
  db: Awaited<ReturnType<typeof userClient>>,
  user: NonNullable<Awaited<ReturnType<typeof db.auth.getUser>>["data"]["user"]>,
  name: string,
  scope: "read" | "write",
  // Null means the key never expires, which is what every key minted before
  // migration 0041 is and what a key created by hand in Settings stays. Only the
  // device flow passes a window, because only the device flow mints a key per
  // MACHINE — and machines get decommissioned while their owner forgets the key
  // ever existed. `authenticateApiKey` rolls this deadline forward on every use,
  // so the window retires idle keys and never a working one.
  expiresAt: string | null = null
): Promise<{ token: string; prefix: string }> {
  // A `pc_` key is control-plane authority — fleet reads, budget and scope writes,
  // the kill switch — and it is returned in full exactly once. It is the most
  // consequential credential minted anywhere in this file.
  await requireCredentialMfa(db, user);

  // The FK target. `api_keys.user_id references public.users(id)`, and profile
  // rows are created LAZILY here — there is no trigger on auth.users, by the
  // deliberate choice documented on ensureProfileRow itself.
  //
  // This was missing, and it is a PRE-EXISTING bug rather than one the device
  // flow introduced: `createApiKey` never ensured the row either, so Settings →
  // Create API key already failed with a bare "Something went wrong" for any
  // account that had not yet stored a provider key or saved a profile — the two
  // paths that happened to create it as a side effect.
  //
  // `passcontrol login` is what made it matter. It is now the FIRST command a new
  // operator runs, before any provider key exists, so the rare case became the
  // default one. Found by running the flow in a browser; every test in the suite
  // was green, because a source-shape guard cannot see a foreign key.
  await ensureProfileRow(serviceClient(), user);

  const { token, prefix, hash } = await generateApiKey();
  // Service role, not `db` — same reason as createAgentForUser above, and this is
  // the sink the bypass was found on: an aal1 session could POST /rest/v1/api_keys
  // with a self-chosen key_hash and scope='write', and lib/control/auth.ts
  // authenticates by hash lookup alone, so the row was a working control-plane
  // credential that outlived the stolen session. 0028 revokes INSERT.
  const { error } = await serviceClient().from("api_keys").insert({
    user_id: user.id,
    name,
    key_prefix: prefix,
    key_hash: hash,
    scope,
    expires_at: expiresAt,
  });
  if (error) failGeneric("mintApiKeyForUser", error);

  await recordAdminAction({
    userId: user.id,
    action: "apikey.create",
    targetType: "api_key",
    // The window is part of what was granted, so a reader of the trail can tell a
    // permanent key from an expiring one without joining back to the row.
    metadata: { name, scope, prefix, ...(expiresAt ? { expires_at: expiresAt } : {}) },
  });
  return { token, prefix };
}

/** Validate a key name. Shared so the CLI path cannot skip what the form does. */
function validateApiKeyName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (name.length < 1 || name.length > 80) throw new Error("Name must be 1–80 characters.");
  return name;
}

/** Mint a developer API key for the public control-plane API. The full token is
 *  returned ONCE here and never stored (only its hash + display prefix are). */
export async function createApiKey(input: { name: string; scope: "read" | "write" }): Promise<{
  token: string;
  prefix: string;
}> {
  const { db, user } = await requireUser();
  const name = validateApiKeyName(input?.name);
  if (input?.scope !== "read" && input?.scope !== "write") throw new Error("Scope must be read or write.");
  const minted = await mintApiKeyForUser(db, user, name, input.scope);
  revalidatePath("/");
  return minted;
}

// ── `passcontrol login` — browser approval of a CLI device flow ──────────────
//
// The CLI opens a login, prints an 8-character code, and polls. The operator
// brings that code here and approves once. What they are approving is a
// WRITE-SCOPED control-plane key on their own tenant, so the screen says so and
// this file treats it exactly like the Settings mint — because it is one.
//
// The code travels terminal → browser, never the reverse and never in a URL.
// See tests/cli-login-shape.test.ts for why that direction is load-bearing: a
// pre-filled approval link lets an attacker start the flow, send the link, and
// collect a key on the tenant of whoever clicks Approve.

const CLI_DEVICE_LOOKUP_LIMIT = 10;
const CLI_DEVICE_LOOKUP_WINDOW_S = 60;

/**
 * Resolve a user code, rate-limited FAIL-CLOSED.
 *
 * Not exported. Every caller below reaches the same reader so the limiter and
 * the attempt counter cannot be skipped by adding one more entry point.
 *
 * Fail-closed and not fail-open, unlike the kill-switch reads: this call is the
 * oracle that answers "is this code live?", so an unreadable Redis must not
 * degrade into an unmetered guessing endpoint. It is the `rateLimitFailClosed`
 * argument from the Direct Agent Key edge, applied to a different unauthenticated
 * -ish surface — the session is authenticated, but the CODE is attacker-supplied.
 */
async function lookupCliDevice(
  userId: string,
  rawCode: string,
  { count = true }: { count?: boolean } = {}
): Promise<{ code: string; pending: PendingDevice } | null> {
  const limit = await rateLimitFailClosed(
    `cli-device:${userId}`,
    CLI_DEVICE_LOOKUP_LIMIT,
    CLI_DEVICE_LOOKUP_WINDOW_S
  );
  if (!limit.success) throw new Error("Too many attempts. Wait a minute and try again.");

  // Reject a malformed code before it costs a round trip. normalizeUserCode does
  // NOT map homoglyphs — the alphabet excludes them, so a `0` is a wrong code and
  // repairing it would silently widen the guess space.
  const code = normalizeUserCode(rawCode);
  if (!code) return null;

  const pending = await resolveUserCode(code, { count });
  return pending ? { code, pending } : null;
}

/** What the approval screen shows before the operator commits. Never a secret. */
export async function inspectCliDevice(rawCode: string): Promise<{
  clientName: string;
  ip: string;
  requestedAt: string;
} | null> {
  const { db, user } = await requireUser();
  // Gated for the same reason approveCliDevice is, and it must be the SAME answer
  // in both places: if viewing were ungated while approving were not, an aal1
  // session would still get the oracle and lose nothing.
  await requireCredentialMfa(db, user);
  const found = await lookupCliDevice(user.id, rawCode);
  if (!found) return null;
  return {
    clientName: found.pending.clientName,
    ip: found.pending.ip,
    requestedAt: new Date(found.pending.createdAt).toISOString(),
  };
}

/**
 * Approve a pending CLI login: mint a write-scoped key and seal it for collection.
 *
 * The gate runs FIRST — before the lookup, not merely before the mint. That
 * ordering is the point and `tests/credential-action-mfa.test.ts` pins it: a gate
 * placed after the lookup still stops the mint, but the lookup has already told
 * an unverified caller whether the code is real and already spent one of that
 * code's five attempts. Both of those are the attack; the mint is just the prize.
 */
export async function approveCliDevice(rawCode: string): Promise<{ clientName: string }> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);

  // Does not consume an attempt: inspectCliDevice already charged for resolving
  // this code, and charging twice per approval quartered the operator's budget.
  const found = await lookupCliDevice(user.id, rawCode, { count: false });
  if (!found) throw new Error("That code is not valid, or it has expired. Run `passcontrol login` again.");

  // Write scope is not a default we drifted into: the CLI's next two calls are
  // agent create and passport rotate, both of which lib/control/handler.ts
  // requires write for. A read-only login could not finish provisioning.
  const minted = await mintApiKeyForUser(
    db,
    user,
    `CLI on ${found.pending.clientName}`,
    "write",
    // A window, because this is the one mint bound to a MACHINE. `passcontrol
    // login` is meant to be run on every laptop, container and CI runner an
    // operator has, and machines are decommissioned far more often than anyone
    // remembers to revoke a key. Rolling, so a machine still in use never loses
    // it — see IDLE_WINDOW_MS in lib/control/auth.ts.
    new Date(Date.now() + IDLE_WINDOW_MS).toISOString()
  );

  // The token goes into Redis SEALED, never in plaintext, and is keyed by the
  // hash of a device code only the CLI holds. Same handling as the key-import
  // handoff above, and for the same reason: a credential at rest in a cache is a
  // credential readable by anyone who can read the cache.
  await approveDeviceAuthorization({
    userCode: found.code,
    deviceCodeHash: found.pending.deviceCodeHash,
    sealedGrant: await seal(
      JSON.stringify({
        version: 1,
        userId: user.id,
        token: minted.token,
        prefix: minted.prefix,
        expiresAt: Date.now() + GRANT_TTL_S * 1000,
      })
    ),
  });

  await recordAdminAction({
    userId: user.id,
    action: "cli.device.approve",
    targetType: "api_key",
    // Prefix only. The token is not audit metadata, and neither is the code.
    metadata: { clientName: found.pending.clientName, prefix: minted.prefix },
  });
  revalidatePath("/");
  return { clientName: found.pending.clientName };
}

/**
 * Refuse a pending CLI login. Deliberately NOT behind requireCredentialMfa.
 *
 * This is a stop, and every credential in this file keeps at least one stop
 * reachable without a step-up — the rule that also leaves setMasterKill and
 * revokeApiKey ungated. Deny is the correct response to a code you did not
 * expect, so putting a TOTP prompt between a suspicious prompt and the button
 * that kills it would make the safe action the slow one.
 *
 * ACCEPTED COST, stated rather than hidden: this makes deny a code-validity
 * oracle too, and lets someone who guesses a live code kill a real operator's
 * login. It is bounded by the same fail-closed limiter and the same five-attempt
 * cap as every other reader — and the blast radius is a login that has to be
 * re-run, against an alternative where a phished operator cannot quickly refuse.
 */
export async function denyCliDevice(rawCode: string): Promise<void> {
  const { user } = await requireUser();
  const found = await lookupCliDevice(user.id, rawCode);
  if (!found) return;

  await denyDeviceAuthorization({
    userCode: found.code,
    deviceCodeHash: found.pending.deviceCodeHash,
  });
  await recordAdminAction({
    userId: user.id,
    action: "cli.device.deny",
    targetType: "api_key",
    metadata: { clientName: found.pending.clientName },
  });
  revalidatePath("/");
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
