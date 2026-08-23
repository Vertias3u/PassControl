// Provider-specific usage tallying.
//
// S2: a SINGLE pass-through TransformStream forwards upstream bytes to the client
// unchanged while a buffered SSE line parser tallies tokens as a side effect.
// No tee() — so there is no second consumer to stall on backpressure/abort.
//
// S5: OpenAI only emits usage when stream_options.include_usage=true (injected
// by the proxy). Anthropic emits usage natively in message_start/message_delta.
import { usesOpenAiUsageShape, type ProviderId } from "../providers";

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

/** A usage number the provider actually reported, or 0. Never coerces. */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

class Tally {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;

  feedLine(provider: ProviderId, line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let obj: any;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (usesOpenAiUsageShape(provider)) {
      // Usage arrives on the final chunk (choices: []) when include_usage is set.
      // No cache fields read here on purpose — prompt_tokens already includes
      // them, so anything added would be the same tokens counted twice.
      const u = obj?.usage;
      if (u) {
        if (typeof u.prompt_tokens === "number") this.input = u.prompt_tokens;
        if (typeof u.completion_tokens === "number") this.output = u.completion_tokens;
      }
    } else {
      // Anthropic: input on message_start, output (cumulative) on message_delta.
      // The cache fields ride on message_start alongside input_tokens — reading
      // them only from the buffered JSON path would leave streaming, which is how
      // agents actually call, still under-counting.
      if (obj?.type === "message_start") {
        const u = obj?.message?.usage;
        if (typeof u?.input_tokens === "number") this.input = u.input_tokens;
        if (typeof u?.output_tokens === "number") this.output = u.output_tokens;
        this.cacheRead = num(u?.cache_read_input_tokens);
        this.cacheWrite = num(u?.cache_creation_input_tokens);
      } else if (obj?.type === "message_delta") {
        const u = obj?.usage;
        if (typeof u?.output_tokens === "number") this.output = u.output_tokens;
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
}

export interface UsageTransform {
  stream: TransformStream<Uint8Array, Uint8Array>;
  /** Resolves exactly once, on any ending. Never rejects — a broken stream is a
   *  settlement with `end: "error"`, not a rejection, so a caller awaiting it to
   *  reconcile the budget and write the audit row always gets to run. */
  settled: Promise<StreamSettlement>;
}

/** Build a pass-through transform that tallies SSE usage and reports how it ended. */
export function createUsageTransform(provider: ProviderId): UsageTransform {
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
    if (buffer.trim()) tally.feedLine(provider, buffer);
    resolveSettled({
      usage: {
        inputTokens: tally.input,
        outputTokens: tally.output,
        cacheReadTokens: tally.cacheRead,
        cacheWriteTokens: tally.cacheWrite,
      },
      end,
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
        if (line) tally.feedLine(provider, line);
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

/** Parse usage from a non-streaming JSON response body. */
export function usageFromJson(provider: ProviderId, body: any): Usage {
  if (usesOpenAiUsageShape(provider)) {
    // `prompt_tokens` already includes any cached prompt tokens, so the cache
    // dimensions stay 0 here. See the Usage doc comment.
    return {
      inputTokens: body?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
  return {
    inputTokens: body?.usage?.input_tokens ?? 0,
    outputTokens: body?.usage?.output_tokens ?? 0,
    cacheReadTokens: num(body?.usage?.cache_read_input_tokens),
    cacheWriteTokens: num(body?.usage?.cache_creation_input_tokens),
  };
}
