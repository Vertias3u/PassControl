// The unauthenticated "is the gateway there?" probe behind `status`, `version`
// and the menu: GET /api/version, which carries no credential.
//
// A gateway on this machine answers in milliseconds, so a short timeout keeps a
// stopped local stack from stalling the command. A remote one (Cloud, or a
// self-host on another host) pays for DNS, TLS and possibly a cold start on the
// first call, which can exceed a second; with the local timeout, a new Cloud
// user's first `status` read "offline". A timeout is also reported as one: "no
// answer" and "offline" send an operator to different places.
import { isLoopbackBindHost } from "./proxy-policy.mjs";

export const LOCAL_PROBE_TIMEOUT_MS = 1200;
export const REMOTE_PROBE_TIMEOUT_MS = 6000;

/** Whether a gateway origin is on this machine. A malformed one counts as local: the checks then run. */
export function isLocalGatewayOrigin(origin) {
  try {
    return isLoopbackBindHost(new URL(origin).hostname);
  } catch {
    return true;
  }
}

export function probeTimeoutMs(origin) {
  try {
    return isLoopbackBindHost(new URL(origin).hostname) ? LOCAL_PROBE_TIMEOUT_MS : REMOTE_PROBE_TIMEOUT_MS;
  } catch {
    return LOCAL_PROBE_TIMEOUT_MS;
  }
}

/** GET <origin>/api/version with a timeout, as a status row. `origin` must already be validated. */
export async function probeGatewayVersion(origin, { fetchImpl = fetch, timeoutMs = probeTimeoutMs(origin) } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/api/version`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return { label: `unhealthy (${res.status})`, ok: false };
    const body = await res.json().catch(() => null);
    const version = typeof body?.version === "string" && body.version.trim() ? body.version.trim() : null;
    return version
      ? { label: `online (${res.status}, PassControl ${version})`, ok: true, version }
      : { label: "unhealthy (not a PassControl version response)", ok: false };
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      return { label: `no answer within ${timeoutMs / 1000} s`, ok: false };
    }
    return { label: "offline or unreachable", ok: false };
  } finally {
    clearTimeout(timer);
  }
}
