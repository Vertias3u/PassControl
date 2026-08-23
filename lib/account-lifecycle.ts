import type { Redis } from "@upstash/redis";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { PROVIDERS } from "@/lib/providers";
import { scanKeys } from "@/lib/reconcile";

// 3: the operator profile (0033). Bumped rather than added silently, because a
// consumer that parsed version 2 has no idea `profile` exists and the whole
// point of the number is that it can tell.
export const ACCOUNT_EXPORT_SCHEMA_VERSION = 3;
const PAGE_SIZE = 1_000;

export const ACCOUNT_EXPORT_TABLES = [
  {
    key: "agents",
    table: "agents",
    columns: "id,user_id,name,passport_pubkey,status,budget_tokens,budget_cents,spent_tokens,spent_microcents,allowed_scopes,created_at,last_seen_at,policy,fallbacks,policy_shadow,expires_at,previous_passport_pubkey,previous_valid_until,published,public_label",
  },
  {
    key: "agentLogs",
    table: "agent_logs",
    columns: "id,agent_id,user_id,passport_id,jti,provider,model,input_tokens,output_tokens,cost_microcents,status,latency_ms,created_at,receipt,policy_shadow_would,auth_method,agent_access_key_id,credential_use_id",
  },
  {
    key: "providerCredentials",
    table: "provider_credentials",
    columns: "id,user_id,provider,label,created_at",
  },
  {
    key: "controlApiKeys",
    table: "api_keys",
    columns: "id,user_id,name,key_prefix,scope,last_used_at,revoked_at,created_at",
  },
  {
    key: "adminAudit",
    table: "admin_audit",
    columns: "id,user_id,action,target_type,target_id,metadata,created_at",
  },
  {
    key: "ownerBinding",
    table: "agent_owners",
    columns: "user_id,kind,subject,tier,published,verified_at,last_checked_at,failure_count,created_at",
  },
  {
    key: "breakGlassGrants",
    table: "break_glass_grants",
    columns: "id,user_id,agent_id,scopes,reason,expires_at,created_at,revoked_at",
  },
  {
    key: "directAgentKeys",
    table: "agent_access_keys",
    columns: "id,user_id,agent_id,name,key_suffix,expires_at,revoked_at,created_at",
  },
] as const;

type ExportRows = Record<(typeof ACCOUNT_EXPORT_TABLES)[number]["key"], unknown[]>;

async function readAllRows(
  db: SupabaseClient,
  user: User,
  spec: (typeof ACCOUNT_EXPORT_TABLES)[number]
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    // Supabase's generated overload expands every table × selected column
    // combination in this data-driven allowlist into a union too large for TS.
    // Runtime names and columns remain the explicit constants above.
    // @ts-expect-error generated query union is too complex to represent
    const { data, error } = await db
      .from(spec.table)
      .select(spec.columns)
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);
    if (error) throw new Error(`account_export_${spec.key}_unavailable`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function loadBetaExport(admin: SupabaseClient | undefined, userId: string) {
  if (!admin) return { application: null, invitations: [], feedback: null };
  const { data: application, error: applicationError } = await admin
    .from("beta_applications")
    .select("id,email_normalized,integration,provider,monthly_call_bucket,use_case,status,contact_consent_at,created_at,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (applicationError) {
    if (["42P01", "PGRST205"].includes(applicationError.code ?? "")) {
      return { application: null, invitations: [], feedback: null };
    }
    throw new Error("account_export_beta_unavailable");
  }
  if (!application) return { application: null, invitations: [], feedback: null };
  const [{ data: invitations, error: inviteError }, { data: feedback, error: feedbackError }] =
    await Promise.all([
      admin.from("beta_invites").select("id,application_id,expires_at,sent_at,claimed_at,redeemed_at,revoked_at,created_at").eq("application_id", application.id).order("created_at", { ascending: true }),
      admin.from("beta_feedback").select("id,application_id,setup_rating,feedback,contact_permitted,created_at,updated_at").eq("user_id", userId).maybeSingle(),
    ]);
  if (inviteError || feedbackError) throw new Error("account_export_beta_unavailable");
  return { application, invitations: invitations ?? [], feedback: feedback ?? null };
}

export async function loadAccountExport(db: SupabaseClient, user: User, admin: SupabaseClient) {
  // The recovery-code count is the one figure here that no browser role may read
  // for itself: 0031 revoked SELECT on `mfa_recovery_codes` from `authenticated`
  // because the grant handed out `code_hash` — the offline verifier — to anyone
  // who asked PostgREST for that column instead of the count. So it comes from
  // the service role, scoped by the verified `user.id` rather than by RLS. The
  // export ships the COUNT and never the hashes; see the `exclusions` list below.
  // `admin` is REQUIRED for that reason — it used to be optional, and a defaulted
  // `admin ?? db` here would fall back to the user client and 503 the whole export
  // with `account_export_profile_unavailable`, which says nothing about the cause.
  const [{ data: profile, error: profileError }, { count: recoveryCodeCount, error: mfaError }] =
    await Promise.all([
      db
        .from("users")
        .select(
          "id,email,plan,created_at,username,display_name,bio,website_url,company,timezone,profile_public,avatar_path,updated_at"
        )
        .eq("id", user.id)
        .maybeSingle(),
      admin.from("mfa_recovery_codes").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    ]);
  if (profileError || mfaError) throw new Error("account_export_profile_unavailable");

  const [entries, beta] = await Promise.all([
    Promise.all(ACCOUNT_EXPORT_TABLES.map(async (spec) => [spec.key, await readAllRows(db, user, spec)] as const)),
    loadBetaExport(admin, user.id),
  ]);
  const data = Object.fromEntries(entries) as ExportRows;
  return {
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    account: {
      id: user.id,
      email: user.email ?? profile?.email ?? null,
      plan: profile?.plan ?? null,
      createdAt: profile?.created_at ?? user.created_at ?? null,
      mfaRecoveryCodeCount: recoveryCodeCount ?? 0,
    },
    // Everything the operator typed about themselves, including which of it was
    // public. `avatar_key` is deliberately absent: it is a live capability
    // token for /avatars/<key>, so putting it in a file people email around
    // would hand out a working URL. Whether an avatar EXISTS is the useful
    // fact, and that is what `avatar` reports.
    profile: {
      handle: profile?.username ?? null,
      displayName: profile?.display_name ?? null,
      bio: profile?.bio ?? null,
      websiteUrl: profile?.website_url ?? null,
      company: profile?.company ?? null,
      timezone: profile?.timezone ?? null,
      isPublic: profile?.profile_public === true,
      avatar: profile?.avatar_path ? "stored" : null,
      updatedAt: profile?.updated_at ?? null,
    },
    data: { ...data, beta },
    exclusions: [
      "Provider credential plaintext and Vault references",
      "Direct Agent Key and control API key hashes",
      "MFA recovery-code hashes and owner-verification tokens",
      "Raw and hashed beta invitation tokens",
      "Ephemeral Redis counters, nonces and caches",
      "Avatar image bytes and the avatar capability token",
    ],
  };
}

export async function purgeAccountRuntimeState(
  r: Redis,
  userId: string,
  agentIds: string[],
  controlApiKeyIds: string[]
): Promise<void> {
  const exact = new Set<string>([`owner:${userId}`, `provkeys:${userId}`]);
  const patterns = [`keyimport:${userId}:*`, `cloud-beta:*:workspace:${userId}`];

  for (const agentId of agentIds) {
    exact.add(`reserved:${agentId}`);
    exact.add(`spent:${agentId}`);
    exact.add(`reserved_cost:${agentId}`);
    exact.add(`spent_cost:${agentId}`);
    exact.add(`policy2:${userId}:${agentId}`);
    exact.add(`fallbacks:${userId}:${agentId}`);
    exact.add(`suspended:${agentId}`);
    exact.add(`lastseen:${agentId}`);
    exact.add(`ratelimit:proxy:${agentId}`);
    exact.add(`ratelimit:policy-hour:${userId}:${agentId}`);
    for (const provider of PROVIDERS) exact.add(`key:${agentId}:${provider}`);
    patterns.push(`reserve:${agentId}:*`, `reserve_cost:${agentId}:*`);
  }
  for (const keyId of controlApiKeyIds) {
    exact.add(`ratelimit:control:${keyId}`);
    patterns.push(`idem:${keyId}:*`);
  }

  for (const pattern of patterns) {
    for (const key of await scanKeys(r, pattern)) exact.add(key);
  }

  const pipe = r.pipeline();
  const keys = [...exact];
  if (keys.length) pipe.del(...keys);
  for (const agentId of agentIds) pipe.srem("killswitch:denylist", agentId);
  await pipe.exec();
}
