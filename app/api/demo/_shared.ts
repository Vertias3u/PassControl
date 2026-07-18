// Server-route-only helpers for the public, keyless PassControl demo.
import { demoPassportId } from "@/lib/demo/identity";

export { demoPassportId };

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
