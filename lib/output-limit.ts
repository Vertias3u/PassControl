// How many output tokens a request asks a provider for.
//
// Two readers, deliberately different in strictness:
//
//   * THE ESTIMATE (`statedOutputForEstimate`) sizes the budget hold. It must
//     never under-reserve, so it reads every alias any routed shape uses, takes
//     the LARGEST, and multiplies by the number of choices. A field the provider
//     would ignore can only make the hold bigger, which refuses a near-cap agent
//     sooner and never over-charges one — settlement still charges reported usage.
//
//   * THE CEILING (`requestedOutputTokens`, K2) decides admission against an
//     operator's `max_output_tokens` policy. It reads only the fields THIS
//     request shape's provider honours, because a limit stated in a field the
//     provider ignores does not bound what the provider generates. A request with
//     no honoured limit, or an unreadable one, is not a request under the
//     ceiling — the caller refuses it rather than rewriting the body.
import type { ProviderId } from "./providers";

/** Every output-limit spelling across the routed shapes. */
export const OUTPUT_LIMIT_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;
type OutputLimitField = (typeof OUTPUT_LIMIT_FIELDS)[number];

/**
 * The most choices a request may ask for that we will multiply by. OpenAI's own
 * ceiling on `n` is 128; a larger value is refused upstream, and bounding it
 * keeps the micro-cent arithmetic well inside safe integers.
 */
export const MAX_CHOICES = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usable token count: a finite, non-negative number. Strings are not counts. */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * Choices the estimate multiplies by. Anything that is not a whole number of at
 * least one reads as one — the provider rejects it, and a rejected call is not
 * one to size — and an enormous one is bounded rather than trusted.
 */
export function choiceCountForEstimate(body: unknown): number {
  if (!isRecord(body)) return 1;
  const n = body.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, MAX_CHOICES);
}

/**
 * The largest output limit the body states in ANY alias, or null for none.
 * Per choice; multiply by `choiceCountForEstimate` for the request's total.
 */
export function largestStatedOutputLimit(body: unknown): number | null {
  if (!isRecord(body)) return null;
  let largest: number | null = null;
  for (const field of OUTPUT_LIMIT_FIELDS) {
    const count = tokenCount(body[field]);
    if (count !== null && (largest === null || count > largest)) largest = count;
  }
  return largest;
}

// ── K2: the ceiling's reader ────────────────────────────────────────────────

/** The request shapes the gateway routes for inference, by output-limit semantics. */
export type OutputLimitShape = "anthropic_messages" | "openai_responses" | "chat_completions";

const SHAPE_FIELDS: Record<OutputLimitShape, readonly OutputLimitField[]> = {
  // Anthropic requires max_tokens; extended thinking is budgeted inside it.
  anthropic_messages: ["max_tokens"],
  // Responses has a single limit, covering reasoning and visible output.
  openai_responses: ["max_output_tokens"],
  // OpenAI and every OpenAI-compatible provider routed here. `max_tokens` is
  // the deprecated spelling; some providers honour only one of the two, so a
  // request is judged by the larger of whichever it states.
  chat_completions: ["max_completion_tokens", "max_tokens"],
};

/** Only chat completions accept `n`; the other shapes have one output. */
const SHAPE_HAS_CHOICES: Record<OutputLimitShape, boolean> = {
  anthropic_messages: false,
  openai_responses: false,
  chat_completions: true,
};

/**
 * Which output-limit semantics an inference request follows, from the
 * CANONICAL upstream path (the allowlist's own output), never the raw request.
 */
export function outputLimitShape(
  provider: ProviderId | "demo",
  upstreamPath: readonly string[]
): OutputLimitShape {
  const last = upstreamPath[upstreamPath.length - 1];
  if (provider === "anthropic" && last === "messages") return "anthropic_messages";
  // xAI's Responses documents `max_output_tokens` as covering reasoning, and
  // ignores the chat aliases, so it is judged by that field alone.
  if ((provider === "openai" || provider === "xai" || provider === "azure") && last === "responses") {
    return "openai_responses";
  }
  return "chat_completions";
}

export type RequestedOutput =
  /** The request bounds its output at `tokens` in total (per choice × choices). */
  | { kind: "stated"; tokens: number }
  /** No field this shape's provider honours states a limit. */
  | { kind: "absent" }
  /** A limit field or `n` is present but is not a usable whole number. */
  | { kind: "invalid"; field: string };

/**
 * The total output a request asks for, read strictly for its shape.
 *
 * Strict where the estimate is lenient: a string, a fraction, a negative or a
 * zero `n` is `invalid` here, because a ceiling that could be satisfied by a
 * value the provider will reinterpret is not a ceiling.
 */
export function requestedOutputTokens(shape: OutputLimitShape, body: unknown): RequestedOutput {
  const source = isRecord(body) ? body : {};
  let perChoice: number | null = null;
  for (const field of SHAPE_FIELDS[shape]) {
    if (!(field in source) || source[field] === null) continue;
    const value = source[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      return { kind: "invalid", field };
    }
    if (perChoice === null || value > perChoice) perChoice = value;
  }
  if (perChoice === null) return { kind: "absent" };

  let choices = 1;
  if (SHAPE_HAS_CHOICES[shape] && "n" in source && source.n !== null) {
    const n = source.n;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return { kind: "invalid", field: "n" };
    choices = n;
  }
  return { kind: "stated", tokens: perChoice * choices };
}
