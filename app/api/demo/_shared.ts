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
