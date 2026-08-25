import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Edge routes cannot read the checkout at request time. Freeze the exact bytes
// we build against once here, rather than reporting whatever a mutable runtime
// filesystem happens to contain. `env` is intentionally used so Next inlines
// it into the Edge bundle; the sole consumer is server-only and authenticated.
const migrationsDir = path.join(repoRoot, "db", "migrations");

/**
 * Absent and empty must land in the same place.
 *
 * The guard below exists to explain a manifest that would ship empty, and its
 * comment names `.vercelignore` as the cause — but an ignore rule removes the
 * DIRECTORY from the upload, not just its contents. Letting the ENOENT escape
 * meant the one scenario the guard was written for was the one it could never
 * report: the build died on `ENOENT ... scandir` instead. Any other error
 * (permissions, a file where the directory should be) is still a real fault and
 * still thrown.
 */
function readMigrationEntries() {
  let names;
  try {
    names = fs.readdirSync(migrationsDir);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      version: name,
      checksum: createHash("sha256").update(fs.readFileSync(path.join(migrationsDir, name))).digest("hex"),
    }));
}

const migrationEntries = readMigrationEntries();
// An empty manifest is not a usable build: System Health would report the
// ledger "unknown" forever and no check could ever fail. Refuse to build one
// rather than deploy a diagnostic that cannot diagnose. This fired for real —
// .vercelignore's `*.sql` glob excluded db/migrations from the Vercel upload,
// and the only symptom was a degraded panel on an already-live deployment.
if (isProd && migrationEntries.length === 0) {
  throw new Error(
    "No migrations found in db/migrations — the migration manifest would ship empty. " +
      "On Vercel this usually means .vercelignore excluded them from the upload."
  );
}

const migrationManifest = JSON.stringify({
  entries: migrationEntries,
  head: migrationEntries.at(-1)?.version ?? "",
  // Hash the canonical compact entries JSON, not the enclosing object: a
  // consumer can reproduce it from the entries it received.
  fingerprint: createHash("sha256").update(JSON.stringify(migrationEntries)).digest("hex"),
});

// The page Content-Security-Policy is NOT here any more. It is built per request
// around a fresh nonce in middleware.ts (see lib/csp.ts), because a static header
// cannot carry a nonce. Do not reintroduce a CSP under "/:path*": pages would
// then receive two policies and browsers enforce the intersection, silently
// crippling the nonce policy. tests/csp.test.ts fails if that comes back.
//
// The API keeps its own static policy. Those responses are JSON — nothing to
// execute, embed, or frame — so it is strictly tighter than the page policy and
// shares nothing with it.
const apiCsp = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "sandbox",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  // Cross-origin isolation. Safe here — no OAuth popups / cross-origin embeds
  // that COOP/CORP would break.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // HSTS only in prod (localhost ignores it; preload is a real commitment).
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

// Never cache authenticated/sensitive responses.
const noStore = { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" };

const nextConfig = {
  env: {
    PASSCONTROL_INTERNAL_MIGRATION_MANIFEST: migrationManifest,
  },
  reactStrictMode: true,
  // Don't advertise the framework — strip the default `X-Powered-By: Next.js`
  // header so responses reveal less about the stack to attackers.
  poweredByHeader: false,
  experimental: {
    // Server Actions are used by the dashboard kill-switch / key management flows.
    serverActions: { bodySizeLimit: "1mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/dashboard/:path*", headers: [noStore] },
      { source: "/dashboard", headers: [noStore] },
      {
        source: "/api/:path*",
        headers: [noStore, { key: "Content-Security-Policy", value: apiCsp }],
      },
      // The JWKS is the one document other deployments are meant to fetch, so
      // the global Cross-Origin-Resource-Policy: same-origin above must not
      // apply to it. The route handler sets these too; this entry keeps the
      // config from contradicting it. Deliberately NOT under /api/:path*, which
      // would attach no-store to a document that should be cached.
      {
        source: "/.well-known/:path*",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Content-Security-Policy", value: apiCsp },
        ],
      },
      { source: "/login", headers: [noStore] },
      { source: "/login/:path*", headers: [noStore] },
      { source: "/signup", headers: [noStore] },
    ];
  },
};

export default nextConfig;
