// Server-route-only helpers for the public, keyless PassControl demo.
import { demoPassportId } from "@/lib/demo/identity";

export { demoPassportId };

export interface DemoAgent {
  user_id?: unknown;
  status?: unknown;
  allowed_scopes?: unknown;
}

export function isDemoOnlyAgent(
  agent: DemoAgent
): agent is DemoAgent & { user_id: string } {
  if (typeof agent.user_id !== "string" || agent.status !== "active") return false;
  if (!Array.isArray(agent.allowed_scopes) || agent.allowed_scopes.length === 0) return false;
  return agent.allowed_scopes.every((scope) => {
    if (!scope || typeof scope !== "object") return false;
    return (scope as { provider?: unknown }).provider === "demo";
  });
}

/**
 * How long a public-demo kill-switch arm survives before it expires on its own.
 *
 * The demo kill switch is ONE tenant flag shared by every anonymous visitor, so
 * an arm has to self-heal: a visitor who arms it and closes the tab would
 * otherwise leave the public demo stuck at "blocked" forever. Long enough to
 * walk through the demo (arm → re-run the call → see it blocked), short enough
 * that the next visitor lands on a working demo. Real tenants never expire —
 * see `armTenantKill`.
 */
export const DEMO_KILL_TTL_SECONDS = 120;

export function demoEnabled(): boolean {
  return process.env.PASSCONTROL_DEMO === "1";
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
