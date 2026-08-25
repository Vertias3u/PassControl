import { getMigrationHealth, getSystemHealthSnapshot } from "./index";

/** Short enough for operations, long enough to remove per-navigation probes. */
export const SYSTEM_HEALTH_CACHE_SECONDS = 45;

/**
 * A small isolate-local TTL is deliberate. The supported Cloudflare adapter's
 * default incremental cache is a throwing dummy, so Next's unstable_cache is
 * neither a cache nor warn-only there. An isolate-local value is free, requires
 * no paid service, and coalesces concurrent misses. Different isolates may each
 * collect once per window; the snapshot contains no tenant data.
 */
function ttlCollector<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  let pending: Promise<T> | null = null;

  return async () => {
    const now = Date.now();
    if (cached && now < cached.expiresAt) return cached.value;
    if (pending) return pending;

    pending = load()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + SYSTEM_HEALTH_CACHE_SECONDS * 1_000 };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

export const getCachedMigrationHealth = ttlCollector(getMigrationHealth);
export const getCachedSystemHealthSnapshot = ttlCollector(getSystemHealthSnapshot);
