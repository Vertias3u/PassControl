// Provider-specific usage tallying.
//
// S2: a SINGLE pass-through TransformStream forwards upstream bytes to the client
// unchanged while a buffered SSE line parser tallies tokens as a side effect.
// No tee() — so there is no second consumer to stall on backpressure/abort.
//
// S5: OpenAI Chat Completions only emits usage when
// stream_options.include_usage=true (injected by the proxy). The OpenAI
// Responses endpoint reports its differently named usage on a terminal response
// event without that flag. Anthropic emits usage natively in
// message_start/message_delta.
import { usesOpenAiUsageShape, type ProviderId } from "../providers";
import { TopLevelUsageScanner } from "./topLevelUsage";
import { xaiTicksToMicrocents, type HostedToolUse } from "@/lib/providers/hosted-tools";
import { openrouterReportedMicrocents } from "@/lib/providers/openrouter";

/**
 * Which usage report a response carries. `embeddings` is the OpenAI-shaped
 * embeddings response: it reports `prompt_tokens` (and `total_tokens`) and no
 * `completion_tokens`, because nothing is generated. Under the chat rule that
 * is an incomplete report and the call would be charged its whole estimate.
 */
/** `ollama`: Ollama's own API, NDJSON with `prompt_eval_count`/`eval_count` on the `done` line. */
export type UsageProtocol = "provider" | "responses" | "embeddings" | "ollama";

/**
 * What one call consumed.
 *
 * The two cache fields are Anthropic-shaped and exist because that provider
 * reports a cached call's input in THREE fields, of which `input_tokens` is only
 * the uncached remainder:
 *
 *   total prompt = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * So a steady-state cached agent reports `input_tokens: 12` for a call that
 * really consumed ~18k, and a gateway reading only `inputTokens` under-counts a
 * token budget by orders of magnitude. They are separate fields rather than
 * folded into `inputTokens` because they are priced differently (see
 * costMicrocentsForUsage) — a cache read is a tenth of the input rate.
 *
 * They are always 0 for the OpenAI-shaped providers, and that is correct, not an
 * omission: `prompt_tokens` there ALREADY includes cached tokens
 * (`prompt_tokens_details.cached_tokens` is a subset of it), so reporting a cache
 * figure as well would charge the same tokens twice. That subset is carried
 * separately, as `cachedInputTokens`, for the price alone (owner, 2026-10-07).
 */
/**
 * Anthropic's `usage.server_tool_use`, or null when absent. Missing counts are
 * zero; a malformed one is ignored rather than guessed at.
 */
function anthropicServerToolUse(u: unknown): HostedToolUse | null {
  if (!u || typeof u !== "object") return null;
  const s = (u as Record<string, unknown>).server_tool_use;
  if (!s || typeof s !== "object") return null;
  const n = (k: string) => {
    const v = (s as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  return { webSearch: n("web_search_requests"), webFetch: n("web_fetch_requests"), codeExecution: n("code_execution_requests") };
}

/**
 * Hosted-tool use in a Responses object. OpenAI reports no counts, so they are its
 * output items; xAI reports counts and its exact charge in `usage`. Null when the
 * response shows none, so a call without tools is unchanged.
 */
function responsesHostedTools(provider: ProviderId, response: unknown): HostedToolUse | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  if (provider === "openai") {
    if (!Array.isArray(r.output)) return null;
    let webSearch = 0;
    let fileSearch = 0;
    const containers: string[] = [];
    for (const item of r.output as Array<Record<string, unknown>>) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "web_search_call") webSearch += 1;
      else if (item.type === "file_search_call") fileSearch += 1;
      else if (item.type === "code_interpreter_call" && typeof item.container_id === "string") containers.push(item.container_id);
      else if (item.type === "shell_call") {
        const env = item.environment as Record<string, unknown> | null | undefined;
        if (env && typeof env === "object" && typeof env.container_id === "string") containers.push(env.container_id);
      }
    }
    // OpenAI's own count (live 2026-10-07), when present: items also include
    // `open_page` and `find_in_page` actions the pricing page does not bill.
    const toolUsage = r.tool_usage as Record<string, unknown> | undefined;
    const reported = (toolUsage?.web_search as Record<string, unknown> | undefined)?.num_requests;
    if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) webSearch = Math.floor(reported);
    if (webSearch + fileSearch + containers.length === 0) return null;
    return { webSearch, webFetch: 0, codeExecution: 0, fileSearch, containers };
  }
  if (provider === "xai") {
    const u = r.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== "object") return null;
    const d = (u.server_side_tool_usage_details ?? {}) as Record<string, unknown>;
    const n = (k: string) => {
      const v = d && typeof d === "object" ? d[k] : undefined;
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    };
    const reported = xaiTicksToMicrocents(u.cost_in_usd_ticks);
    const use: HostedToolUse = {
      webSearch: n("web_search_calls"),
      webFetch: 0,
      codeExecution: n("code_interpreter_calls"),
      fileSearch: n("file_search_calls") + n("document_search_calls"),
      xSearch: n("x_search_calls"),
      xPosts: n("x_posts_fetched"),
      xUsers: n("x_users_fetched"),
      ...(reported !== null ? { reportedMicrocents: reported } : {}),
    };
    const any = use.webSearch + use.codeExecution + (use.fileSearch ?? 0) + (use.xSearch ?? 0) + (use.xPosts ?? 0) + (use.xUsers ?? 0);
    return any > 0 ? use : null;
  }
  return null;
}

/** Anthropic `server_tool_use` block names that are a code execution. */
const ANTHROPIC_CODE_EXECUTION_BLOCKS = new Set(["code_execution", "bash_code_execution", "text_editor_code_execution"]);

function isCodeExecutionBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    (block as Record<string, unknown>).type === "server_tool_use" &&
    ANTHROPIC_CODE_EXECUTION_BLOCKS.has(String((block as Record<string, unknown>).name))
  );
}

/**
 * Anthropic's usage omits code executions (live 2026-10-07: `server_tool_use`
 * carried web counts only), so they are counted from the content blocks and the
 * larger of the two figures is kept.
 */
function withCodeExecutions(tools: HostedToolUse | null, blocks: number): HostedToolUse | null {
  if (blocks === 0) return tools;
  const base = tools ?? { webSearch: 0, webFetch: 0, codeExecution: 0 };
  return { ...base, codeExecution: Math.max(base.codeExecution, blocks) };
}

/**
 * Ollama's own usage, from a `done: true` object: `prompt_eval_count` input and
 * `eval_count` output. Ollama 0.40 reports the full prompt count even when it
 * reused its prompt cache (beside `prompt_eval_cached_count`, live 2026-10-07),
 * so complete means done with both counts. `done_reason: "load"` carries none.
 */
function ollamaUsage(obj: any): { input: number | null; output: number | null; saw: boolean; complete: boolean } {
  if (!obj || typeof obj !== "object" || obj.done !== true) return { input: null, output: null, saw: false, complete: false };
  const input = token(obj.prompt_eval_count);
  const output = token(obj.eval_count);
  return { input, output, saw: input !== null || output !== null, complete: input !== null && output !== null };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache. Billed at a discount. */
  cacheReadTokens: number;
  /** Prompt tokens written INTO the provider's cache. Billed at a premium. */
  cacheWriteTokens: number;
  /**
   * Hosted tools the provider ran inside the call, as it reported them. Present
   * only when a response reported some, so every call without one is unchanged.
   * Priced by lib/providers/hosted-tools.ts on top of the tokens above.
   */
  hostedTools?: HostedToolUse;
  /**
   * What the provider says the call cost, in µ¢, where it is the charge itself:
   * OpenRouter's `usage.cost` (plus the upstream bill on BYOK), the only figure that
   * knows which endpoint served the call. Present only for OpenRouter, and only when
   * readable; an OpenRouter report without it is not complete.
   */
  reportedMicrocents?: number;
  /**
   * Of `inputTokens`, how many the provider served from its prompt cache, where its
   * input count already includes them (`cached_tokens` on OpenAI's Chat Completions
   * and Responses). A SUBSET, read for the price alone (lib/pricing.ts, which
   * discounts it only where a row publishes a cached rate); never added to a token
   * count, so the token budget, the audit row and the receipt are unchanged by it.
   * Present only when above 0.
   */
  cachedInputTokens?: number;
  /**
   * Of `inputTokens`, how many OpenAI wrote to its prompt cache, from a Responses
   * report (`input_tokens_details.cache_write_tokens`), only when it fits inside the
   * uncached input. Present when stated, 0 included: 0 means "no writes", absent
   * means "unknown". Price only. Chat Completions' figure, which OpenAI calls
   * "unadjusted", is not read.
   */
  cacheWriteInputTokens?: number;
  /**
   * The service tier the RESPONSE reports the call ran on, from the same report as
   * the usage (a stream's earlier events echo the requested tier instead). Price
   * only: lib/pricing.ts settles GPT-6/5.6 at their context tier only on a standard one.
   */
  serviceTier?: string;
}

/**
 * A call that consumed nothing — the gateway refused, or the provider never
 * answered. Named rather than written as a literal at each site so adding a
 * future usage dimension cannot leave one of them quietly reporting undefined.
 */
// Frozen because it is shared BY REFERENCE across every refusal path in the
// proxy. Nothing mutates a Usage today, and this is what keeps that true: one
// `usage.cacheReadTokens += …` downstream would otherwise corrupt every other
// call site at once, and the symptom would read as cross-request contamination.
export const NO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/**
 * Provider usage is money-bound evidence. Accept only an integer that JavaScript
 * can preserve exactly; a negative, fractional, infinite, or unsafe value is
 * not a zero and must not make an otherwise ambiguous call look complete.
 */
const token = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

function optionalToken(obj: Record<string, unknown>, key: string): number | null {
  return obj[key] === undefined ? 0 : token(obj[key]);
}

/**
 * The cached part of a reported input: `details.cached_tokens`, from the SAME usage
 * report as `input`. 0 for anything absent, malformed, or larger than the input it
 * is a part of, so a doubtful count is charged at the full rate.
 */
function cachedSubset(details: unknown, input: number | null): number {
  if (input === null || typeof details !== "object" || details === null) return 0;
  const n = token((details as Record<string, unknown>).cached_tokens);
  return n !== null && n > 0 && n <= input ? n : 0;
}

const withCachedInput = (n: number): { cachedInputTokens?: number } => (n > 0 ? { cachedInputTokens: n } : {});

/**
 * A Responses report's cache writes, or null when absent, malformed, or more than
 * the input left after its cached part (`cached` from the same report).
 */
function cacheWriteSubset(details: unknown, input: number | null, cached: number): number | null {
  if (input === null || typeof details !== "object" || details === null) return null;
  const n = token((details as Record<string, unknown>).cache_write_tokens);
  return n !== null && n <= input - cached ? n : null;
}

/** A reported service tier: a short string, or null. */
function serviceTierOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 32 ? value : null;
}

const withTierAndWrites = (
  write: number | null,
  tier: string | null
): { cacheWriteInputTokens?: number; serviceTier?: string } => ({
  ...(write !== null ? { cacheWriteInputTokens: write } : {}),
  ...(tier !== null ? { serviceTier: tier } : {}),
});

/**
 * Input and output from a Responses usage object.
 *
 * OpenAI's `output_tokens` includes reasoning. xAI's may not: its REST reference
 * describes `output_tokens` as "Completion + reasoning tokens", but its own
 * example reports input 32, output 9, reasoning 110, total 151 — and
 * 32 + 9 + 110 = 151, so there reasoning sits OUTSIDE `output_tokens`. Reading
 * `output_tokens` alone would bill 9 tokens for 119 generated. So for xAI the
 * output is everything that is not input, `total_tokens − input_tokens`, which is
 * right under either reading (and never less than `output_tokens`). A report
 * missing any of the three, or whose total is below its input, yields no output
 * figure, so the call cannot read as complete.
 */
function responsesTokens(
  provider: ProviderId,
  u: any
): { input: number | null; output: number | null } {
  const input = token(u?.input_tokens);
  const output = token(u?.output_tokens);
  if (provider !== "xai") return { input, output };
  const total = token(u?.total_tokens);
  if (input === null || output === null || total === null || total < input) {
    return { input, output: null };
  }
  return { input, output: Math.max(output, total - input) };
}

/**
 * Input and output from a Chat Completions usage object.
 *
 * Gemini bills thinking tokens at the output rate, but its OpenAI-compatible
 * endpoint leaves them out of `completion_tokens`. Owner-run 2026-09-27,
 * `gemini-3.8-flash` with `reasoning_effort: "medium"`: prompt 13, completion
 * 127, total 304 — 164 billed tokens in neither field. So for Gemini the output
 * is everything that is not input, `total_tokens − prompt_tokens`, and never less
 * than `completion_tokens`. A total that is malformed or below the input yields
 * no output figure, so the call cannot read as complete; the reported
 * `completion_tokens` is still charged.
 */
function chatTokens(
  provider: ProviderId,
  u: any
): { input: number | null; output: number | null; reportedOutput: number | null } {
  const input = token(u?.prompt_tokens);
  const output = token(u?.completion_tokens);
  if (provider !== "gemini") return { input, output, reportedOutput: output };
  const total = token(u?.total_tokens);
  if (input === null || output === null || total === null || total < input) {
    return { input, output: null, reportedOutput: output };
  }
  const billed = Math.max(output, total - input);
  return { input, output: billed, reportedOutput: billed };
}

class Tally {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  /** Anthropic's hosted-tool counts, cumulative; the latest report wins. */
  hostedTools: HostedToolUse | null = null;
  /** Anthropic code-execution `server_tool_use` blocks seen in the stream. */
  codeExecutionBlocks = 0;
  /** OpenRouter's reported cost, µ¢, from the latest usage report that carried one. */
  reportedMicrocents: number | null = null;
  /** The cached part of `input`, re-read from every usage report (cachedSubset). */
  cachedInput = 0;
  /** Cache writes and service tier, re-read from every usage report like cachedInput. */
  cacheWriteInput: number | null = null;
  serviceTier: string | null = null;
  /**
   * Did a usage event actually ARRIVE — as opposed to the tally simply still
   * holding the zeros it was constructed with?
   *
   * Every field above starts at 0 and is only ever assigned from a parsed event,
   * so a count of zero is ambiguous in exactly the way that matters for money: a
   * call that genuinely consumed nothing and a call whose usage never reached us
   * produce identical numbers. The proxy has to charge those two differently —
   * one is a complete accounting, the other is uncertainty that must fail closed
   * — and it cannot tell them apart from a token count.
   *
   * Set in each of the three provider branches below, so it is exact rather than
   * inferred from how the stream ended. THAT DISTINCTION IS THE POINT: a stream
   * can close perfectly cleanly and still never report usage (an OpenAI-shaped
   * response whose client body lacked `stream: true`, so include_usage was never
   * injected), and that call is not a confirmed complete accounting.
   */
  sawUsage = false;
  /** Did the provider send the endpoint-specific terminal usage evidence? */
  complete = false;
  private openAiFinalUsage = false;
  private anthropicStarted = false;
  private anthropicDelta = false;

  feedLine(provider: ProviderId, line: string, protocol: UsageProtocol) {
    const trimmed = line.trim();
    if (protocol === "ollama") {
      // NDJSON: every line is one JSON object, no `data:` prefix. Counts arrive
      // on the `done: true` line only; an `{"error": …}` line ends the stream
      // without one, so the call stays incomplete.
      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      const u = ollamaUsage(obj);
      if (u.saw) this.sawUsage = true;
      if (u.input !== null) this.input = u.input;
      if (u.output !== null) this.output = u.output;
      if (u.complete) this.complete = true;
      return;
    }
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      // Chat Completions supplies the usage event before its SSE terminator.
      // A clean EOF after that event alone is still not proof the event was final.
      if (protocol === "provider" && usesOpenAiUsageShape(provider) && this.openAiFinalUsage) {
        this.complete = true;
      }
      return;
    }
    let obj: any;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (protocol === "responses") {
      // Responses streams carry the final tally inside the response object on
      // their terminal event. Read any response event that actually carries
      // usage so incomplete/failed terminal responses cannot become free if
      // OpenAI includes their partial tally too.
      const u = obj?.response?.usage;
      const { input, output } = responsesTokens(provider, u);
      // A partial xAI report still counts what it did say, so an incomplete
      // response bills its reported output rather than nothing.
      const reportedOutput = output ?? token(u?.output_tokens);
      if (u) this.sawUsage = true;
      if (input !== null) this.input = input;
      if (reportedOutput !== null) this.output = reportedOutput;
      // From this report, or 0: never an earlier event's count against a later input.
      if (u) {
        this.cachedInput = cachedSubset(u?.input_tokens_details, input);
        this.cacheWriteInput = cacheWriteSubset(u?.input_tokens_details, input, this.cachedInput);
        this.serviceTier = serviceTierOf(obj?.response?.service_tier);
      }
      // Terminal events carry the whole response, tool-call items included.
      const tools = responsesHostedTools(provider, obj?.response);
      if (tools) this.hostedTools = tools;
      if (input !== null && output !== null) {
        // Only response.completed with a completed response is authoritative.
        // Failed/incomplete events can carry a partial tally.
        if (obj?.type === "response.completed" && obj?.response?.status === "completed") {
          this.complete = true;
        }
      }
    } else if (usesOpenAiUsageShape(provider)) {
      // Usage arrives on the final chunk (choices: []) when include_usage is set.
      // No cache TOKENS are read here — prompt_tokens already includes them, so
      // adding any would count the same tokens twice. The cached subset is read
      // for the price only (cachedInputTokens).
      const u = obj?.usage;
      const { input, output, reportedOutput } = chatTokens(provider, u);
      if (u) this.sawUsage = true;
      if (input !== null) this.input = input;
      if (reportedOutput !== null) this.output = reportedOutput;
      if (u) {
        this.cachedInput = cachedSubset(u?.prompt_tokens_details, input);
        this.serviceTier = serviceTierOf(obj?.service_tier);
      }
      if (provider === "openrouter") {
        // OpenRouter sends usage, `cost` included, on the last data chunk before
        // [DONE] (openrouter.ai/docs/cookbook/administration/usage-accounting). Live
        // (2026-10-07) that chunk still carries its finished choice, `finish_reason:
        // "stop"`, rather than `choices: []`, so either is accepted, as for Gemini, and
        // every later chunk re-decides. A mid-stream failure is a chunk with a
        // top-level `error` and `finish_reason: "error"`, which is never final. A report
        // without a readable cost is not final either: the cost is the charge.
        const reported = u ? openrouterReportedMicrocents(u) : null;
        if (reported !== null) this.reportedMicrocents = reported;
        const choices = obj?.choices;
        this.openAiFinalUsage =
          obj?.error === undefined &&
          input !== null &&
          output !== null &&
          reported !== null &&
          Array.isArray(choices) &&
          (choices.length === 0 ||
            choices.every(
              (c: any) => typeof c?.finish_reason === "string" && c.finish_reason !== "" && c.finish_reason !== "error"
            ));
      } else if (provider === "gemini") {
        // Gemini does not send a `choices: []` usage chunk. Usage rides on the
        // content chunks, the last of which carries `finish_reason`, then [DONE]
        // (owner capture, 2026-09-27). So a report is final only on a chunk whose
        // every choice has finished, and only if it is the last data chunk before
        // [DONE]: every later chunk re-decides, so one without it clears the flag.
        const choices = obj?.choices;
        this.openAiFinalUsage =
          input !== null &&
          output !== null &&
          Array.isArray(choices) &&
          (choices.length === 0 ||
            choices.every((c: any) => typeof c?.finish_reason === "string" && c.finish_reason !== ""));
      } else if (input !== null && output !== null) {
        // Chat Completions' include_usage contract puts final usage on its
        // choices: [] event. Do not call a random usage-shaped chunk terminal.
        if (Array.isArray(obj?.choices) && obj.choices.length === 0) this.openAiFinalUsage = true;
      }
    } else {
      // Anthropic: input on message_start, output (cumulative) on message_delta.
      // The cache fields ride on message_start alongside input_tokens — reading
      // them only from the buffered JSON path would leave streaming, which is how
      // agents actually call, still under-counting.
      if (obj?.type === "message_start") {
        const u = obj?.message?.usage;
        const input = token(u?.input_tokens);
        const output = token(u?.output_tokens);
        const cacheRead = u && typeof u === "object"
          ? optionalToken(u as Record<string, unknown>, "cache_read_input_tokens")
          : null;
        const cacheWrite = u && typeof u === "object"
          ? optionalToken(u as Record<string, unknown>, "cache_creation_input_tokens")
          : null;
        if (u) this.sawUsage = true;
        if (input !== null) this.input = input;
        if (output !== null) this.output = output;
        if (cacheRead !== null) this.cacheRead = cacheRead;
        if (cacheWrite !== null) this.cacheWrite = cacheWrite;
        const tools = anthropicServerToolUse(u);
        if (tools) this.hostedTools = tools;
        // message_start only, NOT message_delta. message_start is where the
        // input tokens arrive, and Anthropic has already processed the whole
        // prompt by the time it sends one — so a break before it means real
        // input tokens were billed that this tally knows nothing about. A
        // message_delta cannot precede a message_start in the protocol, so
        // there is no ordering here that this misses.
        this.anthropicStarted =
          input !== null && output !== null && cacheRead !== null && cacheWrite !== null;
      } else if (obj?.type === "message_delta") {
        const u = obj?.usage;
        const output = token(u?.output_tokens);
        if (u) this.sawUsage = true;
        // With a hosted tool the input grows while the call runs (search and
        // fetch results become input), so the final delta carries totals
        // message_start could not know. Its counts are cumulative: keep the
        // larger, never lower one a delta reports smaller.
        if (u && typeof u === "object") {
          const record = u as Record<string, unknown>;
          const input = token(u?.input_tokens);
          const cacheRead = optionalToken(record, "cache_read_input_tokens");
          const cacheWrite = optionalToken(record, "cache_creation_input_tokens");
          if (input !== null && input > this.input) this.input = input;
          if (cacheRead !== null && cacheRead > this.cacheRead) this.cacheRead = cacheRead;
          if (cacheWrite !== null && cacheWrite > this.cacheWrite) this.cacheWrite = cacheWrite;
          const tools = anthropicServerToolUse(u);
          if (tools) this.hostedTools = tools;
        }
        if (output !== null) {
          this.output = output;
          this.anthropicDelta = true;
        }
      } else if (obj?.type === "content_block_start") {
        if (isCodeExecutionBlock(obj?.content_block)) this.codeExecutionBlocks += 1;
      } else if (obj?.type === "message_stop") {
        // message_stop is the terminal evidence that the preceding cumulative
        // delta is final. EOF alone is not an authoritative provider result.
        this.complete = this.anthropicStarted && this.anthropicDelta;
      }
    }
  }
}

/**
 * How the stream ended. Carried alongside the tally rather than inferred, because
 * the caller has to log a different status for each and cannot tell them apart
 * from a token count: a broken stream and a complete one both produce a number.
 *
 *   close  — the provider finished the answer.
 *   cancel — the client hung up mid-answer.
 *   error  — the provider's stream broke mid-answer (see the pull() catch below).
 */
export type StreamEnd = "close" | "cancel" | "error";

export interface StreamSettlement {
  usage: Usage;
  end: StreamEnd;
  /**
   * Whether a usage event actually arrived. See Tally.sawUsage.
   *
   * Carried ALONGSIDE `end` rather than folded into it, because the two answer
   * different questions and the proxy needs both: `end` says whether the client
   * got a whole answer, `sawUsage` says whether we know what it cost. Only a
   * cleanly-closed stream that also reported usage is a confirmed complete
   * accounting; every other combination is charged as uncertain.
   */
  sawUsage: boolean;
  /** Endpoint-specific terminal usage evidence arrived and was valid. */
  complete: boolean;
}

export interface UsageTransform {
  stream: TransformStream<Uint8Array, Uint8Array>;
  /** Resolves exactly once, on any ending. Never rejects — a broken stream is a
   *  settlement with `end: "error"`, not a rejection, so a caller awaiting it to
   *  reconcile the budget and write the audit row always gets to run. */
  settled: Promise<StreamSettlement>;
}

/**
 * Build a pass-through transform that reads usage and reports how it ended.
 *
 * SSE bodies are tallied line by line. An `embeddings` body is one JSON
 * document with no line structure worth splitting on — buffering "until the
 * next newline" would hold the whole thing — so it is read by a forward scanner
 * that keeps only the top-level `usage` value (lib/usage/topLevelUsage.ts).
 */
export function createUsageTransform(
  provider: ProviderId,
  protocol: UsageProtocol = "provider"
): UsageTransform {
  if (protocol === "embeddings") return createTopLevelUsageTransform(provider);

  const tally = new Tally();
  const decoder = new TextDecoder();
  let buffer = "";
  return settlingPassThrough(
    (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line) tally.feedLine(provider, line, protocol);
      }
    },
    (end) => {
      // The trailing buffer is fed here, not in flush(), because flush() is exactly
      // what does not run on the two abnormal endings. On a break it is a truncated
      // fragment, which feedLine drops on its JSON parse — harmless, and cheaper
      // than a second code path to decide whether to bother.
      if (buffer.trim()) tally.feedLine(provider, buffer, protocol);
      return {
        usage: {
          inputTokens: tally.input,
          outputTokens: tally.output,
          cacheReadTokens: tally.cacheRead,
          cacheWriteTokens: tally.cacheWrite,
          ...((): { hostedTools?: HostedToolUse } => {
            const tools = withCodeExecutions(tally.hostedTools, tally.codeExecutionBlocks);
            return tools ? { hostedTools: tools } : {};
          })(),
          ...(tally.reportedMicrocents !== null ? { reportedMicrocents: tally.reportedMicrocents } : {}),
          ...withCachedInput(tally.cachedInput),
          ...withTierAndWrites(tally.cacheWriteInput, tally.serviceTier),
        },
        end,
        sawUsage: tally.sawUsage,
        complete: tally.complete,
      };
    }
  );
}

/**
 * The embeddings reader: complete only when the document closed AND carried
 * exactly one usable top-level `usage`. Anything else is charged as uncertain.
 */
function createTopLevelUsageTransform(provider: ProviderId): UsageTransform {
  const scanner = new TopLevelUsageScanner();
  const decoder = new TextDecoder();
  return settlingPassThrough(
    (chunk) => scanner.feed(decoder.decode(chunk, { stream: true })),
    (end) => {
      scanner.feed(decoder.decode());
      const found = scanner.finish();
      const observed = usageFromJson(
        provider,
        found.usage === undefined ? {} : { usage: found.usage },
        "embeddings"
      );
      return {
        usage: {
          inputTokens: observed.inputTokens,
          outputTokens: observed.outputTokens,
          cacheReadTokens: observed.cacheReadTokens,
          cacheWriteTokens: observed.cacheWriteTokens,
        },
        end,
        sawUsage: found.usageCount > 0,
        complete: found.documentComplete && observed.complete,
      };
    }
  );
}

/**
 * Forward every chunk unchanged, feed it to `observe`, and settle exactly once
 * on whichever ending happens, with the settlement `conclude` builds.
 */
function settlingPassThrough(
  observe: (chunk: Uint8Array) => void,
  conclude: (end: StreamEnd) => StreamSettlement
): UsageTransform {
  let done = false;
  let resolveSettled!: (s: StreamSettlement) => void;
  const settled = new Promise<StreamSettlement>((r) => (resolveSettled = r));

  // First ending wins. A break can be followed by a late cancel from the same
  // consumer, and the break is the ending that describes what happened.
  const settle = (end: StreamEnd) => {
    if (done) return;
    done = true;
    resolveSettled(conclude(end));
  };

  const inner = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // forward unchanged FIRST (no added latency)
      observe(chunk);
    },
    flush() {
      settle("close");
    },
  });

  // TransformStream.flush() runs on exactly ONE of the three endings — a clean
  // close. It is not called when the downstream consumer cancels, and it is not
  // called when the source errors. Wrap the readable side so all three settle the
  // same promise exactly once, while preserving the stream's backpressure.
  const reader = inner.readable.getReader();
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: finished, value } = await reader.read();
        if (finished) {
          // flush() has normally already settled this as "close"; harmless if a
          // source closes without one.
          settle("close");
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        // The provider answered 200, streamed part of an answer, and then the
        // connection broke — Anthropic overloading mid-stream, a load-balancer
        // drop, a provider restart. Neither flush() nor cancel() fires here, so
        // before this catch existed the promise never settled at all: the
        // reconcile awaiting it never ran, so a call that really happened and
        // really cost tokens left NO audit row and NO receipt, and its budget
        // reservation sat held until the 960s marker TTL expired.
        settle("error");
        // Re-thrown so the ReadableStream errors with the original reason. The
        // client MUST see a broken stream: closing cleanly here would present a
        // truncated answer as a complete one.
        throw err;
      }
    },
    async cancel(reason) {
      settle("cancel");
      await reader.cancel(reason);
    },
  });
  const stream = { readable, writable: inner.writable } as TransformStream<
    Uint8Array,
    Uint8Array
  >;

  return { stream, settled };
}

/**
 * A tally plus whether the provider actually reported one.
 *
 * A superset of Usage, so every existing caller that wants only the numbers
 * keeps working unchanged.
 */
export interface ObservedUsage extends Usage {
  /** See Tally.sawUsage — zeros mean nothing without this. */
  sawUsage: boolean;
  /** Valid, authoritative completion evidence for a buffered inference response. */
  complete: boolean;
}

/**
 * Parse usage from a non-streaming JSON response body.
 *
 * Mirrors the three shapes the streaming tally handles, including the
 * `sawUsage` flag: a 200 whose body carries no `usage` object at all is not a
 * call that cost nothing, and the buffered path has exactly the same ambiguity
 * the streaming one does.
 */
export function usageFromJson(
  provider: ProviderId,
  body: any,
  protocol: UsageProtocol = "provider"
): ObservedUsage {
  if (protocol === "responses") {
    const { input, output } = responsesTokens(provider, body?.usage);
    const sawUsage = body?.usage != null;
    const hostedTools = responsesHostedTools(provider, body);
    return {
      inputTokens: input ?? 0,
      outputTokens: output ?? token(body?.usage?.output_tokens) ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...(hostedTools ? { hostedTools } : {}),
      ...withCachedInput(cachedSubset(body?.usage?.input_tokens_details, input)),
      ...(body?.usage != null
        ? withTierAndWrites(
            cacheWriteSubset(body.usage.input_tokens_details, input, cachedSubset(body.usage.input_tokens_details, input)),
            serviceTierOf(body?.service_tier)
          )
        : {}),
      sawUsage,
      complete: input !== null && output !== null && body?.status === "completed",
    };
  }
  if (protocol === "ollama") {
    const u = ollamaUsage(body);
    return {
      inputTokens: u.input ?? 0,
      outputTokens: u.output ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sawUsage: u.saw,
      complete: u.complete,
    };
  }
  if (protocol === "embeddings") {
    // Complete on `prompt_tokens` alone. A reported `completion_tokens` is still
    // charged (never less than reported); a malformed one leaves it incomplete.
    const input = token(body?.usage?.prompt_tokens);
    const reportedOutput = body?.usage && typeof body.usage === "object"
      ? optionalToken(body.usage as Record<string, unknown>, "completion_tokens")
      : null;
    return {
      inputTokens: input ?? 0,
      outputTokens: reportedOutput ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sawUsage: body?.usage != null,
      complete: input !== null && reportedOutput !== null,
    };
  }
  if (usesOpenAiUsageShape(provider)) {
    // `prompt_tokens` already includes any cached prompt tokens, so the cache
    // dimensions stay 0 here. See the Usage doc comment.
    const { input, output, reportedOutput } = chatTokens(provider, body?.usage);
    const sawUsage = body?.usage != null;
    if (provider === "openrouter") {
      // The cost is the charge, so a report without one is not complete; nor is a
      // 200 whose body is an `error` (OpenRouter's non-streaming failure shape).
      const reported = body?.usage != null ? openrouterReportedMicrocents(body.usage) : null;
      return {
        inputTokens: input ?? 0,
        outputTokens: reportedOutput ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...(reported !== null ? { reportedMicrocents: reported } : {}),
        sawUsage,
        complete: input !== null && output !== null && reported !== null && body?.error === undefined,
      };
    }
    return {
      inputTokens: input ?? 0,
      outputTokens: reportedOutput ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...withCachedInput(cachedSubset(body?.usage?.prompt_tokens_details, input)),
      ...(body?.usage != null ? withTierAndWrites(null, serviceTierOf(body?.service_tier)) : {}),
      sawUsage,
      complete: input !== null && output !== null,
    };
  }
  const input = token(body?.usage?.input_tokens);
  const output = token(body?.usage?.output_tokens);
  const cacheRead = body?.usage && typeof body.usage === "object"
    ? optionalToken(body.usage as Record<string, unknown>, "cache_read_input_tokens")
    : null;
  const cacheWrite = body?.usage && typeof body.usage === "object"
    ? optionalToken(body.usage as Record<string, unknown>, "cache_creation_input_tokens")
    : null;
  const sawUsage = body?.usage != null;
  const hostedTools = withCodeExecutions(
    anthropicServerToolUse(body?.usage),
    Array.isArray(body?.content) ? body.content.filter(isCodeExecutionBlock).length : 0
  );
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
    ...(hostedTools ? { hostedTools } : {}),
    sawUsage,
    complete: input !== null && output !== null && cacheRead !== null && cacheWrite !== null,
  };
}
