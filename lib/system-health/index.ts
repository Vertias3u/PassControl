import { loadInstanceSigner, instanceIssuer } from "@/lib/crypto/instanceKey";
import { normaliseVisaSecret } from "@/lib/auth/visa";
import { redis } from "@/lib/state/redis";
import { serviceClient } from "@/lib/supabase";
import { getBuildIdentity } from "./build-identity";
import { CLIENT_PROTOCOLS } from "@/cli/protocols.mjs";

export type SystemHealthState = "ready" | "attention" | "degraded" | "unknown" | "disabled";
export type SystemHealthOverall = "current" | "attention" | "degraded" | "incompatible";
export type MigrationHealthState = "current" | "behind" | "ahead" | "incompatible" | "unknown";
export type SystemHealthCheckId =
  | "database" | "migration_ledger" | "vault_wiring" | "redis" | "visa_signing"
  | "cache_encryption" | "receipt_signing" | "build_identity";

export interface SystemHealthSnapshot {
  format_version: 1;
  generated_at: string;
  overall: SystemHealthOverall;
  build: { version: string; commit: string | null; channel: "beta" | "stable" | "development" | "unknown" };
  migrations: { state: MigrationHealthState; expected_head: string; applied_head: string | null; missing_count: number; extra_count: number; action: string };
  protocols: { control_api: { minimum: 1; maximum: 1 }; gateway_api: { minimum: 1; maximum: 1 }; receipt: { minimum: 1; maximum: 2 }; agent_token: { minimum: 1; maximum: 1 }; workspace_export: { minimum: 1; maximum: 1 } };
  checks: Array<{ id: SystemHealthCheckId; category: "application" | "database" | "runtime" | "trust"; label: string; state: SystemHealthState; summary: string; action: string | null }>;
}

type LedgerRow = { version: string; checksum: string };
type InternalSnapshot = { ledger: LedgerRow[]; vault: { extension: boolean; secrets_relation: boolean; decrypt_rpc: boolean; service_role_execute: boolean; public_execute: boolean; anon_execute: boolean; authenticated_execute: boolean; no_dangling_references: boolean } };
type BuildIdentity = SystemHealthSnapshot["build"];

const check = (id: SystemHealthCheckId, category: "application" | "database" | "runtime" | "trust", label: string, state: SystemHealthState, summary: string, action: string | null) => ({ id, category, label, state, summary, action });
const checksum = /^[a-f0-9]{64}$/u;
const migrationName = /^\d+_[A-Za-z0-9_-]+\.sql$/u;

function isLedger(data: unknown): data is InternalSnapshot {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  const vault = value.vault as Record<string, unknown> | undefined;
  return Array.isArray(value.ledger) && !!vault && ["extension", "secrets_relation", "decrypt_rpc", "service_role_execute", "public_execute", "anon_execute", "authenticated_execute", "no_dangling_references"].every((key) => typeof vault[key] === "boolean");
}

function classifyMigrations(applied: LedgerRow[] | null, expected: readonly (readonly [string, string])[]): SystemHealthSnapshot["migrations"] {
  const expectedHead = expected.at(-1)?.[0] ?? "";
  if (expected.length === 0) return { state: "unknown", expected_head: expectedHead, applied_head: null, missing_count: 0, extra_count: 0, action: "Build migration manifest is unavailable." };
  if (!applied) return { state: "unknown", expected_head: expectedHead, applied_head: null, missing_count: 0, extra_count: 0, action: "Verify the database migration ledger." };
  if (applied.some((row) => !row || typeof row.version !== "string" || typeof row.checksum !== "string" || row.checksum === "")) {
    return { state: "unknown", expected_head: expectedHead, applied_head: null, missing_count: 0, extra_count: 0, action: "Re-vet the database migration ledger." };
  }
  if (applied.some((row) => !migrationName.test(row.version) || !checksum.test(row.checksum))) return { state: "incompatible", expected_head: expectedHead, applied_head: null, missing_count: 0, extra_count: 0, action: "Resolve the migration manifest mismatch before operating the system." };
  const duplicate = new Set(applied.map((row) => row.version)).size !== applied.length;
  const mismatch = duplicate || applied.slice(0, expected.length).some((row, index) => row.version !== expected[index]?.[0] || row.checksum !== expected[index]?.[1]);
  const appliedHead = applied.at(-1)?.version ?? null;
  if (mismatch) return { state: "incompatible", expected_head: expectedHead, applied_head: appliedHead, missing_count: 0, extra_count: 0, action: "Resolve the migration manifest mismatch before operating the system." };
  if (applied.length < expected.length) return { state: "behind", expected_head: expectedHead, applied_head: appliedHead, missing_count: expected.length - applied.length, extra_count: 0, action: "Apply the expected migrations." };
  if (applied.length > expected.length) return { state: "ahead", expected_head: expectedHead, applied_head: appliedHead, missing_count: 0, extra_count: applied.length - expected.length, action: "Use a build that recognizes the applied migrations." };
  return { state: "current", expected_head: expectedHead, applied_head: appliedHead, missing_count: 0, extra_count: 0, action: "Migration ledger matches this build." };
}

function validCacheKey(): boolean {
  const raw = process.env.CACHE_ENC_KEY;
  if (!raw) return false;
  try { return Uint8Array.from(atob(raw.trim().replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).length === 32; } catch { return false; }
}

async function boundedPing(ping: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([ping(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 1200); })]);
    return result === "PONG" || result === true;
  } catch { return false; } finally { if (timer) clearTimeout(timer); }
}

export async function getSystemHealthSnapshot(options: {
  expectedMigrations?: readonly (readonly [string, string])[];
  redisPing?: () => Promise<unknown>;
  buildIdentity?: BuildIdentity;
} = {}): Promise<SystemHealthSnapshot> {
  const identity = getBuildIdentity();
  const expected = options.expectedMigrations ?? identity.migrations.entries.map((entry) => [entry.version, entry.checksum] as const);
  const dbRead: Promise<InternalSnapshot | null> = (async () => {
    try {
      const db = serviceClient();
      const { data, error } = await Promise.race([db.rpc("system_health_snapshot"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200))]);
      return !error && isLedger(data) ? data : null;
    } catch { return null; /* Database evidence is unavailable, never exposed. */ }
  })();
  const redisRead = boundedPing(options.redisPing ?? (() => redis().ping()));
  const [internal, redisReady] = await Promise.all([dbRead, redisRead]);

  const migrations = classifyMigrations(internal?.ledger ?? null, expected);
  const migrationState: SystemHealthState = migrations.state === "current" ? "ready" : migrations.state === "unknown" ? "unknown" : "degraded";
  const visaReady = !!normaliseVisaSecret(process.env.VISA_SECRET);
  const cacheReady = validCacheKey();
  let signer = null;
  let issuer = null;
  try { signer = loadInstanceSigner(); issuer = instanceIssuer(); } catch { /* malformed local signing config is degraded */ }
  const receiptState: SystemHealthState = signer && issuer ? "ready" : !process.env.INSTANCE_SIGNING_KEY && !process.env.PASSCONTROL_ISSUER ? "disabled" : "degraded";
  const build = options.buildIdentity ?? identity;
  const buildState: SystemHealthState = build.channel === "unknown" || !build.commit ? "attention" : "ready";

  // Every row below is derived from something this call actually observed. There
  // is deliberately no row asserting that operator access is enforced: this
  // snapshot is only reachable through the operator gate, so such a row could
  // never be anything but "ready" — and a verdict icon that cannot change is
  // indistinguishable, on the page, from one that measured a dependency and
  // passed. The gate is stated in the page's own framing instead.
  const checks = [
    check("database", "database", "Database", internal ? "ready" : "degraded", internal ? "Database health evidence is available." : "Database health evidence is unavailable.", internal ? null : "Restore database connectivity."),
    check("migration_ledger", "database", "Migration ledger", migrationState, migrations.state === "current" ? "Migration ledger matches this build." : "Migration ledger requires operator attention.", migrations.action),
    check("vault_wiring", "database", "Vault wiring", internal ? (internal.vault.extension && internal.vault.secrets_relation && internal.vault.decrypt_rpc && internal.vault.service_role_execute && !internal.vault.public_execute && !internal.vault.anon_execute && !internal.vault.authenticated_execute && internal.vault.no_dangling_references ? "ready" : "degraded") : "unknown", internal && internal.vault.extension && internal.vault.secrets_relation && internal.vault.decrypt_rpc && internal.vault.service_role_execute && !internal.vault.public_execute && !internal.vault.anon_execute && !internal.vault.authenticated_execute && internal.vault.no_dangling_references ? "Vault wiring is present." : "Vault wiring could not be verified.", internal && internal.vault.extension && internal.vault.secrets_relation && internal.vault.decrypt_rpc && internal.vault.service_role_execute && !internal.vault.public_execute && !internal.vault.anon_execute && !internal.vault.authenticated_execute && internal.vault.no_dangling_references ? null : "Verify Vault wiring."),
    check("redis", "runtime", "Redis", redisReady ? "ready" : "degraded", redisReady ? "Redis accepted a bounded read-only probe." : "Redis read probe failed.", redisReady ? null : "Restore Redis connectivity."),
    check("visa_signing", "runtime", "Visa signing", visaReady ? "ready" : "degraded", visaReady ? "Visa signing configuration is valid." : "Visa signing configuration is invalid.", visaReady ? null : "Configure a valid visa signing secret."),
    check("cache_encryption", "runtime", "Cache encryption", cacheReady ? "ready" : "degraded", cacheReady ? "Cache encryption configuration is valid." : "Cache encryption configuration is invalid.", cacheReady ? null : "Configure a valid cache encryption key."),
    check("receipt_signing", "trust", "Receipt signing", receiptState, receiptState === "ready" ? "Receipt signing is configured." : receiptState === "disabled" ? "Receipt signing is disabled." : "Receipt signing configuration is incomplete.", receiptState === "ready" ? null : "Configure receipt signing and issuer together."),
    check("build_identity", "application", "Build identity", buildState, buildState === "ready" ? "Build identity is available." : "Build identity requires attention.", buildState === "ready" ? null : "Provide a complete build identity."),
  ];
  const incompatible = ["behind", "ahead", "incompatible"].includes(migrations.state);
  const degraded = checks.some((item) => item.state === "degraded" || item.state === "unknown");
  const attention = checks.some((item) => item.state === "attention" || item.state === "disabled");
  return { format_version: 1, generated_at: new Date().toISOString(), overall: incompatible ? "incompatible" : degraded ? "degraded" : attention ? "attention" : "current", build: { version: build.version, commit: build.commit, channel: build.channel }, migrations, protocols: CLIENT_PROTOCOLS as unknown as SystemHealthSnapshot["protocols"], checks };
}

export { classifyMigrations };
