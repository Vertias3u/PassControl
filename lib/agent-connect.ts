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
 * How many discovered models the onboarding UI shows as suggestions, and how
 * many more it lists under "Other models on this key".
 *
 * Deliberately NOT tied to `LIMITS.models`. That number is an authorization
 * bound — the most patterns one scope entry may carry — and discovery is not
 * authorization. Coupling the two is the bug these exist to prevent: the probe
 * used to stop collecting at exactly 50, `LIMITS.models` is exactly 50, and the
 * onramp pasted the whole list into the grant. The result was a scope saturated
 * at the validator's ceiling before the operator had chosen anything, so adding
 * one more legitimate model — `gpt-5-mini`, the very model our own defaults tell
 * people to call — failed with "Invalid models in scope."
 *
 * Sized so that the pre-filled model plus every chip the picker can render
 * still fits one scope entry (1 + 24 + 24 ≤ 50): no amount of clicking what is
 * on screen can reach that error. Anything beyond is still typed by hand.
 */
export const DISCOVERED_MODEL_SUGGESTION_LIMIT = 24;
export const OTHER_MODEL_DISPLAY_LIMIT = 24;

/*
 * ── What a `/models` listing can and cannot tell us ──────────────────────────
 *
 * The probe keeps ids only, and ids are all most providers give: OpenAI's
 * entries are `{ id, object, created, owned_by }`, with no field saying whether
 * a model speaks chat/completions, Responses, audio or embeddings. Neither does
 * a scope glob — `gpt-*` matching `gpt-4o-transcribe` proves the pattern
 * authorizes it, not that the model answers on any endpoint this gateway
 * proxies.
 *
 * So everything below is a PRESENTATION heuristic over id shapes, and it is
 * only ever used to order a picker. It never removes a discovered id, never
 * feeds validation, and never decides what an agent may call.
 */

/** Families whose names say they are not text-generation models: embeddings,
 *  speech, transcription, image/video, moderation, rerankers, safety
 *  classifiers, OCR. Matched as a whole token so `deepseek` is not `search`. */
const SPECIALIST_TOKEN =
  /(?:^|[-/_.:])(?:embed\w*|whisper|tts|transcribe|audio|realtime|speech|image|imagen|dall-e|sora|veo|moderation|search|computer-use|rerank\w*|guard|ocr)(?=$|[-/_.:\d])/;

/** Model families that have been superseded. Only ever old names, so this list
 *  does not need to track new releases. `-instruct` is NOT here: it is how
 *  current open-weights models are named. */
const LEGACY_FAMILY =
  /^(?:gpt-3(?:\.5)?(?![\d.])|gpt-4(?![\d.o])|(?:text-|code-)?(?:davinci|curie|babbage|ada)(?:-|$)|claude-(?:instant|[12])(?![\d.]))/;

/** A dated-snapshot suffix: `-2025-04-14`, `-20250929`, or a month-day `-0613`.
 *  Month and day are range-checked so `-4096`, `-2411` and `-120b` are not dates. */
const SNAPSHOT_SUFFIX =
  /-(?:\d{4}-\d{2}-\d{2}|20\d{6}|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/;

/** First `major[.minor]` in an id, used only to put newer models first.
 *  Skips parameter counts (`70b`, `16k`) and digits glued to other digits. */
const VERSION = /(?<![\d.])(\d{1,2})(?:\.(\d{1,2})|-(\d)(?=-|$))?(?!\d|[bkm](?![a-z]))/;

type Tier = "general" | "snapshot" | "legacy" | "specialist";

function lastSegment(id: string): string {
  return id.toLowerCase().split("/").pop() ?? "";
}

function tierOf(id: string, listed: ReadonlySet<string>): Tier {
  const name = lastSegment(id);
  if (SPECIALIST_TOKEN.test(id.toLowerCase())) return "specialist";
  if (LEGACY_FAMILY.test(name)) return "legacy";
  // A snapshot is only demoted when its stable alias is also on the key.
  // Anthropic lists dated ids and little else; burying those would empty the
  // picker for a key that reaches every model.
  const alias = id.replace(SNAPSHOT_SUFFIX, "");
  if (alias !== id && (listed.has(alias) || listed.has(`${alias}-latest`))) return "snapshot";
  return "general";
}

function versionOf(id: string): number | null {
  const m = VERSION.exec(lastSegment(id));
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2] ?? m[3] ?? 0);
}

/** General-tier ids, newest-looking first; unversioned ids keep listing order after them. */
function generalModels(discovered: readonly string[]): { general: string[]; rest: Record<Exclude<Tier, "general">, string[]> } {
  const unique = [...new Set(discovered)];
  const listed = new Set(unique);
  const rest = { snapshot: [] as string[], legacy: [] as string[], specialist: [] as string[] };
  const general: string[] = [];
  for (const id of unique) {
    const tier = tierOf(id, listed);
    if (tier === "general") general.push(id);
    else rest[tier].push(id);
  }
  // Array.prototype.sort is stable, so equal versions keep the provider's order.
  general.sort((a, b) => (versionOf(b) ?? -1) - (versionOf(a) ?? -1));
  return { general, rest };
}

/**
 * Splits a provider's model listing into what the picker suggests and what it
 * lists as "other" — for a human choosing a grant, nothing more.
 *
 * `suggested`: general-purpose-looking ids, newest version first, capped at
 * DISCOVERED_MODEL_SUGGESTION_LIMIT. Provider order is NOT a recommendation;
 * OpenAI's puts `gpt-3.5-turbo-16k` ahead of `gpt-5.1`.
 *
 * `other`: everything else the key reported — the suggestion overflow, then
 * dated snapshots whose alias is present, superseded families, and specialist
 * (audio, image, embedding, moderation…) models. Listed, not recommended.
 *
 * Every discovered id lands in exactly one of the two. Provider-agnostic on
 * purpose: the rules read id shapes, not a per-provider catalogue.
 */
export function rankDiscoveredModels(discovered: readonly string[]): {
  suggested: string[];
  other: string[];
} {
  const { general, rest } = generalModels(discovered);
  return {
    suggested: general.slice(0, DISCOVERED_MODEL_SUGGESTION_LIMIT),
    other: [
      ...general.slice(DISCOVERED_MODEL_SUGGESTION_LIMIT),
      ...rest.snapshot,
      ...rest.legacy,
      ...rest.specialist,
    ],
  };
}

/**
 * The concrete model to put in "Model to call".
 *
 * Our own documented default wins when the key reports it, because that is the
 * model every quickstart, CLI preset and snippet names — and it wins even when
 * the picker ranks something newer above it. Suggestion order and the model
 * this agent actually sends are separate decisions.
 *
 * Otherwise the first general-tier id that the provider's default pattern also
 * covers, and only then the documented default regardless. Both conditions are
 * needed: the pattern alone let `gpt-image-1` qualify, and the tier alone would
 * swap gemini's bare `gemini-3.8-flash` for the compat listing's
 * `models/gemini-3.8-flash` spelling.
 *
 * This used to be `models.find(clientModelIsUsable)` — the first id the provider
 * happened to return — which for OpenAI is `text-embedding-ada-002`.
 */
export function preferredClientModel(
  provider: ProviderId,
  discovered: readonly string[]
): string {
  const fallback = DEFAULT_CLIENT_MODELS[provider];
  if (discovered.includes(fallback)) return fallback;
  const pattern = DEFAULT_ALLOWED_MODELS[provider];
  const scopes = pattern ? [{ provider, models: [pattern] }] : [];
  const matched = generalModels(discovered).general.find(
    (model) => clientModelIsUsable(model) && scopeAllows(scopes, provider, model)
  );
  return matched ?? fallback;
}

/**
 * Whether the gateway could inject a key for this provider. `configured` is
 * "a key is stored", which is not "a key was tested" — the copy says stored.
 * `unknown` is a failed read, and is never shown as either answer.
 */
export function providerAvailability(
  configuredProviders: readonly ProviderId[] | null | undefined,
  provider: ProviderId
): "configured" | "missing" | "unknown" | "unchecked" {
  if (configuredProviders === undefined) return "unchecked";
  if (configuredProviders === null) return "unknown";
  return configuredProviders.includes(provider) ? "configured" : "missing";
}

/**
 * The concrete model a reopened Setup view puts in its examples: the first
 * exact model in the agent's own grant for this provider, else the provider's
 * usual model when the grant covers it, else null. Null is shown as "choose a
 * model", never filled in — a wildcard is an authorization rule, not something
 * a client can send.
 */
export function setupExampleModel(
  scopes: readonly { provider: string; models: readonly string[] }[],
  provider: ProviderId
): string | null {
  for (const entry of scopes) {
    if (entry.provider !== provider) continue;
    const concrete = entry.models.find((model) => clientModelIsUsable(model));
    if (concrete) return concrete;
  }
  const fallback = DEFAULT_CLIENT_MODELS[provider];
  return scopeAllows(
    scopes.map((entry) => ({ provider: entry.provider, models: [...entry.models] })),
    provider,
    fallback
  )
    ? fallback
    : null;
}
