import { instanceIssuer } from "@/lib/crypto/instanceKey";

const AUTH_DESTINATIONS = new Set(["/dashboard", "/login/reset"]);

/** Only routes that are valid post-auth destinations may cross the callback. */
export function safeAuthDestination(value: string | null | undefined): string {
  return value && AUTH_DESTINATIONS.has(value) ? value : "/dashboard";
}

/**
 * Build an email link from the configured canonical origin, never the request
 * Host header. This prevents a spoofed Host from becoming a recovery link.
 */
export function authEmailRedirect(destination = "/dashboard"): string | null {
  const origin = instanceIssuer();
  if (!origin) return null;
  const url = new URL("/auth/callback", origin);
  const safeDestination = safeAuthDestination(destination);
  if (safeDestination !== "/dashboard") url.searchParams.set("next", safeDestination);
  return url.toString();
}
