/** Build the internal request used by the Cloudflare Cron Trigger. */

export function createReconcileRequest(env) {
  return createCronRequest(env, "/api/cron/reconcile");
}


function createCronRequest(env, pathname) {
  if (!env?.CRON_SECRET) throw new Error("CRON_SECRET is not configured.");
  if (!env?.PASSCONTROL_ISSUER) throw new Error("PASSCONTROL_ISSUER is not configured.");

  const issuer = new URL(env.PASSCONTROL_ISSUER);
  if (issuer.origin !== env.PASSCONTROL_ISSUER || issuer.pathname !== "/") {
    throw new Error("PASSCONTROL_ISSUER must be a bare origin.");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (issuer.protocol !== "https:" && !loopback.has(issuer.hostname)) {
    throw new Error("PASSCONTROL_ISSUER must use HTTPS outside local development.");
  }

  return new Request(new URL(pathname, issuer), {
    method: "GET",
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
  });
}

export async function runReconcile(fetchHandler, env, ctx) {
  const response = await fetchHandler(createReconcileRequest(env), env, ctx);
  if (!response.ok) {
    throw new Error(`PassControl reconcile returned HTTP ${response.status}.`);
  }
}

