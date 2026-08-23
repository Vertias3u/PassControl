import "server-only";

// The authenticated route imports this collector. It never uses the runtime
// filesystem: Next froze migration bytes into one environment string at build.
import packageJson from "@/package.json";
import { CLIENT_PROTOCOLS } from "@/cli/protocols.mjs";
import {
  MIGRATION_MANIFEST_ENV,
  parseMigrationManifest,
  releaseChannel,
  releaseCommit,
} from "./build-identity-values";

export { MIGRATION_MANIFEST_ENV, type MigrationDigest, type ReleaseChannel } from "./build-identity-values";

export function getBuildIdentity(
  env: Record<string, string | undefined> = process.env,
  // Keep this property access literal: Next's Edge compiler replaces values
  // declared through `nextConfig.env` at build time, whereas a computed lookup
  // can remain a runtime `process.env` read.
  manifest: unknown = process.env.PASSCONTROL_INTERNAL_MIGRATION_MANIFEST
) {
  return {
    version: packageJson.version,
    commit: releaseCommit(env),
    channel: releaseChannel(env),
    migrations: parseMigrationManifest(manifest),
    protocols: CLIENT_PROTOCOLS,
  } as const;
}

/** @deprecated Use getBuildIdentity(); retained while the route is assembled. */
export const buildIdentity = getBuildIdentity;
