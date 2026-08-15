// Which other providers could serve this call, when the one the agent asked for
// has run out of credit.
//
// Two constraints define the whole module, and both are about not lying:
//
// 1. **Only what our own gate would allow.** Candidates are intersected with the
//    scope snapshot carried in the VISA — the same value the scope gate checked
//    on the way in. Advertising anything else would send the agent to retry a
//    call our own gateway then refuses, which is a worse answer than silence.
//
// 2. **The shape boundary is stated, never crossed.** ENDPOINT_ALLOWLIST splits
//    the six providers five-to-one: anthropic alone takes `v1/messages`. The
//    gateway must never translate between those shapes — a lossy translation
//    returning a body the agent's SDK cannot
//    parse is the worst possible failure, because it looks like it worked. But
//    the AGENT knows both SDKs, so a cross-shape alternative is still worth
//    naming as long as it is marked. `same_shape: false` means "you have a key
//    and permission here, and you will have to rewrite the request yourself".
//
// Everything returned is the tenant's own configuration reflected back to a
// caller already holding a valid visa for it. No credential label, id or Vault
// reference is ever named — only the provider and the agent's own scope entry.
import type { ScopeEntry } from "../auth/visa";
import { isProvider, requestShapeFamily, type ProviderId } from "../providers";
import { advertisedClientPath, isModelListing } from "../scope";

export interface ProviderAlternative {
  provider: ProviderId;
  /** The agent's own scope patterns, echoed. Never resolved to concrete models. */
  models: string[];
  /** False when the agent must rewrite the request body itself. */
  same_shape: boolean;
  /** The proxy path this provider accepts, e.g. `/v1/openai/chat/completions`. */
  path: string;
}

export interface AlternativesInput {
  /** The visa's scope snapshot — deliberately not the current agent row. */
  scopes: readonly ScopeEntry[];
  providersWithKeys: readonly string[];
  failing: ProviderId;
  method: string;
  path: readonly string[];
}

export function buildAlternatives(input: AlternativesInput): ProviderAlternative[] {
  const withKeys = new Set(input.providersWithKeys);
  const operation = isModelListing(input.path) ? "models" : "chat";
  const failingFamily = requestShapeFamily(input.failing);

  const seen = new Set<string>();
  const alternatives: ProviderAlternative[] = [];

  for (const scope of input.scopes) {
    const provider = scope.provider;
    // allowed_scopes is jsonb and the visa carries it verbatim, so an entry can
    // name something we do not serve. Skip it rather than trusting the shape.
    if (!isProvider(provider)) continue;
    if (provider === input.failing) continue;
    if (!withKeys.has(provider)) continue;
    if (seen.has(provider)) continue;

    const clientPath = advertisedClientPath(provider, operation);
    // A provider with no endpoint for this operation cannot serve the call at
    // all; naming it would be an alternative that is not one.
    if (!clientPath) continue;

    seen.add(provider);
    alternatives.push({
      provider,
      models: [...scope.models],
      same_shape: requestShapeFamily(provider) === failingFamily,
      path: `/v1/${provider}/${clientPath.join("/")}`,
    });
  }

  // Same shape first — those are a base-URL swap. Order is otherwise the agent's
  // own scope order: the gateway has no basis for ranking two providers it was
  // told are both acceptable, and inventing one would be a quality judgement it
  // is explicitly not allowed to make.
  return alternatives.sort((a, b) => Number(b.same_shape) - Number(a.same_shape));
}
