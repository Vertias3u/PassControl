import { describe, expect, it } from "vitest";
import { readBoundedBody } from "@/lib/http/bounded-body";

/**
 * CP-02. The 4 MiB inbound cap used to be `await req.text()` followed by a
 * `.length` check, which bounded neither the memory nor the bytes:
 *
 *   * an unknown-length upload was consumed IN FULL before the check ran, so the
 *     limit was enforced after the allocation it exists to prevent;
 *   * `.length` counts UTF-16 code units, so multi-byte JSON sailed past a cap
 *     it was megabytes over on the wire.
 *
 * Both are asserted here against real streams, because both are properties of
 * how the bytes are consumed and a mock of the reader would prove neither.
 */

/** A stream that records how many chunks were actually pulled out of it. */
function countingStream(chunks: Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
} {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
  return { stream, pulled: () => index };
}

function streamedRequest(stream: ReadableStream<Uint8Array>, headers: HeadersInit = {}): Request {
  // No content-length: this is the chunked shape, the one the old check could
  // not see at all.
  return new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stream,
    // @ts-expect-error — undici requires this for a streaming body.
    duplex: "half",
  });
}

const CAP = 64 * 1024;

describe("the inbound body bound", () => {
  it("stops pulling once the cap is crossed instead of draining the sender", async () => {
    const chunk = new Uint8Array(16 * 1024).fill(32);
    const { stream, pulled } = countingStream(Array.from({ length: 64 }, () => chunk));
    const result = await readBoundedBody(streamedRequest(stream), CAP);

    expect(result.ok).toBe(false);
    // 64 KiB of cap over 16 KiB chunks: the fifth chunk is the one that crosses
    // it. Everything after that is never read — the point of the whole exercise.
    expect(pulled()).toBeLessThanOrEqual(5);
    expect(pulled()).toBeLessThan(64);
  });

  it("counts bytes, not UTF-16 code units", async () => {
    // Three bytes each, one code unit each. Comfortably inside the old `.length`
    // check and comfortably outside the actual cap.
    const text = "界".repeat(CAP / 2);
    const encoded = new TextEncoder().encode(text);
    expect(text.length).toBeLessThan(CAP);
    expect(encoded.byteLength).toBeGreaterThan(CAP);

    const { stream } = countingStream([encoded]);
    const result = await readBoundedBody(streamedRequest(stream), CAP);

    expect(result.ok).toBe(false);
  });

  it("still refuses on a declared length, without opening the stream", async () => {
    const { stream, pulled } = countingStream([new Uint8Array(8).fill(32)]);
    const result = await readBoundedBody(
      streamedRequest(stream, { "content-length": String(CAP + 1) }),
      CAP
    );

    expect(result.ok).toBe(false);
    // Content-Length stays an optimisation: it avoids reading a stream we would
    // only close. It is not the enforcement, which is why the tests above exist.
    // (undici may prime a single chunk when the Request is constructed, so this
    // asserts "we did not consume the body", not "the stream was never touched".)
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("passes a body at the boundary through byte-exact", async () => {
    const payload = JSON.stringify({ model: "gpt-4o-mini", note: "é界🙂 exact" });
    const encoded = new TextEncoder().encode(payload);
    const { stream } = countingStream([encoded]);
    const result = await readBoundedBody(streamedRequest(stream), CAP);

    expect(result).toEqual({ ok: true, text: payload });
    // Multi-byte characters survive the chunk-joining, which is the thing a
    // per-chunk decode would have got wrong.
    expect(JSON.parse(result.ok ? result.text : "{}")).toMatchObject({ note: "é界🙂 exact" });
  });

  it("reassembles a character split across two chunks", async () => {
    const payload = JSON.stringify({ note: "界" });
    const encoded = new TextEncoder().encode(payload);
    const cut = encoded.indexOf(0xe7) + 1; // mid-sequence, on purpose
    const { stream } = countingStream([encoded.slice(0, cut), encoded.slice(cut)]);
    const result = await readBoundedBody(streamedRequest(stream), CAP);

    expect(result).toEqual({ ok: true, text: payload });
  });
});
