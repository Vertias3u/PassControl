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

export type UsageProtocol = "provider" | "responses";

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
 * figure as well would charge the same tokens twice.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache. Billed at a discount. */
  cacheReadTokens: number;
  /** Prompt tokens written INTO the provider's cache. Billed at a premium. */
  cacheWriteTokens: number;
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

class Tally {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
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
      const input = token(u?.input_tokens);
      const output = token(u?.output_tokens);
      if (u) this.sawUsage = true;
      if (input !== null) this.input = input;
      if (output !== null) this.output = output;
      if (input !== null && output !== null) {
        // Only response.completed with a completed response is authoritative.
        // Failed/incomplete events can carry a partial tally.
        if (obj?.type === "response.completed" && obj?.response?.status === "completed") {
          this.complete = true;
        }
      }
    } else if (usesOpenAiUsageShape(provider)) {
      // Usage arrives on the final chunk (choices: []) when include_usage is set.
      // No cache fields read here on purpose — prompt_tokens already includes
      // them, so anything added would be the same tokens counted twice.
      const u = obj?.usage;
      const input = token(u?.prompt_tokens);
      const output = token(u?.completion_tokens);
      if (u) this.sawUsage = true;
      if (input !== null) this.input = input;
      if (output !== null) this.output = output;
      if (input !== null && output !== null) {
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
        if (output !== null) {
          this.output = output;
          this.anthropicDelta = true;
        }
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

/** Build a pass-through transform that tallies SSE usage and reports how it ended. */
export function createUsageTransform(
  provider: ProviderId,
  protocol: UsageProtocol = "provider"
): UsageTransform {
  const tally = new Tally();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  let resolveSettled!: (s: StreamSettlement) => void;
  const settled = new Promise<StreamSettlement>((r) => (resolveSettled = r));

  // First ending wins. A break can be followed by a late cancel from the same
  // consumer, and the break is the ending that describes what happened.
  const settle = (end: StreamEnd) => {
    if (done) return;
    done = true;
    // The trailing buffer is fed here, not in flush(), because flush() is exactly
    // what does not run on the two abnormal endings. On a break it is a truncated
    // fragment, which feedLine drops on its JSON parse — harmless, and cheaper
    // than a second code path to decide whether to bother.
    if (buffer.trim()) tally.feedLine(provider, buffer, protocol);
    resolveSettled({
      usage: {
        inputTokens: tally.input,
        outputTokens: tally.output,
        cacheReadTokens: tally.cacheRead,
        cacheWriteTokens: tally.cacheWrite,
      },
      end,
      sawUsage: tally.sawUsage,
      complete: tally.complete,
    });
  };

  const inner = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // forward unchanged FIRST (no added latency)
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line) tally.feedLine(provider, line, protocol);
      }
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
    const input = token(body?.usage?.input_tokens);
    const output = token(body?.usage?.output_tokens);
    const sawUsage = body?.usage != null;
    return {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sawUsage,
      complete: input !== null && output !== null && body?.status === "completed",
    };
  }
  if (usesOpenAiUsageShape(provider)) {
    // `prompt_tokens` already includes any cached prompt tokens, so the cache
    // dimensions stay 0 here. See the Usage doc comment.
    const input = token(body?.usage?.prompt_tokens);
    const output = token(body?.usage?.completion_tokens);
    const sawUsage = body?.usage != null;
    return {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
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
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
    sawUsage,
    complete: input !== null && output !== null && cacheRead !== null && cacheWrite !== null,
  };
}
