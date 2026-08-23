import { describe, expect, it } from "vitest";
import { createUsageTransform, NO_USAGE } from "../lib/usage/parseStream";

/** Settle or fail — never hang. A regression here is a promise that never resolves. */
async function settleWithin<T>(promise: Promise<T>, ms = 50): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * A stream that delivers every chunk and THEN breaks — one chunk per pull, so
 * each is consumed before the failure.
 *
 * Enqueueing and erroring in the same `start()` would not model this: per the
 * Streams spec, erroring a controller resets its queue, so the chunks would never
 * reach the transform and the tally would be empty for a reason that has nothing
 * to do with the code under test. A real mid-answer break has already delivered
 * its bytes over the network.
 */
function breaksAfter(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next !== undefined) {
        controller.enqueue(enc(next));
        return;
      }
      controller.error(new Error("upstream connection reset"));
    },
  });
}

/** Drain a readable to completion, reporting how it ended rather than throwing. */
async function drain(readable: ReadableStream<Uint8Array>): Promise<"closed" | "errored"> {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return "closed";
    }
  } catch {
    return "errored";
  }
}

describe("stream usage settlement", () => {
  it("resolves parsed usage when the downstream reader cancels before close", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n'));
      },
    });
    const { stream, settled } = createUsageTransform("openai");
    const reader = source.pipeThrough(stream).getReader();

    await reader.read();
    await reader.cancel("client disconnected");

    expect(await settleWithin(settled)).toEqual({
      usage: { ...NO_USAGE, inputTokens: 12, outputTokens: 3 },
      end: "cancel",
    });
  });

  it("reports a normally closed stream as closed", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc('data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n'));
        controller.close();
      },
    });
    const { stream, settled } = createUsageTransform("openai");
    expect(await drain(source.pipeThrough(stream))).toBe("closed");

    expect(await settleWithin(settled)).toEqual({
      usage: { ...NO_USAGE, inputTokens: 7, outputTokens: 2 },
      end: "close",
    });
  });

  // The production scenario neither of the two cases above covers: the provider
  // accepted the call, answered 200, streamed part of an answer, and then the
  // connection broke (Anthropic overloaded mid-stream, an LB drop, a provider
  // restart). TransformStream.flush() does not run on an errored source and the
  // downstream consumer never cancels, so nothing settled the usage promise —
  // the reconcile awaiting it never ran, and the call left NO audit row at all.
  it("settles with the partial tally when the upstream stream breaks mid-answer", async () => {
    const source = breaksAfter([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":900,"output_tokens":1}}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
    ]);
    const { stream, settled } = createUsageTransform("anthropic");

    // The client sees a broken stream, which is the truth — a truncated answer
    // must never be closed cleanly as if it were complete.
    expect(await drain(source.pipeThrough(stream))).toBe("errored");

    expect(await settleWithin(settled)).toEqual({
      usage: { ...NO_USAGE, inputTokens: 900, outputTokens: 42 },
      end: "error",
    });
  });

  it("settles when the stream breaks before any usage was seen", async () => {
    const source = breaksAfter([]);
    const { stream, settled } = createUsageTransform("anthropic");

    expect(await drain(source.pipeThrough(stream))).toBe("errored");

    expect(await settleWithin(settled)).toEqual({
      usage: { ...NO_USAGE, inputTokens: 0, outputTokens: 0 },
      end: "error",
    });
  });

  it("keeps the first ending when a break is followed by a cancel", async () => {
    const source = breaksAfter(['data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n']);
    const { stream, settled } = createUsageTransform("openai");
    const readable = source.pipeThrough(stream);
    expect(await drain(readable)).toBe("errored");
    await readable.cancel("late").catch(() => {});

    expect(await settleWithin(settled)).toEqual({
      usage: { ...NO_USAGE, inputTokens: 5, outputTokens: 1 },
      end: "error",
    });
  });
});
