// Provider-specific usage tallying.
//
// S2: a SINGLE pass-through TransformStream forwards upstream bytes to the client
// unchanged while a buffered SSE line parser tallies tokens as a side effect.
// No tee() — so there is no second consumer to stall on backpressure/abort.
//
// S5: OpenAI only emits usage when stream_options.include_usage=true (injected
// by the proxy). Anthropic emits usage natively in message_start/message_delta.
import { usesOpenAiUsageShape, type ProviderId } from "../providers";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

class Tally {
  input = 0;
  output = 0;

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
      const u = obj?.usage;
      if (u) {
        if (typeof u.prompt_tokens === "number") this.input = u.prompt_tokens;
        if (typeof u.completion_tokens === "number") this.output = u.completion_tokens;
      }
    } else {
      // Anthropic: input on message_start, output (cumulative) on message_delta.
      if (obj?.type === "message_start") {
        const u = obj?.message?.usage;
        if (typeof u?.input_tokens === "number") this.input = u.input_tokens;
        if (typeof u?.output_tokens === "number") this.output = u.output_tokens;
      } else if (obj?.type === "message_delta") {
        const u = obj?.usage;
        if (typeof u?.output_tokens === "number") this.output = u.output_tokens;
      }
    }
  }
}

export interface UsageTransform {
  stream: TransformStream<Uint8Array, Uint8Array>;
  usage: Promise<Usage>;
}

/** Build a pass-through transform that tallies SSE usage and resolves on flush. */
export function createUsageTransform(provider: ProviderId): UsageTransform {
  const tally = new Tally();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled = false;
  let resolveUsage!: (u: Usage) => void;
  const usage = new Promise<Usage>((r) => (resolveUsage = r));

  const settleUsage = () => {
    if (settled) return;
    settled = true;
    if (buffer.trim()) tally.feedLine(provider, buffer);
    resolveUsage({ inputTokens: tally.input, outputTokens: tally.output });
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
      settleUsage();
    },
  });

  // TransformStream.flush() is not called when the downstream consumer cancels.
  // Wrap its readable side so both normal close and cancellation settle the same
  // usage promise exactly once while preserving the stream's backpressure.
  const reader = inner.readable.getReader();
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      settleUsage();
      await reader.cancel(reason);
    },
  });
  const stream = { readable, writable: inner.writable } as TransformStream<
    Uint8Array,
    Uint8Array
  >;

  return { stream, usage };
}

/** Parse usage from a non-streaming JSON response body. */
export function usageFromJson(provider: ProviderId, body: any): Usage {
  if (usesOpenAiUsageShape(provider)) {
    return {
      inputTokens: body?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.usage?.completion_tokens ?? 0,
    };
  }
  return {
    inputTokens: body?.usage?.input_tokens ?? 0,
    outputTokens: body?.usage?.output_tokens ?? 0,
  };
}
