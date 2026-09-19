import type { ProviderId } from "@/lib/providers";
import { scopeAllows } from "@/lib/scope";
import {
  DEFAULT_ALLOWED_MODELS as SHARED_ALLOWED_MODELS,
  DEFAULT_CLIENT_MODELS as SHARED_CLIENT_MODELS,
} from "@/cli/integration-defaults.mjs";

/** One source for the capability pattern and the concrete model shown by both
 * Direct Agent Key and Passport onboarding. The two values are deliberately
 * separate: the first authorizes; the second is sent to the provider. */
export const DEFAULT_ALLOWED_MODELS: Readonly<Record<ProviderId, string>> = SHARED_ALLOWED_MODELS;

export const DEFAULT_CLIENT_MODELS: Readonly<Record<ProviderId, string>> = SHARED_CLIENT_MODELS;

/** Runtime model ids are copied into environment/configuration blocks and sent
 * verbatim to a provider. Wildcards belong only in the capability pattern. */
export function clientModelIsUsable(value: string): boolean {
  const model = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model);
}

/**
 * How many discovered models the onboarding UI offers as one-click suggestions.
 *
 * Deliberately NOT tied to `LIMITS.models`. That number is an authorization
 * bound — the most patterns one scope entry may carry — and discovery is not
 * authorization. Coupling the two is the bug this exists to prevent: the probe
 * used to stop collecting at exactly 50, `LIMITS.models` is exactly 50, and the
 * onramp pasted the whole list into the grant. The result was a scope saturated
 * at the validator's ceiling before the operator had chosen anything, so adding
 * one more legitimate model — `gpt-5-mini`, the very model our own defaults tell
 * people to call — failed with "Invalid models in scope."
 */
export const DISCOVERED_MODEL_SUGGESTION_LIMIT = 24;

/**
 * The discovered ids this gateway could actually route, newest-looking first.
 *
 * A provider's `/models` listing answers "what does this key reach", which is a
 * much larger question than "what can PassControl send there". OpenAI returns
 * embeddings, Whisper, TTS, image and moderation models; the endpoint allowlist
 * exposes chat/completions, responses and the model listing, and nothing else.
 * Granting `whisper-1` is authorizing a call that can never be made — noise in
 * an audit trail whose whole value is that every line means something.
 *
 * The filter is the provider's OWN default capability pattern
 * (`DEFAULT_ALLOWED_MODELS`), asked of the real scope matcher rather than
 * re-implemented. So this is not a hand-kept table of which model is a chat
 * model — it is the same rule the gateway already enforces at request time,
 * read off configuration that already exists. A provider added tomorrow is
 * covered the day its default pattern is written.
 *
 * Order is preserved from the provider's own listing; nothing is invented.
 *
 * ── The pattern is a hint, so it is never allowed to empty the list ──────────
 *
 * A default pattern is written for the models we DOCUMENT, not to describe
 * everything a provider serves, and for two of them it does not describe the
 * listing at all. Google's OpenAI-compatibility endpoint returns ids spelled
 * `models/gemini-2.5-flash`, which `gemini-*` does not match — measured, and it
 * left NOTHING. Together's default is `openai/gpt-oss-*` while its catalogue is
 * mostly `meta-llama/…` and `Qwen/…`.
 *
 * An empty picker on a key that reaches dozens of usable models is a worse
 * failure than showing a few models the gateway cannot route: the first tells
 * the operator their key found nothing, the second costs them a glance. So when
 * the pattern matches none of what came back, the pattern is the thing that was
 * wrong and the full listing is returned. The filter keeps its value where it is
 * doing real work — OpenAI, where it is what removes Whisper, TTS, embeddings,
 * image and moderation models from a chat agent's grant.
 */
function patternMatchedModels(provider: ProviderId, discovered: readonly string[]): string[] {
  const pattern = DEFAULT_ALLOWED_MODELS[provider];
  if (!pattern) return [...discovered];
  const scopes = [{ provider, models: [pattern] }];
  return discovered.filter((model) => scopeAllows(scopes, provider, model));
}

export function routableDiscoveredModels(
  provider: ProviderId,
  discovered: readonly string[]
): string[] {
  const matched = patternMatchedModels(provider, discovered);
  return matched.length ? matched : [...discovered];
}

/**
 * The concrete model to put in "Model to call".
 *
 * Our own documented default wins when the key can actually reach it, because
 * that is the model every quickstart, CLI preset and snippet names. Otherwise
 * the first routable discovered id, and only then the default regardless.
 *
 * This used to be `models.find(clientModelIsUsable)` — the first id the provider
 * happened to return — which for OpenAI is `text-embedding-ada-002`. The field
 * that decides what actually gets sent to the provider was defaulting to an
 * embedding model on a chat endpoint.
 *
 * Deliberately reads the STRICT pattern match, not `routableDiscoveredModels`.
 * That function widens to the whole listing rather than show an empty picker,
 * which is right for a list of suggestions and wrong here: widening would put
 * the first unmatched id back in this field, which is the original bug. A
 * suggestion the operator can ignore and the single model this agent will
 * actually send are not the same decision, so they do not share a rule.
 */
export function preferredClientModel(
  provider: ProviderId,
  discovered: readonly string[]
): string {
  const fallback = DEFAULT_CLIENT_MODELS[provider];
  if (discovered.includes(fallback)) return fallback;
  const matched = patternMatchedModels(provider, discovered).find(clientModelIsUsable);
  return matched ?? fallback;
}
