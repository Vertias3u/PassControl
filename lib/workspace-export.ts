import type { SupabaseClient } from "@supabase/supabase-js";
import { WORKSPACE_EXPORT_PROTOCOL } from "@/cli/protocols.mjs";
import { RELEASE_VERSION } from "@/lib/version";

// 1: the first shape. Bumped rather than extended silently, on the same
// reasoning as ACCOUNT_EXPORT_SCHEMA_VERSION in lib/account-lifecycle.ts — a
// consumer that parsed version 1 has no idea what version 2 added, and the
// whole point of the number is that it can tell.
export const WORKSPACE_EXPORT_SCHEMA_VERSION = WORKSPACE_EXPORT_PROTOCOL.maximum;

export const WORKSPACE_EXPORT_FORMAT = "passcontrol-export";

const PAGE_SIZE = 1_000;

// This is CONFIGURATION, not the account. The account export
// (lib/account-lifecycle.ts) answers "what do you hold about me" and carries
// traffic history; this answers "what would I have to rebuild", and the
// difference decides what is absent:
//
//   agent_logs             traffic, not configuration — and the bulk of the
//                          account export's size
//   spent_* / checkpoints  derived state; agent_spend_checkpoint is also RLS
//                          -unreadable by any browser role (0004:28, no policy)
//   api_keys /             credentials, not configuration. Only their hashes
//   agent_access_keys      exist at rest and a hash cannot be restored into a
//                          working key, so exporting the shells would invite an
//                          import that LOOKS like it restored access and did not
export const WORKSPACE_CONFIG_TABLES = [
  {
    key: "agents",
    table: "agents",
    // Every column here is safe: `agents` carries no secret at all. Both
    // pubkey columns are PUBLIC keys — printed on /verify and carried in every
    // receipt (0021:39-48) — and the Ed25519 private half is generated on the
    // operator's machine and never reaches the server.
    // `service_rules` (0074) is an agent's access to non-LLM APIs such as
    // GitHub: methods and paths, no secret. The token it uses is not here.
    columns:
      "id,name,status,budget_tokens,budget_cents,budget_period,budget_period_cents,allowed_scopes,policy,policy_shadow,fallbacks,expires_at,published,public_label,passport_pubkey,created_at,service_rules",
    // A database missing a migration refuses the whole select (42703), so each
    // fallback drops one migration's columns, newest first. Without 0074 an
    // agent HAS no service rules, and without 0073 no periodic limit, so the
    // export is still complete — unlike one that failed outright, which leaves
    // the operator nothing. One step at a time: a database with 0073 but not
    // 0074 must keep its periodic limits.
    fallbackColumns: [
      "id,name,status,budget_tokens,budget_cents,budget_period,budget_period_cents,allowed_scopes,policy,policy_shadow,fallbacks,expires_at,published,public_label,passport_pubkey,created_at",
      "id,name,status,budget_tokens,budget_cents,allowed_scopes,policy,policy_shadow,fallbacks,expires_at,published,public_label,passport_pubkey,created_at",
    ],
  },
  {
    key: "providerMappings",
    table: "provider_credentials",
    // `vault_secret_id` is absent and that absence IS the feature. It is a
    // handle into vault.secrets, which is encrypted with a per-project root key
    // Supabase never puts in a dump — so it would restore as a pointer to
    // nothing, while looking like a recovered credential.
    columns: "id,provider,label,is_active,created_at",
  },
  {
    key: "ownership",
    table: "agent_owners",
    // No `verification_token`: it is a live proof of control, not a record of
    // one. `tier` and `verified_at` say what was proven; the token would let the
    // holder re-prove it. The company line IS exported — it is the operator's
    // own assertion about themselves, and an export that quietly drops what a
    // tenant put in is not a copy of their data.
    columns:
      "user_id,kind,subject,tier,published,verified_at,created_at,company_id,company_source,company_name,company_jurisdiction,company_active,company_checked_at",
  },
  {
    key: "breakGlassGrants",
    table: "break_glass_grants",
    columns: "id,agent_id,scopes,reason,expires_at,revoked_at,created_at",
  },
] as const;

type WorkspaceSpec = (typeof WORKSPACE_CONFIG_TABLES)[number];

// A local reader rather than lib/account-lifecycle.ts's `readAllRows`. Same
// shape deliberately, two reasons not to share it: the error namespace differs
// (a failed workspace read must not report itself as an account export), and
// the tenant filter belongs in the file that claims it — a reader should be
// able to see the boundary here, not by following an import.
async function readWorkspaceRows(db: SupabaseClient, userId: string, spec: WorkspaceSpec): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    // No @ts-expect-error needed here, unlike lib/account-lifecycle.ts:67: that
    // allowlist spans eight tables and its generated table × column union
    // overflows what TS will represent. Four tables stay inside the limit. If a
    // fifth is ever added and the union blows up, copy the directive — do not
    // widen the column strings to make the error go away.
    const page_ = (columns: string) =>
      db
        .from(spec.table)
        .select(columns)
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .range(start, start + PAGE_SIZE - 1);
    let { data, error } = await page_(spec.columns);
    for (const fallback of "fallbackColumns" in spec ? spec.fallbackColumns : []) {
      if ((error as { code?: string } | null)?.code !== "42703") break;
      ({ data, error } = await page_(fallback));
    }
    if (error) throw new Error(`workspace_export_${spec.key}_unavailable`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export type WorkspaceExport = Awaited<ReturnType<typeof loadWorkspaceExport>>;

export async function loadWorkspaceExport(db: SupabaseClient, userId: string) {
  const [agents = [], providerMappings = [], ownership = [], breakGlassGrants = []] =
    await Promise.all(WORKSPACE_CONFIG_TABLES.map((spec) => readWorkspaceRows(db, userId, spec)));

  // Display preferences an operator would otherwise retype. `avatar_key` is not
  // selected and must never be: it is an unguessable but LIVE capability token
  // for /avatars/<key>, so a workspace file mailed to a colleague would carry a
  // working image URL with it. Whether an avatar exists is the restorable fact.
  const { data: settings, error: settingsError } = await db
    .from("users")
    .select("username,display_name,timezone")
    .eq("id", userId)
    .maybeSingle();
  if (settingsError) throw new Error("workspace_export_settings_unavailable");

  return {
    format: WORKSPACE_EXPORT_FORMAT,
    version: WORKSPACE_EXPORT_SCHEMA_VERSION,
    passcontrol_version: RELEASE_VERSION,
    created_at: new Date().toISOString(),
    workspace: {
      agents,
      providerMappings,
      ownership: ownership[0] ?? null,
      breakGlassGrants,
    },
    settings: {
      handle: settings?.username ?? null,
      displayName: settings?.display_name ?? null,
      timezone: settings?.timezone ?? null,
    },
    // Said in the file itself, not only in the docs, because this is the
    // artifact someone opens at the worst possible moment. The Vault line is a
    // stated guarantee rather than a silent gap, and this is where that
    // guarantee meets the person relying on it.
    exclusions: [
      "Provider API keys and service tokens (such as a GitHub token). They live in Supabase Vault, encrypted with a per-project root key that appears in no dump — re-enter them after a restore. An agent's GitHub rules are restored, but admit nothing until a GitHub token is stored again.",
      "Control API keys and Direct Agent Keys. Only their hashes are stored, so they cannot be restored; reissue them.",
      "MFA enrolment, recovery codes and active sessions.",
      "Passport private keys, which are generated on your machine and never sent to the server.",
      "Call history, spend counters and audit rows — this is configuration, not a record of what happened.",
      "Avatar image bytes and the avatar capability token.",
    ],
  };
}
