// Pure validation and environment resolution used by the server-only collector.
// Kept separate so their security cases can run in a plain Vitest process.
export const MIGRATION_MANIFEST_ENV = "PASSCONTROL_INTERNAL_MIGRATION_MANIFEST";

export type MigrationDigest = Readonly<{ version: string; checksum: string }>;
export type ReleaseChannel = "beta" | "stable" | "development" | "unknown";

const SHA256 = /^[a-f0-9]{64}$/;
const MIGRATION_NAME = /^\d+_[A-Za-z0-9_-]+\.sql$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const emptyManifest = () => ({ entries: [] as readonly MigrationDigest[], head: "", fingerprint: "" });

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMigrationManifest(raw: unknown): Readonly<{
  entries: readonly MigrationDigest[];
  head: string;
  fingerprint: string;
}> {
  if (typeof raw !== "string") return emptyManifest();
  try {
    const parsed = record(JSON.parse(raw));
    if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.head !== "string" || typeof parsed.fingerprint !== "string") return emptyManifest();
    const migrations: MigrationDigest[] = [];
    const names = new Set<string>();
    for (const value of parsed.entries) {
      const item = record(value);
      const version = item?.version;
      const checksum = item?.checksum;
      if (typeof version !== "string" || typeof checksum !== "string") return emptyManifest();
      if (!MIGRATION_NAME.test(version) || !SHA256.test(checksum) || names.has(version)) return emptyManifest();
      names.add(version);
      migrations.push({ version, checksum });
    }
    // The entries are the authority for migration comparison. Fingerprint is a
    // display/debug identifier, not a health decision input, so the Edge parser
    // validates its shape but does not need Node crypto to recompute it.
    if (!SHA256.test(parsed.fingerprint)) return emptyManifest();
    if (!migrations.every((migration, index) => index === 0 || migrations[index - 1]!.version < migration.version)) return emptyManifest();
    if (parsed.head !== (migrations.at(-1)?.version ?? "")) return emptyManifest();
    return { entries: migrations, head: parsed.head, fingerprint: parsed.fingerprint };
  } catch {
    return emptyManifest();
  }
}

export function releaseCommit(env: Record<string, string | undefined>): string | null {
  for (const name of ["PASSCONTROL_BUILD_SHA", "VERCEL_GIT_COMMIT_SHA", "CF_PAGES_COMMIT_SHA"]) {
    const candidate = env[name]?.trim();
    if (candidate && COMMIT.test(candidate)) return candidate.toLowerCase();
  }
  return null;
}

export function releaseChannel(env: Record<string, string | undefined>): ReleaseChannel {
  const explicit = env.PASSCONTROL_RELEASE_CHANNEL;
  if (explicit === "beta" || explicit === "stable" || explicit === "development") return explicit;
  // CF_PAGES_BRANCH is present on production too, so it is not a preview flag.
  const preview = env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development";
  return env.NODE_ENV !== "production" || preview ? "development" : "unknown";
}
