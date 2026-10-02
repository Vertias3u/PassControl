"use server";
// Any-API phase 1: the dashboard's two service mutations.
//
//   addServiceToken      — store a workspace's GitHub token in Vault
//   setAgentServiceRules — set which GitHub calls one agent may make
//
// Behind MFA step-up like every credential mutation (app/dashboard/actions.ts,
// requireCredentialMfa): a server action is addressable over HTTP by its id, so
// the page's redirect protects the page and not this. Both change what an agent
// can reach with the tenant's token.
//
// The service-role client is used because `authenticated` has no UPDATE grant
// on `agents.service_rules` (0074) — deliberately, like `policy`: the only
// writer is this validating action. The tenant boundary is therefore in code:
// the user id comes from the MFA gate and every write filters on it.
//
// A token is stored through `store_provider_key_for_user` under the namespaced
// provider (`svc:github`), so it lives in Vault and is decrypted only by
// `get_provider_key`, the one decrypt path (invariant 5). Replacing and deleting
// a token reuse rotateProviderKey / deleteProviderKey, which work by credential
// id and do not care what the credential is for.
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import { LIMITS } from "@/lib/validate";
import { SERVICE_CATALOG, isServiceId, serviceRefusal } from "@/lib/services/catalog";
import { parseServiceRules } from "@/lib/services/rules";
import { armServiceKill, observeServiceKill } from "@/lib/state/killswitch";
import { logSecurityEvent } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServiceActionState {
  ok?: boolean;
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
          ? "Complete two-factor verification before changing credentials or access."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change credentials or access."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  return { userId: gate.user.id };
}

// A database or RPC error can reflect submitted values — including a token — so
// only a bounded machine code is ever logged, and the operator sees nothing of it.
function failed(context: string, error: { code?: unknown } | null | undefined): ServiceActionState {
  const code = String(error?.code ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
  console.error(`[dashboard:${context}]`, code);
  return { error: "Something went wrong. Please try again." };
}

export async function addServiceToken(input: {
  service: string;
  label: string;
  token: string;
}): Promise<ServiceActionState> {
  if (!isServiceId(input?.service)) return { error: "Unknown service." };
  const entry = SERVICE_CATALOG[input.service];
  const label = String(input?.label ?? "").trim();
  if (label.length > LIMITS.label) return { error: "That nickname is too long." };
  const token = String(input?.token ?? "").trim();
  if (token.length < 1 || token.length > LIMITS.providerKey) {
    return { error: `Paste the ${entry.label} token.` };
  }
  // Where the token is put into a URL (Telegram), its shape is the boundary
  // between "a token" and "an address". The gateway checks it again before
  // every use; this says so now. Never echo what was pasted.
  if (entry.tokenShape && !entry.tokenShape.test(token)) {
    return { error: `That is not a ${entry.label} token. ${entry.tokenShapeHint ?? ""}`.trim() };
  }

  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const { error } = await serviceClient().rpc("store_provider_key_for_user", {
    p_user_id: acting.userId,
    p_provider: entry.credentialProvider,
    p_label: label,
    p_plaintext: token,
  });
  if (error) return failed("addServiceToken", error);

  await recordAdminAction({
    userId: acting.userId,
    action: "provider_key.add",
    targetType: "provider_key",
    metadata: { provider: entry.credentialProvider, label },
  });
  revalidatePath("/dashboard/settings");
  return {
    ok: true,
    notice: `Stored in Vault. Agents reach ${entry.label} with it only through rules you set on each agent.`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function setAgentServiceRules(
  agentId: string,
  service: string,
  input: { allow: { method: string; path: string }[]; maxRequestsPerHour: number | null }
): Promise<ServiceActionState> {
  if (!UUID_RE.test(agentId ?? "")) return { error: "That agent could not be found." };
  if (!isServiceId(service)) return { error: "Unknown service." };
  const entry = SERVICE_CATALOG[service];

  // Exactly the stored shape, checked with the gateway's own parser. Anything
  // it would call malformed is refused here, with the reason, instead of being
  // written and then denying every call to the service.
  // Stored in the service's own shape: `{ method, path }` for GitHub, and
  // `{ call }` for a service whose rules name a method (Telegram).
  const allow = (Array.isArray(input?.allow) ? input.allow : []).map((rule) =>
    entry.ruleShape === "call"
      ? { call: String(rule?.path ?? "").trim() }
      : { method: String(rule?.method ?? ""), path: String(rule?.path ?? "").trim() }
  );
  const next: Record<string, unknown> = { allow };
  if (input?.maxRequestsPerHour !== null && input?.maxRequestsPerHour !== undefined) {
    next.max_requests_per_hour = input.maxRequestsPerHour;
  }
  const parsed = parseServiceRules({ [service]: next }, service);
  if (parsed.kind !== "rules") {
    if (entry.ruleShape === "call") {
      return {
        error: `Each ${entry.label} rule is one Bot API method name, such as sendMessage: letters, digits and _, no wildcards. The hourly cap is a whole number of at least 1.`,
      };
    }
    if (parsed.kind === "malformed" && parsed.reason === "write_wildcard") {
      return {
        error:
          "A write rule (POST, PUT, PATCH or DELETE) must name its path exactly: ** is for read rules only. Use * for a single path segment.",
      };
    }
    return {
      error:
        "Those rules are not valid. Each rule is GET, POST, PUT, PATCH or DELETE and a path starting with /, using * for one segment and ** only at the end of a GET rule; the hourly cap is a whole number of at least 1.",
    };
  }
  // A write rule that can only ever reach the catalog's never list would save
  // and then refuse every call it admits. Say so now, with the reason. Checked
  // on the rule's own segments, so `*` stays a wildcard here: only a rule whose
  // every possible match is refused is caught; the gateway checks the rest.
  for (const rule of parsed.rules.allow) {
    const refusal =
      rule.method === "GET" ? null : serviceRefusal(entry, rule.method === "CALL" ? "POST" : rule.method, rule.segments);
    if (refusal) {
      const named = rule.method === "CALL" ? rule.path : `${rule.method} ${rule.path}`;
      return { error: `${named} is never allowed: ${refusal}` };
    }
  }

  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const db = serviceClient();
  const { data, error: readError } = await db
    .from("agents")
    .select("service_rules")
    .eq("id", agentId)
    .eq("user_id", acting.userId)
    .maybeSingle();
  // Not "no rules": saving over a document we could not read would drop the
  // agent's rules for every other service.
  if (readError) return failed("setAgentServiceRules:read", readError);
  if (!data) return { error: "That agent could not be found." };
  const current = (data as { service_rules?: unknown }).service_rules;

  const document = { ...(isPlainObject(current) ? current : {}), [service]: next };
  const { data: updated, error } = await db
    .from("agents")
    .update({ service_rules: document })
    .eq("id", agentId)
    .eq("user_id", acting.userId)
    .select("id");
  if (error) return failed("setAgentServiceRules", error);
  if (!Array.isArray(updated) || updated.length !== 1) return { error: "That agent could not be found." };

  await recordAdminAction({
    userId: acting.userId,
    action: "agent.service_rules",
    targetType: "agent",
    targetId: agentId,
    // Counts, not paths: admin_audit is tenant-readable and served by the
    // control API, and the rule paths name repositories.
    metadata: {
      service,
      rules: parsed.rules.allow.length,
      max_requests_per_hour: (next.max_requests_per_hour as number | undefined) ?? null,
    },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  return {
    ok: true,
    notice:
      parsed.rules.allow.length === 0
        ? `This agent now has no ${entry.label} access.`
        : `Saved. The next ${entry.label} call is checked against these rules.`,
  };
}

/**
 * What arming/disarming one service's stop asked for and then OBSERVED, as the
 * fleet kill switch reports (`KillObservation`). `armed: null` = the read-back
 * failed, which is "could not confirm", never "armed" or "clear".
 */
export type ServiceKillObservation =
  | { requested: boolean; armed: boolean | null; confirmed: boolean }
  | { error: string };

// A stop must always be reachable, so this asks only that the operator is
// signed in: no two-factor step-up, exactly as the fleet kill switch. The
// user id comes from the verified session (getUser), never from the client.
async function signedInUser(): Promise<string | null> {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  return user?.id ?? null;
}

/** Stop (or resume) every call this workspace's agents make to one service. */
export async function setServiceKill(service: string, on: boolean): Promise<ServiceKillObservation> {
  if (!isServiceId(service)) return { error: "Unknown service." };
  const userId = await signedInUser();
  if (!userId) return { error: "Sign in again to change this." };
  const requested = on === true;
  let applied = false;
  try {
    await armServiceKill(userId, service, requested);
    applied = true;
  } catch {
    // Reported through the read-back: "could not confirm", not an exception.
  }
  if (applied) {
    logSecurityEvent("killswitch.service", { user: userId, service, on: requested });
    await dispatchSecurityAlert("killswitch.service", { user: userId, service, on: requested });
    await recordAdminAction({ userId, action: "killswitch.service", metadata: { service, on: requested } });
  }
  const armed = await observeServiceKill(userId, service);
  revalidatePath("/dashboard/services");
  return { requested, armed, confirmed: armed === requested };
}

/** Read-only re-check of one service's stop, behind "Refresh status". */
export async function observeServiceKillAction(service: string, requested: boolean): Promise<ServiceKillObservation> {
  if (!isServiceId(service)) return { error: "Unknown service." };
  const userId = await signedInUser();
  if (!userId) return { error: "Sign in again to check this." };
  const armed = await observeServiceKill(userId, service);
  return { requested: requested === true, armed, confirmed: armed === (requested === true) };
}
