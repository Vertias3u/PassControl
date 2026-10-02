// Package 2, step 2+3: an embeddings response is forwarded as a stream, and its
// usage is read by a forward scanner rather than by parsing the whole body.
//
// Why a scanner: a batch embeddings response is tens of megabytes (2048 inputs ×
// a 3072-dim vector), and the buffered JSON path holds it, re-serialises it and
// redacts it as one string. The scanner keeps only the top-level `usage` value.
import { describe, expect, it } from "vitest";
import { createUsageTransform } from "@/lib/usage/parseStream";
import { TopLevelUsageScanner } from "@/lib/usage/topLevelUsage";

function scan(...chunks: string[]) {
  const scanner = new TopLevelUsageScanner();
  for (const chunk of chunks) scanner.feed(chunk);
  return scanner.finish();
}

const vector = (n: number) => Array.from({ length: n }, (_, i) => (i % 7) / 10 - 0.3);

const OPENAI_BODY = JSON.stringify({
  object: "list",
  data: [
    { object: "embedding", index: 0, embedding: vector(8) },
    { object: "embedding", index: 1, embedding: "AAAAAAAAgD8AAABA" },
  ],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 12, total_tokens: 12 },
});

describe("TopLevelUsageScanner", () => {
  it("reads the top-level usage object from an OpenAI embeddings body", () => {
    expect(scan(OPENAI_BODY)).toEqual({
      usage: { prompt_tokens: 12, total_tokens: 12 },
      usageCount: 1,
      documentComplete: true,
    });
  });

  it("gives the same answer at every chunk boundary, including inside escapes and multibyte text", () => {
    const body =
      '{"model":"m\\"odel \\u00e9 \\\\","data":[{"embedding":[0.1,-2e-3],"note":"}{,:\\"usage\\":"}],' +
      '"usage" : { "prompt_tokens" : 7 , "total_tokens" : 7 } }';
    const whole = scan(body);
    expect(whole.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 });
    expect(whole.documentComplete).toBe(true);
    for (let at = 0; at <= body.length; at++) {
      expect(scan(body.slice(0, at), body.slice(at))).toEqual(whole);
    }
    // And one character at a time.
    expect(scan(...body.split(""))).toEqual(whole);
  });

  it("finds usage wherever the provider puts it among the top-level keys", () => {
    expect(scan('{"usage":{"prompt_tokens":3},"data":[]}').usage).toEqual({ prompt_tokens: 3 });
    expect(scan('{"data":[],"usage":{"prompt_tokens":4},"model":"x"}').usage).toEqual({ prompt_tokens: 4 });
  });

  it("ignores a usage key nested below the top level", () => {
    const result = scan('{"data":[{"usage":{"prompt_tokens":1}}],"meta":{"usage":{"prompt_tokens":2}}}');
    expect(result.usageCount).toBe(0);
    expect(result.usage).toBeUndefined();
    expect(result.documentComplete).toBe(true);
  });

  it("ignores the word usage when it is a value, not a key", () => {
    const result = scan('{"model":"usage","object":"usage"}');
    expect(result.usageCount).toBe(0);
  });

  it("decodes escaped keys the way JSON.parse does", () => {
    const body = '{"us\\u0061ge":{"prompt_tokens":9}}';
    expect(JSON.parse(body).usage).toEqual({ prompt_tokens: 9 });
    expect(scan(body).usage).toEqual({ prompt_tokens: 9 });
  });

  it("reports a duplicated top-level usage as ambiguous rather than picking one", () => {
    const result = scan('{"usage":{"prompt_tokens":1},"usage":{"prompt_tokens":900}}');
    expect(result.usageCount).toBe(2);
    expect(result.usage).toBeUndefined();
  });

  it("does not call a truncated or unclosed document complete", () => {
    const cut = OPENAI_BODY.slice(0, OPENAI_BODY.length - 1);
    expect(scan(cut).documentComplete).toBe(false);
    expect(scan('{"usage":{"prompt_tokens":5}').documentComplete).toBe(false);
    // Cut inside the usage value itself: no usable value either.
    const midUsage = scan('{"data":[],"usage":{"prompt_tok');
    expect(midUsage.documentComplete).toBe(false);
    expect(midUsage.usage).toBeUndefined();
  });

  it("does not call a top-level array, a scalar, or trailing bytes a complete document", () => {
    expect(scan('[{"usage":{"prompt_tokens":1}}]').documentComplete).toBe(false);
    expect(scan('"usage"').documentComplete).toBe(false);
    expect(scan('{"usage":{"prompt_tokens":1}} {"x":1}').documentComplete).toBe(false);
    expect(scan("").documentComplete).toBe(false);
  });

  it("allows surrounding whitespace", () => {
    expect(scan('\n  {"usage":{"prompt_tokens":1}}\n').documentComplete).toBe(true);
  });

  it("refuses a usage value larger than its bound instead of holding it", () => {
    const huge = `{"usage":{"prompt_tokens":1,"pad":"${"x".repeat(64 * 1024)}"}}`;
    const result = scan(huge);
    expect(result.usageCount).toBe(1);
    expect(result.usage).toBeUndefined();
    expect(result.documentComplete).toBe(true);
  });

  it("reports an unparseable usage value as present but unusable", () => {
    const result = scan('{"usage":{"prompt_tokens":1,}}');
    expect(result.usageCount).toBe(1);
    expect(result.usage).toBeUndefined();
  });

  it("scans a 30 MB body without keeping it", () => {
    const row = `{"object":"embedding","index":0,"embedding":"${"A".repeat(16_384)}"},`;
    const rows = row.repeat(1_900);
    const scanner = new TopLevelUsageScanner();
    const started = performance.now();
    scanner.feed('{"object":"list","data":[');
    scanner.feed(rows);
    scanner.feed('{"object":"embedding","index":1,"embedding":[0.5]}],"usage":{"prompt_tokens":8192,"total_tokens":8192}}');
    const result = scanner.finish();
    const elapsed = performance.now() - started;
    expect(result.usage).toEqual({ prompt_tokens: 8192, total_tokens: 8192 });
    expect(result.documentComplete).toBe(true);
    expect(scanner.retainedChars()).toBeLessThan(1024);
    // Generous: this guards against an accidental quadratic path, not a benchmark.
    expect(elapsed).toBeLessThan(5_000);
  });
});

async function pump(
  transform: TransformStream<Uint8Array, Uint8Array>,
  chunks: Uint8Array[]
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const out = await new Response(source.pipeThrough(transform)).arrayBuffer();
  return new Uint8Array(out);
}

describe("createUsageTransform, embeddings protocol", () => {
  it("forwards the body byte-for-byte and settles complete from its top-level usage", async () => {
    const bytes = new TextEncoder().encode(OPENAI_BODY);
    const chunks = [bytes.subarray(0, 17), bytes.subarray(17, 400), bytes.subarray(400)];
    const { stream, settled } = createUsageTransform("openai", "embeddings");
    const forwarded = await pump(stream, chunks);
    expect(forwarded).toEqual(bytes);
    await expect(settled).resolves.toEqual({
      usage: { inputTokens: 12, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      end: "close",
      sawUsage: true,
      complete: true,
    });
  });

  it("decodes a multibyte character split across chunks", async () => {
    const body = '{"model":"é€𝄞","usage":{"prompt_tokens":2}}';
    const bytes = new TextEncoder().encode(body);
    const { stream, settled } = createUsageTransform("openai", "embeddings");
    const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
    expect(await pump(stream, chunks)).toEqual(bytes);
    expect((await settled).complete).toBe(true);
  });

  it("is incomplete, with no usage, when the body carries none", async () => {
    const { stream, settled } = createUsageTransform("openai", "embeddings");
    await pump(stream, [new TextEncoder().encode('{"object":"list","data":[]}')]);
    expect(await settled).toMatchObject({ sawUsage: false, complete: false });
  });

  it("is incomplete when the body is cut off, even after usage was seen", async () => {
    const { stream, settled } = createUsageTransform("openai", "embeddings");
    await pump(stream, [new TextEncoder().encode('{"usage":{"prompt_tokens":4},"data":[')]);
    const result = await settled;
    expect(result.complete).toBe(false);
    expect(result.usage.inputTokens).toBe(4);
  });

  it("settles as an error when the provider's body breaks mid-flight", async () => {
    const { stream, settled } = createUsageTransform("openai", "embeddings");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['));
        controller.error(new Error("connection reset"));
      },
    });
    await expect(new Response(source.pipeThrough(stream)).text()).rejects.toThrow();
    expect(await settled).toMatchObject({ end: "error", complete: false });
  });
});
