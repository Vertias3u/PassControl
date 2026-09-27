// C3 (S-02) — the redaction primitive the proxy puts on every upstream body.
// The streaming half is the hard part: a provider key echoed in an SSE stream
// can arrive split across any number of chunks, and the filter must neither
// let the pieces through nor hold back ordinary output waiting for a match.
import { describe, expect, it } from "vitest";
import {
  PROVIDER_KEY_REDACTION,
  redactSecretsInText,
  redactingStream,
  secretsToRedact,
} from "@/lib/providers/secret-redaction";

const KEY = "sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z-ECHO_TEST";
const enc = new TextEncoder();
const dec = new TextDecoder();

async function pipe(chunks: string[] | Uint8Array[], secrets = secretsToRedact(KEY)) {
  const t = redactingStream(secrets);
  const writer = t.writable.getWriter();
  const reader = t.readable.getReader();
  const out: string[] = [];
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(dec.decode(value, { stream: true }));
    }
  })();
  for (const c of chunks) await writer.write(typeof c === "string" ? enc.encode(c) : c);
  await writer.close();
  await reading;
  return out;
}

describe("secretsToRedact", () => {
  it("covers the key and its JSON-escaped spelling, and ignores values too short to be a key", () => {
    expect(secretsToRedact(KEY)).toEqual([KEY]);
    expect(secretsToRedact("abc/def+ghi/jkl-mnop")).toEqual(["abc/def+ghi/jkl-mnop", "abc\\/def+ghi\\/jkl-mnop"]);
    // Replacing a short string everywhere would corrupt ordinary output.
    expect(secretsToRedact("short")).toEqual([]);
    expect(secretsToRedact(null)).toEqual([]);
  });
});

describe("redactSecretsInText", () => {
  it("replaces every occurrence and leaves everything else byte-identical", () => {
    const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Header was Bearer ${KEY}` } });
    const out = redactSecretsInText(body, secretsToRedact(KEY));
    expect(out.redacted).toBe(true);
    expect(out.text).not.toContain(KEY);
    expect(out.text.split(PROVIDER_KEY_REDACTION)).toHaveLength(3);
    expect(() => JSON.parse(out.text)).not.toThrow();
    expect(redactSecretsInText("nothing here", secretsToRedact(KEY))).toEqual({ text: "nothing here", redacted: false });
  });
});

describe("redactingStream", () => {
  it("removes a key split across two chunks at every possible position", async () => {
    const text = `data: {"echo":"${KEY}"}\n\n`;
    for (let cut = 1; cut < text.length; cut++) {
      const joined = (await pipe([text.slice(0, cut), text.slice(cut)])).join("");
      expect(joined, `cut at ${cut}`).not.toContain(KEY);
      expect(joined).toBe(`data: {"echo":"${PROVIDER_KEY_REDACTION}"}\n\n`);
    }
  });

  it("removes a key delivered one byte per chunk", async () => {
    const text = `before ${KEY} after`;
    const joined = (await pipe(text.split(""))).join("");
    expect(joined).toBe(`before ${PROVIDER_KEY_REDACTION} after`);
  });

  it("does not hold back an ordinary SSE event waiting for a match", async () => {
    // Each chunk ends in "\n\n", which cannot start the key, so each must be
    // emitted whole, immediately — a streaming client sees no added delay.
    const events = ['data: {"delta":"Hel"}\n\n', 'data: {"delta":"lo"}\n\n', "data: [DONE]\n\n"];
    const out = await pipe(events);
    expect(out).toEqual(events);
  });

  it("releases a held tail that turned out not to be the key", async () => {
    const out = await pipe(["token: sk-pr", "oj is not it\n\n"]);
    expect(out.join("")).toBe("token: sk-proj is not it\n\n");
    // "sk-pr" could have begun the key, so it waited — and only it.
    expect(out[0]).toBe("token: ");
  });

  it("flushes a held prefix when the stream ends mid-candidate", async () => {
    expect((await pipe(["ends with sk-proj-Ab"])).join("")).toBe("ends with sk-proj-Ab");
  });

  it("keeps multi-byte text intact around a redaction", async () => {
    const text = `ключ ${KEY} 🔑 done`;
    const bytes = enc.encode(text);
    const chunks = [bytes.slice(0, 3), bytes.slice(3, 20), bytes.slice(20)];
    expect((await pipe(chunks)).join("")).toBe(`ключ ${PROVIDER_KEY_REDACTION} 🔑 done`);
  });

  it("passes bytes through untouched when there is nothing to redact", async () => {
    const out = await pipe(["a", "b"], []);
    expect(out.join("")).toBe("ab");
  });

  it("reports that it redacted, once", async () => {
    let calls = 0;
    const t = redactingStream(secretsToRedact(KEY), () => calls++);
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const drain = (async () => { for (;;) { if ((await r.read()).done) break; } })();
    await w.write(enc.encode(`${KEY} and ${KEY}`));
    await w.close();
    await drain;
    expect(calls).toBe(1);
  });
});
