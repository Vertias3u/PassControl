"use server";
// Control Tower server actions. Ownership is enforced via the user-scoped
// Supabase client (RLS) before any privileged kill-switch / Redis write.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import {
  validateAgentInput,
  validateAgentProfileInput,
  validateProviderKeyInput,
  validateRotateInput,
} from "@/lib/validate";
import { logSecurityEvent } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";
import { recordAdminAction } from "@/lib/audit";
import { IDLE_WINDOW_MS } from "@/lib/control/auth";
import { ensureProfileRow } from "@/lib/profile/manage";
import { generateApiKey } from "@/lib/apikeys";
import { azureEndpointSuggestion, endpointPolicy, normalizeEndpointFor } from "@/lib/providers/endpoint";
import { OLLAMA_ENDPOINT, listLocalModels } from "@/lib/providers/local-server";
import { wizardServiceRules, type WizardServiceChoice } from "@/lib/services/presets";
import {
  authHeaders,
  isProvider,
  modelListingUrl,
  providerRequiresEndpoint,
  type ProviderId,
} from "@/lib/providers";
import {
  purgeAgentCaches,
  purgeAgentFallbacks,
  purgeProviderKeysCache,
  readSuspensionFlag,
} from "@/lib/state/redis";
import { rateLimit, rateLimitFailClosed } from "@/lib/ratelimit";
import { accountLimitFrom, accountLimitMessage } from "@/lib/account-limits";
import { agentCreationRefusal, type AgentCapacityDb } from "@/lib/agent-capacity";
import { validateDirectKeyMetadata } from "@/lib/auth/direct-key";
import { captureError } from "@/lib/observability";
import { ActionError, type ActionResult } from "@/lib/action-result";
import { runAction } from "@/lib/run-action";
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
import { observeKillState } from "@/lib/state/killswitch";

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
  /** Omit for the product default; explicit null is the deliberate never-expire opt-out. */
  expiresAt?: string | null;
};
type ProviderKeyInput = {
  provider: string;
  label: string;
  key: string;
  /** Required for a provider with no host of its own (Azure); ignored otherwise. */
  endpoint?: string;
};

/**
 * The refusal for an Azure address we will not store, naming what to type.
 * Refused rather than rewritten (lib/providers/endpoint.ts): what is stored is
 * what the operator entered.
 */
function azureEndpointError(raw: string): Error {
  const suggestion = azureEndpointSuggestion(raw);
  return new ActionError(
    suggestion
      ? `Use ${suggestion}. Azure's v1 API lives under /openai/v1 on your resource.`
      : "An Azure key needs its resource's v1 address: https://<resource>.openai.azure.com/openai/v1 (or https://<resource>.services.ai.azure.com/openai/v1)."
  );
}

/**
 * The refusal for a credential whose address is part of it, in that provider's
 * terms: Azure names the resource shape, `local` names the gate or the address.
 */
function endpointRequiredError(provider: string, raw: string): Error {
  if (provider !== "local") return azureEndpointError(raw);
  const policy = endpointPolicy();
  if (policy.kind === "off") return localModelsDisabledError();
  return new ActionError(
    policy.kind === "allowlist"
      ? "A local credential needs its server's address, at a host this deployment's PROVIDER_ENDPOINT_MODE lists."
      : "A local credential needs its server's address, such as http://localhost:11434/v1 for Ollama."
  );
}

function localModelsDisabledError(): Error {
  return new ActionError(
    "Local models are not enabled on this deployment. Set PROVIDER_ENDPOINT_MODE=selfhost to turn them on."
  );
}

/** Log only the DB machine code; surface a generic message to the caller so no
 *  database internals or reflected credential material can leave this action. */
/**
 * Run one of lib/validate's form checks and show its message. Those messages are
 * fixed text written for the form ("Unknown provider.", "Label too long.") and
 * never include what was submitted, so they may cross to the browser; as plain
 * Errors, runAction would replace them with the generic message.
 */
function formCheck<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw new ActionError(error instanceof Error ? error.message : "Invalid input.");
  }
}

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
  throw new ActionError("Something went wrong. Please try again.");
}

/**
 * What arming/disarming the fleet kill switch asked for and then OBSERVED.
 * `platform` is PassControl's own stop, which a tenant can see but not change.
 * `null` = that read failed.
 */
export interface KillObservation {
  requested: boolean;
  tenant: boolean | null;
  platform: boolean | null;
  confirmed: boolean;
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
async function setMasterKillBody(on: boolean): Promise<KillObservation> {
  const { db, user } = await requireUser();
  let applied = false;
  try {
    await fleet.setTenantKill(db, user.id, on);
    applied = true;
  } catch {
    // Reported through the readback below: an operator pressing Stop needs
    // "could not confirm", not an exception that says nothing about the state.
  }
  if (applied) {
    logSecurityEvent("killswitch.master", { user: user.id, on });
    await dispatchSecurityAlert("killswitch.master", { user: user.id, on });
    await recordAdminAction({ userId: user.id, action: "killswitch.master", metadata: { on } });
  }
  const observed = await observeKillState(user.id);
  revalidatePath("/");
  return { requested: on, ...observed, confirmed: observed.tenant === on };
}

/** Read-only re-check of the fleet kill switch, behind "Refresh status". */
async function observeMasterKillBody(requested: boolean): Promise<KillObservation> {
  const { user } = await requireUser();
  const observed = await observeKillState(user.id);
  return { requested: requested === true, ...observed, confirmed: observed.tenant === (requested === true) };
}

export type ControlIntent = "suspended" | "active";

/**
 * What a suspend/reactivate asked for and what was then OBSERVED — v1 playbook
 * Contract C. `null` on either layer means that read failed. `confirmed` only
 * when both layers show the intent: the database status (which the Direct
 * Agent Key lookup reads) AND the Redis flag (which every call reads). One
 * layer alone is exactly the partial state an operator must see.
 */
export interface AgentControlObservation {
  agentId: string;
  requested: ControlIntent;
  database: "active" | "suspended" | "revoked" | null;
  suspensionFlag: boolean | null;
  confirmed: boolean;
}

function observation(
  agentId: string,
  requested: ControlIntent,
  database: AgentControlObservation["database"],
  suspensionFlag: boolean | null
): AgentControlObservation {
  const confirmed = requested === "suspended"
    ? database === "suspended" && suspensionFlag === true
    : database === "active" && suspensionFlag === false;
  return { agentId, requested, database, suspensionFlag, confirmed };
}

/** The agent's status through the caller's own RLS read: undefined = not theirs, null = unreadable. */
async function readOwnAgentStatus(
  { db, user }: RequiredUser,
  agentId: string
): Promise<AgentControlObservation["database"] | undefined> {
  const { data, error } = await db
    .from("agents")
    .select("status")
    .eq("id", agentId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return null;
  if (!data) return undefined;
  const status = (data as { status?: unknown }).status;
  return status === "active" || status === "suspended" || status === "revoked" ? status : null;
}

/** Per-agent suspend/reactivate as a DESIRED STATE, never a toggle.
 *
 * The caller states the intent; a retry re-sends the same intent, so a lost
 * response can never flip an applied stop back. The fleet mutation is ordered
 * for safety and idempotent on retry (block first when suspending, persist
 * active first when resuming). A failure part-way is reported through the
 * readback rather than thrown: "the database says active but the gateway still
 * refuses" is the answer the operator needs, and an exception says nothing.
 *
 * Stays on requireUser(): a stop is never behind a step-up. */
async function setAgentSuspendedBody(
  agentId: string,
  suspended: boolean
): Promise<AgentControlObservation> {
  const auth = await requireUser();
  const { user } = auth;
  const requested: ControlIntent = suspended ? "suspended" : "active";
  let applied = false;
  try {
    // Status is deliberately not client-updatable: use the server-only client
    // with fleet's explicit user_id filter so a revoked passport stays terminal.
    const r = await fleet.setAgentSuspended(serviceClient(), user.id, agentId, suspended);
    if (!r.ok) throw new Error("not_authorized");
    applied = true;
  } catch (error) {
    // Not this caller's agent: refused, and said in the words the other agent
    // actions use. The sentinel stays internal so a layer failure is not mistaken
    // for it.
    if ((error as Error).message === "not_authorized") throw new ActionError("This agent is unavailable.");
    // A layer failed part-way. Fall through to the readback.
  }
  if (applied) {
    logSecurityEvent("agent.suspend", { user: user.id, agentId, suspended });
    await dispatchSecurityAlert("agent.suspend", { user: user.id, agentId, suspended });
    await recordAdminAction({
      userId: user.id,
      action: "agent.suspend",
      targetType: "agent",
      targetId: agentId,
      metadata: { suspended },
    });
  }
  const [database, suspensionFlag] = await Promise.all([
    readOwnAgentStatus(auth, agentId),
    readSuspensionFlag(agentId),
  ]);
  revalidatePath("/");
  return observation(agentId, requested, database ?? null, suspensionFlag);
}

/** Read-only: where does this agent's stop actually stand? Behind "Refresh status". */
async function observeAgentControlBody(
  agentId: string,
  requested: ControlIntent
): Promise<AgentControlObservation> {
  const auth = await requireUser();
  if (!UUID_RE.test(String(agentId))) throw new ActionError("This agent is unavailable.");
  const intent: ControlIntent = requested === "suspended" ? "suspended" : "active";
  // Ownership through the caller's own read BEFORE any Redis key is touched,
  // so this cannot be used to probe other tenants' agent ids.
  const database = await readOwnAgentStatus(auth, agentId);
  if (database === undefined) throw new ActionError("This agent is unavailable.");
  if (database === null) return observation(agentId, intent, null, null);
  return observation(agentId, intent, database, await readSuspensionFlag(agentId));
}

// The gate lives here rather than on the exported wrapper so that every caller —
// standalone issuance today, the key-import on-ramp, whatever reuses this next —
// inherits it. Registering a passport is credential minting: the gateway will mint
// visas for that public key against this tenant's provider key and budget, which is
// the same blast radius a Direct Agent Key has and must clear the same gate.
async function createAgentForUser(
  { db, user }: RequiredUser,
  input: CreateAgentInput
): Promise<{ id: string; name: string; createdAt: string; expiresAt: string | null }> {
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
    throw new ActionError(r.message ?? "Something went wrong. Please try again.");
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
async function createAgentBody(
  input: CreateAgentInput
): Promise<{ agentId: string; createdAt: string; expiresAt: string | null }> {
  const created = await createAgentForUser(await requireUser(), input);
  return { agentId: created.id, createdAt: created.createdAt, expiresAt: created.expiresAt };
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
    throw new ActionError(
      !gate.ok && gate.reason === "step_up_required"
        // Neutral about the verb on purpose: this gate also guards revocation, and
        // telling an operator who just pressed Revoke that they must verify "before
        // creating credentials" reads like they hit the wrong button.
        ? "Complete two-factor verification before changing credentials."
        : "Your authentication assurance could not be verified. Try again."
    );
  }
}

type DirectAgentInput = {
  name: string;
  scopes: { provider: string; models: string[] }[];
  budget_tokens?: number | null;
  budget_cents?: number | null;
  keyName: string;
  expiresAt?: string | null;
  /** Service access ticked in "Connect an agent" (lib/services/presets.ts, WIZARD_SERVICE_DEFAULTS). */
  services?: WizardServiceChoice[];
};
type IssuedDirectAgent = {
  agentId: string;
  keyId: string;
  key: string;
  name: string;
  keyName: string;
  expiresAt: string | null;
  /** The services whose rules were saved on the new agent. */
  servicesGranted?: string[];
  /** False when the rules could not be saved: the agent exists, without them. */
  servicesSaved?: boolean;
};

// How many credential rows the provider check reads. Metadata only (the
// provider column); far above any real tenant's key count, and bounded so the
// check cannot become an unbounded scan.
const STORED_PROVIDER_SCAN = 200;

/**
 * Every provider this worker is scoped to must have a stored key, or the
 * credential is unusable: the gateway answers `no_provider_key` to every call,
 * which reads to a new user like a broken product rather than a missing step.
 *
 * A failed read refuses rather than guessing "stored" — the operator gets a
 * retry, not a credential that cannot work. Runs AFTER the credential gate so
 * an unverified session learns nothing about which keys are stored.
 */
async function requireStoredProviders(
  { db, user }: RequiredUser,
  scopes: unknown
): Promise<void> {
  const wanted = new Set(
    (Array.isArray(scopes) ? scopes : [])
      .map((entry) => (entry && typeof entry === "object" ? (entry as { provider?: unknown }).provider : null))
      .filter((provider): provider is string => typeof provider === "string" && provider.length > 0)
  );
  if (wanted.size === 0) return; // validation below rejects an empty grant with its own message
  const { data, error } = await db
    .from("provider_credentials")
    .select("provider")
    .eq("user_id", user.id)
    .limit(STORED_PROVIDER_SCAN);
  if (error || !Array.isArray(data)) {
    throw new ActionError("PassControl could not confirm which provider keys are stored. Try again.");
  }
  const stored = new Set(data.map((row: { provider?: unknown }) => row.provider));
  for (const provider of wanted) {
    if (!stored.has(provider)) {
      throw new ActionError(
        `No ${provider} provider key is stored in PassControl yet. Add one before creating this worker's credential.`
      );
    }
  }
}

// The one place a Direct Agent Key agent is minted. Gated here, not on the
// exported wrappers, for the same reason as createAgentForUser: the dashboard
// form and the key-import on-ramp both reuse it, and the next caller inherits
// the gate instead of re-introducing the gap.
async function issueDirectAgentForUser(
  auth: RequiredUser,
  input: DirectAgentInput
): Promise<IssuedDirectAgent> {
  const { db, user } = auth;
  await requireCredentialMfa(db, user);
  await requireStoredProviders(auth, input?.scopes);
  // Checked before anything is created: a bad choice must not leave an agent
  // behind with a key nobody saw.
  const services = wizardServiceRules(input?.services);
  if (!services.ok) throw new ActionError(services.message);
  // Service role, not `db` — see createAgentForUser above and 0032.
  try {
    await ensureProfileRow(serviceClient(), user);
  } catch {
    // A bounded machine code, which is all failGeneric wants to log — the
    // underlying Postgres message is not a safe log input.
    failGeneric("issueDirectAgent.profile", { code: "profile_row_unavailable" });
  }

  const result = await fleet.createDirectAgent(serviceClient(), user.id, input);
  if (!result.ok) throw new ActionError(result.message ?? "The Direct Agent Key could not be created.");

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
  // Service access, written AFTER the agent exists (create_direct_agent takes
  // no rules) and never allowed to fail the call: the key below is shown once,
  // so a failed write is reported beside it rather than thrown over it.
  let servicesGranted: string[] = [];
  let servicesSaved = true;
  if (services.document) {
    const { data: updated, error } = await serviceClient()
      .from("agents")
      .update({ service_rules: services.document })
      .eq("id", result.value.agentId)
      .eq("user_id", user.id)
      .select("id");
    if (error || !Array.isArray(updated) || updated.length !== 1) {
      servicesSaved = false;
    } else {
      servicesGranted = services.granted;
      for (const service of services.granted) {
        const allow = services.document[service]!.allow;
        await recordAdminAction({
          userId: user.id,
          action: "agent.service_rules",
          targetType: "agent",
          targetId: result.value.agentId,
          metadata: { service, rules: allow.length, ask: allow.filter((rule) => rule.ask === true).length, max_requests_per_hour: null },
        });
      }
    }
  }
  // The raw key exists only in this return value. Revalidating here can
  // remount DirectAgentConnect before it commits the credential to reveal-once
  // state; the component refreshes after the operator acknowledges storage.
  return { ...result.value, servicesGranted, servicesSaved };
}

/** Create the browser-first on-ramp: one agent plus one reveal-once bearer key.
 * The key is returned from this action once and is never logged or persisted. */
async function issueDirectAgentBody(input: DirectAgentInput): Promise<IssuedDirectAgent> {
  return issueDirectAgentForUser(await requireUser(), input);
}

/** Add a named installation credential to an existing owned agent. */
async function issueDirectAgentKeyBody(
  agentId: string,
  input: { name: string; expiresAt?: string | null }
): Promise<{ keyId: string; key: string; name: string; expiresAt: string | null }> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);
  if (!UUID_RE.test(String(agentId))) throw new ActionError("This agent is unavailable.");
  const result = await fleet.createAgentAccessKey(serviceClient(), user.id, agentId, input);
  if (!result.ok) throw new ActionError(result.message ?? "The Direct Agent Key could not be created.");
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
async function revokeDirectAgentKeyBody(agentId: string, keyId: string): Promise<void> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);
  if (!UUID_RE.test(String(agentId)) || !UUID_RE.test(String(keyId))) {
    throw new ActionError("This credential is unavailable.");
  }
  const result = await fleet.revokeAgentAccessKey(serviceClient(), user.id, agentId, keyId);
  if (!result.ok) throw new ActionError(result.message ?? "This credential could not be revoked.");
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
async function attachAgentPassportBody(agentId: string, passportPubkey: string): Promise<void> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);
  if (!UUID_RE.test(String(agentId))) throw new ActionError("This agent is unavailable.");
  const result = await fleet.attachAgentPassport(
    serviceClient(),
    user.id,
    agentId,
    passportPubkey
  );
  if (!result.ok) throw new ActionError(result.message ?? "The signing passport could not be attached.");
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

async function updateAgentBudgetsBody(
  agentId: string,
  input: {
    budget_tokens: number | null;
    budget_cents: number | null;
    /** The periodic limit (K1). Omitted leaves it as it is. */
    budget_period?: "day" | "month" | null;
    budget_period_cents?: number | null;
  }
) {
  const { db, user } = await requireUser();
  const r = await fleet.updateAgent(db, user.id, agentId, input);
  if (!r.ok) {
    console.error("[dashboard:updateAgentBudgets]", r.code, r.message ?? "");
    throw new ActionError(r.message ?? "Something went wrong. Please try again.");
  }
  await recordAdminAction({
    userId: user.id,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    // `budgets_live` records whether the LIVE GATE had picked the new cap up by
    // the time this action returned, which is a different question from whether
    // the row was written. False means the policy-cache invalidation did not
    // land, so the old cap can still admit calls for up to one cache window —
    // worth having in the audit trail when someone asks why a lowered budget
    // took a minute to bite.
    metadata: {
      fields:
        input.budget_period !== undefined
          ? "budget_tokens,budget_cents,budget_period,budget_period_cents"
          : "budget_tokens,budget_cents",
      budgets_live: r.value.budgetsLive ?? null,
    },
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
async function updateAgentScopesBody(
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
    throw new ActionError(r.message ?? "Something went wrong. Please try again.");
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
async function updateAgentFallbacksBody(
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
    throw new ActionError(r.message ?? "Something went wrong. Please try again.");
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

/** Returns the new credential's id (null if the RPC did not report one). */
async function addProviderKeyForUser(
  auth: RequiredUser,
  input: ProviderKeyInput,
  revalidate: boolean
): Promise<string | null> {
  const { db, user } = auth;
  // Gated on the helper, same reasoning as createAgentForUser. completeKeyImport
  // calls both and therefore checks twice; two auth round-trips on one onboarding
  // click is the right price for not having an "already checked" parameter, which
  // is exactly the bypass-shaped API lib/mfa.ts refuses to offer.
  await requireCredentialMfa(db, user);
  const clean = formCheck(() => validateProviderKeyInput(input));
  // An Azure key is unusable without its resource address, so it is checked
  // BEFORE anything is stored: an import path that has no address to give (the
  // key-import on-ramp) is refused here rather than leaving a key that every
  // call answers `endpoint_required`.
  let endpoint: string | null = null;
  if (isProvider(clean.provider) && providerRequiresEndpoint(clean.provider)) {
    const raw = String(input?.endpoint ?? "").trim();
    endpoint = normalizeEndpointFor(clean.provider, raw);
    if (!endpoint) throw endpointRequiredError(clean.provider, raw);
  }
  // Service role, and the tenant is now an explicit argument. 0030 drops the
  // auth.uid()-derived RPCs: they were execute-able by `authenticated`, so an
  // aal1 session could reach them straight over /rest/v1/rpc and skip the gate
  // above. `user.id` comes from requireUser()/getUser() in this same request —
  // RLS is bypassed here, so this argument IS the tenant boundary.
  const { data: credentialId, error } = await serviceClient().rpc("store_provider_key_for_user", {
    p_user_id: user.id,
    p_provider: clean.provider,
    p_label: clean.label,
    p_plaintext: clean.key,
  });
  if (error) {
    // 0076's refusal is safe to put into words: the sentence is built from the
    // parsed kind and number, never from the raw message (see failGeneric).
    const limit = accountLimitFrom(error);
    if (limit) throw new ActionError(accountLimitMessage(limit));
    failGeneric("addProviderKey", error);
  }
  if (endpoint) {
    // Written to the row the RPC just created, by its id — never "the newest
    // Azure row", which a concurrent add could make a different credential.
    //
    // Two statements, not one transaction. Between them the key exists with no
    // address, and a call landing there is refused `endpoint_required`: the gap
    // fails CLOSED, so it is stated here rather than bought with a migration.
    if (typeof credentialId !== "string") failGeneric("addProviderKey:id", new Error("no credential id"));
    const { error: endpointError } = await serviceClient()
      .from("provider_credentials")
      .update({ endpoint_base_url: endpoint })
      .eq("user_id", user.id) // tenant boundary — service_role bypasses RLS
      .eq("id", credentialId as string);
    if (endpointError) failGeneric("addProviderKey:endpoint", endpointError);
    // A call in that gap cached "no address" for the TTL; this clears it.
    await purgeProviderKeyForTenant(auth, clean.provider);
  }
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
    metadata: { provider: clean.provider, label: clean.label, ...(endpoint ? { endpoint } : {}) },
  });
  if (revalidate) revalidatePath("/");
  return typeof credentialId === "string" ? credentialId : null;
}

/** Add a provider key via the SECURITY DEFINER RPC (plaintext never stored in app tables). */
async function addProviderKeyBody(input: ProviderKeyInput) {
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
  /** Distinct ids the provider listed, which may exceed `models.length`. */
  modelsTotal: number;
  handoff: string;
};

type ProbeFailure = {
  ok: false;
  error: "invalid_key" | "rate_limited" | "endpoint_required";
  message: string;
};

function clientIp(h: Headers): string {
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * How many discovered ids the probe hands back.
 *
 * This bound exists to keep a hostile or eccentric `/models` response from
 * arriving unbounded. It is deliberately NOT `LIMITS.models`.
 *
 * It used to be 50, which is exactly `LIMITS.models` — the maximum number of
 * patterns one scope entry may hold. Nothing in the code linked the two numbers
 * and nothing explained them, but the onramp pasted this list straight into the
 * grant, so OpenAI's listing filled a scope to the validator's ceiling before
 * the operator chose anything. Adding one more real model then failed with
 * "Invalid models in scope." Discovery answers "what does this key reach";
 * `LIMITS.models` answers "how much may one grant authorize". They are
 * different questions and they no longer share a number.
 */
const MODEL_DISCOVERY_LIMIT = 200;

/** Distinct model ids from a provider listing, plus how many there really were. */
function modelIds(payload: unknown, rawKey: string): { ids: string[]; total: number } {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const rows = Array.isArray(payload) ? payload : Array.isArray(record?.data) ? record.data : [];
  const unique = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = String((row as { id?: unknown }).id ?? "").trim();
    if (!id || id.length > 200 || id.includes(rawKey)) continue;
    unique.add(id);
    // Counting continues past the slice so `total` can be honest. The UI says
    // "showing N of M" rather than implying the returned list is everything —
    // a truncated list presented as complete is how an operator concludes a
    // model is unavailable when it simply was not shown.
    //
    // `total` is therefore exact up to this scan ceiling and reads as the
    // ceiling beyond it. No provider lists anywhere near 800 models; the bound
    // is here so a hostile response cannot make this loop unbounded, and a count
    // that understates a listing nobody has is the safe direction to be wrong in.
    if (unique.size >= MODEL_DISCOVERY_LIMIT * 4) break;
  }
  const all = [...unique];
  return { ids: all.slice(0, MODEL_DISCOVERY_LIMIT), total: all.length };
}

/**
 * Authenticated dashboard-only provider probe. The raw key is sent only in the
 * provider auth header. The browser receives model ids plus an encrypted,
 * tenant-bound handoff, never the plaintext key or an upstream error body.
 */
async function probeProviderKeyBody(input: {
  provider: string;
  key: string;
}): Promise<ProbeSuccess | ProbeFailure> {
  const { user } = await requireUser();
  const clean = formCheck(() => validateProviderKeyInput({ provider: input?.provider, label: "", key: input?.key }));
  if (!isProvider(clean.provider)) throw new ActionError("Unknown provider.");
  const provider = clean.provider;
  // No host to probe: an Azure key is only meaningful with its resource address,
  // which this on-ramp does not ask for. Refused before the rate limit is spent.
  const listingUrl = modelListingUrl(provider);
  if (listingUrl === null) {
    return {
      ok: false,
      error: "endpoint_required",
      message: "An Azure key needs its resource address. Add it under Settings, Provider credentials.",
    };
  }

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
  let modelsTotal = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(listingUrl, {
      method: "GET",
      headers: { accept: "application/json", ...authHeaders(provider, clean.key) },
      cache: "no-store",
      signal: controller.signal,
      // Same guard as the proxy's forward fetch, for the same reason: this
      // carries the user's key — before it has reached Vault — in the same
      // `authHeaders()` shape, and `x-api-key` survives a cross-origin redirect
      // where a bearer token would be stripped. The destination here is the
      // provider's own host rather than anything a tenant picked, so the risk
      // is smaller; the header is identical, so the guard is the same.
      redirect: "manual",
    });
    if (response.status === 401) {
      return { ok: false, error: "invalid_key", message: "That key didn't work." };
    }
    if (response.ok) {
      const discovered = modelIds(await response.json(), clean.key);
      models = discovered.ids;
      modelsTotal = discovered.total;
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
  return { ok: true, provider, mode, models, modelsTotal, handoff };
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

/**
 * Redeem a probed key by id. takeKeyImport is an atomic GETDEL, so a replayed
 * id after this point finds nothing — the handoff is single-use, not merely
 * expiring, and two racing redemptions cannot both succeed. That last clause
 * was untrue until 2026-08-27; see tests/key-import-atomic.test.ts.
 */
async function redeemKeyImport(
  { user }: RequiredUser,
  input: { handoff?: unknown; provider?: unknown }
): Promise<KeyImportHandoff> {
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
    throw new ActionError("This key import has expired. Start again.");
  }
  return handoff;
}

/**
 * Refuse a key import that 0076 would refuse at the agent step, BEFORE the
 * provider key is stored and before the handoff is spent: at the cap, the old
 * order stored a real provider secret that no agent used. Gated first, like
 * every helper here, so an unverified session learns nothing about the account.
 * See lib/agent-capacity.ts: the trigger remains the enforcement.
 */
async function requireAgentCapacity(auth: RequiredUser, options: { withKey: boolean }): Promise<void> {
  await requireCredentialMfa(auth.db, auth.user);
  const refusal = await agentCreationRefusal(
    serviceClient() as unknown as AgentCapacityDb,
    auth.user.id,
    options
  );
  if (refusal) throw new ActionError(accountLimitMessage(refusal));
}

/**
 * Create the agent half of a key import; if it fails, delete the credential
 * the import just stored, then rethrow the original error.
 *
 * Reached only past requireAgentCapacity, so this is a race or an unexpected
 * refusal. The delete goes through the one sanctioned RPC, which refuses an
 * ACTIVE credential (0027/0030: never silently reassign billing). The first key
 * for a provider is its active one, so that case keeps the key: the user's
 * own, usable, and listed in Settings. It is reported, never hidden.
 */
async function withImportedCredential<T>(
  auth: RequiredUser,
  credentialId: string | null,
  provider: string,
  create: () => Promise<T>
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (credentialId) {
      const { error: deleteError } = await serviceClient().rpc("delete_provider_key_for_user", {
        p_user_id: auth.user.id,
        p_credential_id: credentialId,
      });
      if (deleteError) {
        // A fixed message and code: the RPC's text is not a safe log input.
        await captureError(new Error("key import left its provider key stored after the agent was refused"), {
          route: "dashboard:keyImport",
          code: "key_import_rollback_failed",
          provider,
        }).catch(() => {});
      } else {
        await purgeProviderKeyForTenant(auth, provider);
        await purgeProviderKeysCache(auth.user.id).catch(() => {});
        await recordAdminAction({
          userId: auth.user.id,
          action: "provider_key.delete",
          targetType: "provider_key",
          targetId: credentialId,
          metadata: { provider, reason: "key_import_rolled_back" },
        });
      }
    }
    throw error;
  }
}

/** Complete a probed import through the existing Vault and fleet actions. */
async function completeKeyImportBody(input: {
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
  await requireAgentCapacity(auth, { withKey: false });
  const handoff = await redeemKeyImport(auth, input);

  const keyInput = formCheck(() => validateProviderKeyInput({
    provider: input.provider,
    label: input.label,
    key: handoff.key,
  }));
  const agentInput = formCheck(() => validateAgentInput({
    name: input.name,
    passportPubkey: input.passportPubkey,
    scopes: [{ provider: input.provider, models: input.models }],
    budget_tokens: null,
    budget_cents: null,
  }));
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
  const credentialId = await addProviderKeyForUser(auth, keyInput, false);
  const created = await withImportedCredential(auth, credentialId, provider, () =>
    createAgentForUser(auth, agentInput)
  );
  return { agentId: created.id, createdAt: created.createdAt, provider, scope };
}

/**
 * The same probed import, finishing with a Direct Agent Key instead of a
 * Passport — the default on-ramp for a worker whose SDK takes a static key.
 * Passport issuance stays available through completeKeyImport.
 *
 * Revalidation is deferred for the same reason as completeKeyImport: the
 * worker's key exists only in this return value until the operator
 * acknowledges storing it.
 */
async function completeKeyImportDirectBody(input: {
  handoff: string;
  provider: string;
  label: string;
  name: string;
  keyName: string;
  models: string[];
}): Promise<IssuedDirectAgent & { provider: ProviderId }> {
  const auth = await requireUser();
  await requireAgentCapacity(auth, { withKey: true });
  // `input.provider` is safe to use before the redeem: redeemKeyImport refuses
  // a handoff whose provider differs from it.
  const agentInput = {
    name: input.name,
    keyName: input.keyName,
    scopes: [{ provider: input.provider, models: Array.isArray(input.models) ? input.models : [] }],
    budget_tokens: null,
    budget_cents: null,
  };
  // fleet.createDirectAgent checks these again. Checking first means a bad
  // name is refused before the provider key is stored or the handoff spent.
  formCheck(() => {
    validateAgentProfileInput(agentInput);
    validateDirectKeyMetadata({ name: agentInput.keyName });
  });
  const handoff = await redeemKeyImport(auth, input);
  const keyInput = formCheck(() => validateProviderKeyInput({
    provider: input.provider,
    label: input.label,
    key: handoff.key,
  }));
  const credentialId = await addProviderKeyForUser(auth, keyInput, false);
  const issued = await withImportedCredential(auth, credentialId, handoff.provider, () =>
    issueDirectAgentForUser(auth, agentInput)
  );
  return { ...issued, provider: handoff.provider };
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
async function rotateProviderKeyBody(input: { credentialId: string; key: string }) {
  const auth = await requireUser();
  const { db, user } = auth;
  // Replacing the secret behind a credential row is the same authority as storing
  // one: the new key is what the proxy will inject from here on.
  await requireCredentialMfa(db, user);
  const clean = formCheck(() => validateRotateInput(input));
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
async function setActiveProviderKeyBody(input: { credentialId: string }) {
  const auth = await requireUser();
  const { db, user } = auth;
  await requireCredentialMfa(db, user);
  const credentialId = String(input?.credentialId ?? "").trim();
  if (!UUID_RE.test(credentialId)) throw new ActionError("Invalid credential id.");
  const provider = await ownedCredentialProvider(auth, credentialId);
  // Refuse here rather than letting the RPC's own 'credential not found' answer
  // it: this keeps a cross-tenant id indistinguishable from a missing one at the
  // action boundary, before any write is attempted.
  if (!provider) throw new ActionError("That credential could not be found.");
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
 * Settings' "Use Ollama": store a `local` credential with no key and Ollama's
 * address, in one click.
 *
 * Ollama is asked for its models FIRST, and nothing is stored unless it
 * answers: a credential pointing at a server that is not running would make
 * every agent call fail with a gateway error that does not say why. The same
 * MFA gate and the same store path as adding any provider key
 * (`addProviderKeyForUser`), so the address is validated by the gate there too.
 * One already pointing at Ollama is reported rather than duplicated.
 */
async function connectOllamaBody(): Promise<{ models: string[]; alreadyConnected: boolean }> {
  const auth = await requireUser();
  const { db, user } = auth;
  await requireCredentialMfa(db, user);
  const policy = endpointPolicy();
  if (policy.kind === "off") throw localModelsDisabledError();

  const probe = await listLocalModels(OLLAMA_ENDPOINT, policy);
  if (probe.state === "disabled") {
    throw new ActionError(
      "This deployment's PROVIDER_ENDPOINT_MODE does not admit http://localhost:11434. Set it to selfhost to use Ollama."
    );
  }
  if (probe.state === "unreachable") {
    throw new ActionError(
      "Ollama is not answering at http://localhost:11434. Start the Ollama app (or run `ollama serve`) and try again."
    );
  }
  if (probe.state === "refused") {
    throw new ActionError(`Ollama answered with an error (HTTP ${probe.status}). Check that it is running normally.`);
  }

  const { data: existing, error } = await db
    .from("provider_credentials")
    .select("id, endpoint_base_url")
    .eq("user_id", user.id)
    .eq("provider", "local");
  if (error) failGeneric("connectOllama:list", error);
  const rows = (existing ?? []) as { endpoint_base_url?: unknown }[];
  if (rows.some((row) => row.endpoint_base_url === OLLAMA_ENDPOINT)) {
    return { models: probe.models, alreadyConnected: true };
  }

  await addProviderKeyForUser(auth, { provider: "local", label: "ollama", key: "", endpoint: OLLAMA_ENDPOINT }, true);
  revalidatePath("/dashboard/settings");
  return { models: probe.models, alreadyConnected: false };
}

/**
 * The models on this workspace's local server, for the agent wizard to offer.
 *
 * Read-only and keyless, so it is not MFA-gated: it reveals what the developer's
 * own server lists to the developer. The address is the SELECTED local
 * credential's, by the same rule the gateway uses (`is_active` first, then
 * oldest), so the wizard offers what an agent would actually reach.
 */
async function listLocalModelsForAgentsBody(): Promise<{
  state: "ok" | "none" | "disabled" | "unreachable" | "refused";
  models: string[];
}> {
  const { db, user } = await requireUser();
  const policy = endpointPolicy();
  if (policy.kind === "off") return { state: "disabled", models: [] };
  const { data } = await db
    .from("provider_credentials")
    .select("endpoint_base_url")
    .eq("user_id", user.id)
    .eq("provider", "local")
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const endpoint = (data as { endpoint_base_url?: unknown } | null)?.endpoint_base_url;
  if (typeof endpoint !== "string" || !endpoint) return { state: "none", models: [] };
  const probe = await listLocalModels(endpoint, policy);
  return probe.state === "ok" ? probe : { state: probe.state, models: [] };
}

/**
 * Point a credential at an endpoint other than the provider's own host.
 *
 * Refused outright unless the operator has set `PROVIDER_ENDPOINT_MODE` — the
 * gate is the control, and it is off by default, so on a hosted deployment this
 * action cannot store anything at all until somebody decides otherwise.
 *
 * MFA-gated like every other credential mutation, and this one earns it: choosing
 * WHERE a provider key is sent is at least as consequential as choosing which key
 * it is. The endpoint is normalised through the same validator the proxy uses on
 * read, so a value that stores is a value that will still be honoured.
 */
async function setProviderEndpointBody(input: {
  credentialId: string;
  endpoint: string;
}) {
  const auth = await requireUser();
  const { db, user } = auth;
  await requireCredentialMfa(db, user);
  const credentialId = String(input?.credentialId ?? "").trim();
  if (!UUID_RE.test(credentialId)) throw new ActionError("Invalid credential id.");
  const provider = await ownedCredentialProvider(auth, credentialId);
  if (!provider) throw new ActionError("That credential could not be found.");

  const raw = String(input?.endpoint ?? "").trim();
  const policy = endpointPolicy();
  if (isProvider(provider) && providerRequiresEndpoint(provider)) {
    // Azure's address is part of the credential: it has no provider host to
    // return to, so it cannot be cleared, and the operator gate below does not
    // apply to it (its own Microsoft-suffix rule does, in every mode).
    const required = normalizeEndpointFor(provider, raw, policy);
    if (!required) throw endpointRequiredError(provider, raw);
    await writeProviderEndpoint(auth, credentialId, provider, required);
    return;
  }
  if (raw && policy.kind === "off") {
    throw new ActionError(
      "Custom endpoints are not enabled on this deployment. Set PROVIDER_ENDPOINT_MODE to turn them on."
    );
  }
  // Empty clears it and returns to the provider's own host — always allowed,
  // whatever the gate says, so a narrowed policy never traps an operator with a
  // stored endpoint they can no longer remove.
  const endpoint = raw ? normalizeEndpointFor(provider, raw, policy) : null;
  if (raw && !endpoint) {
    throw new ActionError(
      policy.kind === "allowlist"
        ? "That endpoint is not one this deployment allows. It must be HTTPS on the default port, at a host the operator has listed."
        : "That is not an endpoint we can use. Give a base URL with no query string, no fragment and no credentials in it."
    );
  }

  await writeProviderEndpoint(auth, credentialId, provider, endpoint);
}

async function writeProviderEndpoint(
  auth: RequiredUser,
  credentialId: string,
  provider: string,
  endpoint: string | null
): Promise<void> {
  const { user } = auth;
  const { error } = await serviceClient()
    .from("provider_credentials")
    .update({ endpoint_base_url: endpoint })
    .eq("user_id", user.id) // tenant boundary — service_role bypasses RLS
    .eq("id", credentialId);
  if (error) failGeneric("setProviderEndpoint", error);

  await purgeProviderKeyForTenant(auth, provider);
  await recordAdminAction({
    userId: user.id,
    action: "provider_key.endpoint",
    targetType: "provider_key",
    targetId: credentialId,
    // The endpoint is an address the operator chose to route their own traffic
    // to, not a secret — and recording it is the point: this is the audit row
    // that answers "when did this key start going somewhere else".
    metadata: { provider, endpoint },
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
async function deleteProviderKeyBody(input: { credentialId: string }) {
  const auth = await requireUser();
  const { db, user } = auth;
  await requireCredentialMfa(db, user);
  const credentialId = String(input?.credentialId ?? "").trim();
  if (!UUID_RE.test(credentialId)) throw new ActionError("Invalid credential id.");
  const provider = await ownedCredentialProvider(auth, credentialId);
  if (!provider) throw new ActionError("That credential could not be found.");
  const { error } = await serviceClient().rpc("delete_provider_key_for_user", {
    p_user_id: user.id,
    p_credential_id: credentialId,
  });
  if (error) {
    if (String(error.message ?? "").includes("active_credential")) {
      throw new ActionError(
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
  if (error) {
    const limit = accountLimitFrom(error);
    if (limit) throw new ActionError(accountLimitMessage(limit));
    failGeneric("mintApiKeyForUser", error);
  }

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
  if (name.length < 1 || name.length > 80) throw new ActionError("Name must be 1–80 characters.");
  return name;
}

/** Mint a developer API key for the public control-plane API. The full token is
 *  returned ONCE here and never stored (only its hash + display prefix are). */
async function createApiKeyBody(input: { name: string; scope: "read" | "write" }): Promise<{
  token: string;
  prefix: string;
}> {
  const { db, user } = await requireUser();
  const name = validateApiKeyName(input?.name);
  if (input?.scope !== "read" && input?.scope !== "write") throw new ActionError("Scope must be read or write.");
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
  if (!limit.success) throw new ActionError("Too many attempts. Wait a minute and try again.");

  // Reject a malformed code before it costs a round trip. normalizeUserCode does
  // NOT map homoglyphs — the alphabet excludes them, so a `0` is a wrong code and
  // repairing it would silently widen the guess space.
  const code = normalizeUserCode(rawCode);
  if (!code) return null;

  const pending = await resolveUserCode(code, { count });
  return pending ? { code, pending } : null;
}

/** What the approval screen shows before the operator commits. Never a secret. */
async function inspectCliDeviceBody(rawCode: string): Promise<{
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
async function approveCliDeviceBody(rawCode: string): Promise<{ clientName: string }> {
  const { db, user } = await requireUser();
  await requireCredentialMfa(db, user);

  // Does not consume an attempt: inspectCliDevice already charged for resolving
  // this code, and charging twice per approval quartered the operator's budget.
  const found = await lookupCliDevice(user.id, rawCode, { count: false });
  if (!found) throw new ActionError("That code is not valid, or it has expired. Run `passcontrol login` again.");

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
async function denyCliDeviceBody(rawCode: string): Promise<void> {
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
async function revokeApiKeyBody(id: string): Promise<void> {
  const { db, user } = await requireUser();
  if (!UUID_RE.test(String(id))) throw new ActionError("Invalid key id.");
  const { data, error } = await db
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .select("id, key_prefix")
    .maybeSingle();
  if (error) failGeneric("revokeApiKey", error);
  if (!data) throw new ActionError("Key not found or already revoked.");

  await recordAdminAction({
    userId: user.id,
    action: "apikey.revoke",
    targetType: "api_key",
    targetId: id,
    metadata: { prefix: data.key_prefix },
  });
  revalidatePath("/");
}

// ── The exported actions ─────────────────────────────────────────────────────
//
// Each one runs its body through runAction and RETURNS the outcome. A thrown
// message does not survive a production build (Next replaces it with "An error
// occurred in the Server Components render…"); a returned one does. Components
// import these through app/dashboard/actions-client.ts, which re-throws on the
// client so their existing error handling is unchanged. Only ActionError text
// reaches the browser; anything else becomes the generic message.

export async function setMasterKill(
  ...args: Parameters<typeof setMasterKillBody>
): Promise<ActionResult<Awaited<ReturnType<typeof setMasterKillBody>>>> {
  return runAction("setMasterKill", () => setMasterKillBody(...args));
}

export async function observeMasterKill(
  ...args: Parameters<typeof observeMasterKillBody>
): Promise<ActionResult<Awaited<ReturnType<typeof observeMasterKillBody>>>> {
  return runAction("observeMasterKill", () => observeMasterKillBody(...args));
}

export async function setAgentSuspended(
  ...args: Parameters<typeof setAgentSuspendedBody>
): Promise<ActionResult<Awaited<ReturnType<typeof setAgentSuspendedBody>>>> {
  return runAction("setAgentSuspended", () => setAgentSuspendedBody(...args));
}

export async function observeAgentControl(
  ...args: Parameters<typeof observeAgentControlBody>
): Promise<ActionResult<Awaited<ReturnType<typeof observeAgentControlBody>>>> {
  return runAction("observeAgentControl", () => observeAgentControlBody(...args));
}

export async function createAgent(
  ...args: Parameters<typeof createAgentBody>
): Promise<ActionResult<Awaited<ReturnType<typeof createAgentBody>>>> {
  return runAction("createAgent", () => createAgentBody(...args));
}

export async function issueDirectAgent(
  ...args: Parameters<typeof issueDirectAgentBody>
): Promise<ActionResult<Awaited<ReturnType<typeof issueDirectAgentBody>>>> {
  return runAction("issueDirectAgent", () => issueDirectAgentBody(...args));
}

export async function issueDirectAgentKey(
  ...args: Parameters<typeof issueDirectAgentKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof issueDirectAgentKeyBody>>>> {
  return runAction("issueDirectAgentKey", () => issueDirectAgentKeyBody(...args));
}

export async function revokeDirectAgentKey(
  ...args: Parameters<typeof revokeDirectAgentKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof revokeDirectAgentKeyBody>>>> {
  return runAction("revokeDirectAgentKey", () => revokeDirectAgentKeyBody(...args));
}

export async function attachAgentPassport(
  ...args: Parameters<typeof attachAgentPassportBody>
): Promise<ActionResult<Awaited<ReturnType<typeof attachAgentPassportBody>>>> {
  return runAction("attachAgentPassport", () => attachAgentPassportBody(...args));
}

export async function updateAgentBudgets(
  ...args: Parameters<typeof updateAgentBudgetsBody>
): Promise<ActionResult<Awaited<ReturnType<typeof updateAgentBudgetsBody>>>> {
  return runAction("updateAgentBudgets", () => updateAgentBudgetsBody(...args));
}

export async function updateAgentScopes(
  ...args: Parameters<typeof updateAgentScopesBody>
): Promise<ActionResult<Awaited<ReturnType<typeof updateAgentScopesBody>>>> {
  return runAction("updateAgentScopes", () => updateAgentScopesBody(...args));
}

export async function updateAgentFallbacks(
  ...args: Parameters<typeof updateAgentFallbacksBody>
): Promise<ActionResult<Awaited<ReturnType<typeof updateAgentFallbacksBody>>>> {
  return runAction("updateAgentFallbacks", () => updateAgentFallbacksBody(...args));
}

export async function addProviderKey(
  ...args: Parameters<typeof addProviderKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof addProviderKeyBody>>>> {
  return runAction("addProviderKey", () => addProviderKeyBody(...args));
}

export async function probeProviderKey(
  ...args: Parameters<typeof probeProviderKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof probeProviderKeyBody>>>> {
  return runAction("probeProviderKey", () => probeProviderKeyBody(...args));
}

export async function completeKeyImport(
  ...args: Parameters<typeof completeKeyImportBody>
): Promise<ActionResult<Awaited<ReturnType<typeof completeKeyImportBody>>>> {
  return runAction("completeKeyImport", () => completeKeyImportBody(...args));
}

export async function completeKeyImportDirect(
  ...args: Parameters<typeof completeKeyImportDirectBody>
): Promise<ActionResult<Awaited<ReturnType<typeof completeKeyImportDirectBody>>>> {
  return runAction("completeKeyImportDirect", () => completeKeyImportDirectBody(...args));
}

export async function rotateProviderKey(
  ...args: Parameters<typeof rotateProviderKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof rotateProviderKeyBody>>>> {
  return runAction("rotateProviderKey", () => rotateProviderKeyBody(...args));
}

export async function setActiveProviderKey(
  ...args: Parameters<typeof setActiveProviderKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof setActiveProviderKeyBody>>>> {
  return runAction("setActiveProviderKey", () => setActiveProviderKeyBody(...args));
}

export async function connectOllama(
  ...args: Parameters<typeof connectOllamaBody>
): Promise<ActionResult<Awaited<ReturnType<typeof connectOllamaBody>>>> {
  return runAction("connectOllama", () => connectOllamaBody(...args));
}

export async function listLocalModelsForAgents(
  ...args: Parameters<typeof listLocalModelsForAgentsBody>
): Promise<ActionResult<Awaited<ReturnType<typeof listLocalModelsForAgentsBody>>>> {
  return runAction("listLocalModelsForAgents", () => listLocalModelsForAgentsBody(...args));
}

export async function setProviderEndpoint(
  ...args: Parameters<typeof setProviderEndpointBody>
): Promise<ActionResult<Awaited<ReturnType<typeof setProviderEndpointBody>>>> {
  return runAction("setProviderEndpoint", () => setProviderEndpointBody(...args));
}

export async function deleteProviderKey(
  ...args: Parameters<typeof deleteProviderKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof deleteProviderKeyBody>>>> {
  return runAction("deleteProviderKey", () => deleteProviderKeyBody(...args));
}

export async function createApiKey(
  ...args: Parameters<typeof createApiKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof createApiKeyBody>>>> {
  return runAction("createApiKey", () => createApiKeyBody(...args));
}

export async function inspectCliDevice(
  ...args: Parameters<typeof inspectCliDeviceBody>
): Promise<ActionResult<Awaited<ReturnType<typeof inspectCliDeviceBody>>>> {
  return runAction("inspectCliDevice", () => inspectCliDeviceBody(...args));
}

export async function approveCliDevice(
  ...args: Parameters<typeof approveCliDeviceBody>
): Promise<ActionResult<Awaited<ReturnType<typeof approveCliDeviceBody>>>> {
  return runAction("approveCliDevice", () => approveCliDeviceBody(...args));
}

export async function denyCliDevice(
  ...args: Parameters<typeof denyCliDeviceBody>
): Promise<ActionResult<Awaited<ReturnType<typeof denyCliDeviceBody>>>> {
  return runAction("denyCliDevice", () => denyCliDeviceBody(...args));
}

export async function revokeApiKey(
  ...args: Parameters<typeof revokeApiKeyBody>
): Promise<ActionResult<Awaited<ReturnType<typeof revokeApiKeyBody>>>> {
  return runAction("revokeApiKey", () => revokeApiKeyBody(...args));
}
