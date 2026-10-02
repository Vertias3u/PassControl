// How a service call is explained to an operator. Presentation only — nothing in
// the check order may import this (the same rule lib/call-class.ts states).
//
// The call drawer's explanations are written for model calls ("the provider and
// model", "store a key for it"), and reading one of those under a refused
// GitHub call sends an operator to the wrong screen. These replace them for the
// statuses a service call can actually have.
import { SERVICE_CATALOG, isServiceId } from "@/lib/services/catalog";

/** "GitHub" for `svc:github`; the stored id itself for a service this build does not know. */
export function serviceLabelFor(provider: string | null | undefined): string {
  if (!provider) return "the service";
  const id = provider.startsWith("svc:") ? provider.slice(4) : provider;
  return isServiceId(id) ? SERVICE_CATALOG[id].label : provider;
}

/** The drawer's explanation for a service call's status, or null to use the shared one. */
export function serviceCallExplanation(status: string | null | undefined, provider: string | null | undefined): string | null {
  const name = serviceLabelFor(provider);
  switch (status) {
    case "ok":
      return `PassControl admitted this call under the agent's ${name} rules and sent it with the workspace's ${name} token, which the agent never holds. A service call has no price: it sits outside the agent's dollar limit, and its limit is the hourly call cap.`;
    case "upstream_error":
      return `PassControl admitted this call and sent it; ${name} answered with an error, or could not be reached. The response the agent received is ${name}'s own.`;
    case "blocked_scope":
      return `No rule in this agent's ${name} access admitted this method and path, so nothing was sent. Service access is deny-by-default. If the agent's rules could not be read, or are not valid, every ${name} call is refused until that is fixed.`;
    case "blocked_policy":
      return `The agent's hourly ${name} call cap was used up, or could not be read (which refuses rather than guessing), so nothing was sent.`;
    case "blocked_endpoint":
      return `PassControl refused this ${name} call before sending it, whatever the agent's rules say: the endpoint is never allowed (for GitHub, GraphQL and writes such as deleting a repository or adding a webhook; for Telegram, setWebhook, deleteWebhook, logOut, close and file downloads), or the request body was not a type ${name} accepts here, or was too large.`;
    case "no_provider_key":
      return `No ${name} token is stored for this workspace, so there was nothing to inject and ${name} never received this call. Add the token in Settings, under Services.`;
    case "endpoint_unavailable":
      return `PassControl could not read the stored ${name} token, so nothing was sent. This is a database read that failed, not a missing token.`;
    default:
      return null;
  }
}

/**
 * What the service's own HTTP status means, in place of the model-provider
 * wording in describeUpstreamStatus ("the stored provider key", "a model id").
 * Null for a status with nothing specific to say.
 */
export function serviceUpstreamMeaning(status: number, provider: string | null | undefined): string | null {
  const name = serviceLabelFor(provider);
  if (status === 401) {
    return `${name} rejected the stored ${name} token: expired, revoked, or not valid.`;
  }
  if (status === 403) {
    return `${name} refused this request with the stored token: the token lacks the permission, or ${name} rate-limited it.`;
  }
  if (status === 404) {
    // GitHub hides a private resource the token cannot see behind 404; other
    // services mean only "no such thing" (Telegram: no such method).
    return provider === "svc:github"
      ? `${name} has no such resource, or the stored token cannot see it. ${name} answers 404, not 403, for a private resource a token has no access to.`
      : `${name} has no such method or resource.`;
  }
  if (status === 429) {
    return `${name} rate-limited this call. The agent's PassControl hourly cap was not the limit here.`;
  }
  if (status >= 500 && status <= 599) {
    return `${name} failed to answer. Nothing was refused by PassControl.`;
  }
  return null;
}
