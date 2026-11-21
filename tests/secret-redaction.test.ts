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
import { LOCAL_NO_KEY } from "@/lib/providers";

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
    expect(secretsToRedact(KEY)).toContain(KEY);
    expect(secretsToRedact("abc/def+ghi/jkl-mnop")).toEqual(
      expect.arrayContaining(["abc/def+ghi/jkl-mnop", "abc\\/def+ghi\\/jkl-mnop"])
    );
    // Replacing a short string everywhere would corrupt ordinary output.
    expect(secretsToRedact("short")).toEqual([]);
    expect(secretsToRedact(null)).toEqual([]);
  });
});

// Cloud review 2026-11-03, A8: keys under 16 characters were never redacted, but the
// gateway stores keys of any length, and LiteLLM documents `sk-1234` as a master key.
// An upstream that echoed it handed it to the agent (invariant 4). The floor is now 6:
// still too short to scramble output on a 1–5 character value, never a real key.
describe("short stored keys (A8)", () => {
  it.each(["sk-1234", "abc123", "vllm-key-1"])("redacts %s", (key) => {
    expect(secretsToRedact(key)).toEqual([key]);
    const echoed = JSON.stringify({ error: `bad key: Bearer ${key}` });
    const out = redactSecretsInText(echoed, secretsToRedact(key));
    expect(out.redacted).toBe(true);
    expect(out.text).not.toContain(key);
  });

  it("leaves the keyless-local marker alone: it is not a secret and is never sent", () => {
    expect(secretsToRedact(LOCAL_NO_KEY)).toEqual([]);
  });

  it("redacts a short key split across stream chunks", async () => {
    const out = await pipe(["err: Bearer sk-1", "234 end"], secretsToRedact("sk-1234"));
    expect(out.join("")).toBe(`err: Bearer ${PROVIDER_KEY_REDACTION} end`);
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

// Credential-isolation benchmark, 2026-11-09 (~/agent-credential-bench). An upstream that
// echoed the key TRANSFORMED handed it to the agent: base64'd (alone, or inside Basic auth),
// hex, fully percent-encoded, reversed, cut in halves, or truncated. The exact-bytes
// redactor caught none of them. These keys use real provider shapes, not the benchmark's,
// because a public prefix like `sk-ant-api03-` must never be treated as secret text.
describe("transformed echoes", () => {
  const SECRET = "Zq7Lp2Wx9Rt4Yv6Bn1Mk8Hj3Gf5Dc0SaQe2We4Rt6Yu8Io0PaSd3Fg5Hj7Kl9Zx1Cv3Bn5Mm7Nq9Wr2Et4Yu6Ii8Oo0Pp2Aa4S";
  const ANT = `sk-ant-api03-${SECRET}`;
  const secrets = secretsToRedact(ANT);
  const clean = (text: string) => redactSecretsInText(text, secrets);
  const leaked = (out: string) => {
    const b64 = Buffer.from(ANT).toString("base64");
    // No 12-character run of the secret part survives, and no encoding of the whole key.
    for (let i = 0; i + 12 <= SECRET.length; i++) if (out.includes(SECRET.slice(i, i + 12))) return true;
    const pct = [...Buffer.from(ANT)].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
    const rev = [...ANT].reverse().join("");
    if (out.includes(rev)) return true;
    return [b64, Buffer.from(ANT).toString("hex"), pct].some((v) => out.toLowerCase().includes(v.toLowerCase()));
  };

  it.each([
    ["base64", (k: string) => Buffer.from(k).toString("base64")],
    ["base64url", (k: string) => Buffer.from(k).toString("base64url")],
    ["base64 inside Basic auth", (k: string) => `Basic ${Buffer.from(`user:${k}`).toString("base64")}`],
    ["base64 of a Bearer header", (k: string) => Buffer.from(`Authorization: Bearer ${k}`).toString("base64")],
    ["base64 at offset 1", (k: string) => Buffer.from(`a${k}`).toString("base64")],
    ["base64 at offset 2", (k: string) => Buffer.from(`ab${k}`).toString("base64")],
    ["hex", (k: string) => Buffer.from(k).toString("hex")],
    ["HEX", (k: string) => Buffer.from(k).toString("hex").toUpperCase()],
    ["percent-encoded", (k: string) => [...Buffer.from(k)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")],
    ["reversed", (k: string) => [...k].reverse().join("")],
    ["two halves around other text", (k: string) => `${k.slice(0, 50)} and then ${k.slice(50)}`],
    ["the first 40 characters", (k: string) => k.slice(0, 40)],
    ["a 12-character run from the middle", (k: string) => k.slice(60, 72)],
  ])("removes the key echoed as %s", (_name, transform) => {
    const echo = transform(ANT);
    const body = JSON.stringify({ error: { message: `upstream saw: ${echo} (end)` } });
    const out = clean(body);
    expect(out.redacted).toBe(true);
    expect(leaked(out.text)).toBe(false);
    // Independent of how the redactor finds it: the middle half of the echo is gone.
    expect(out.text).not.toContain(echo.slice(Math.floor(echo.length / 4), Math.floor((echo.length * 3) / 4)));
    expect(() => JSON.parse(out.text)).not.toThrow();
    expect(out.text).toContain("(end)");
  });

  it("leaves a mention of the public prefix alone", () => {
    const text = "Anthropic keys look like sk-ant-api03-... and OpenAI ones like sk-proj-...";
    expect(clean(text)).toEqual({ text, redacted: false });
  });

  it("leaves ordinary text, and runs of the secret shorter than 12 characters, alone", () => {
    const text = `The answer is 42. ${SECRET.slice(0, 11)} is too short to tell apart from noise.`;
    expect(clean(text)).toEqual({ text, redacted: false });
  });

  it("covers a 40-character run as one replacement, not a chopped residue", () => {
    const out = clean(`x ${SECRET.slice(5, 45)} y`).text;
    expect(out).toBe(`x ${PROVIDER_KEY_REDACTION} y`);
  });

  it("keeps short keys exact-only: no fragments or encodings below 16 characters", () => {
    expect(secretsToRedact("sk-1234")).toEqual(["sk-1234"]);
    expect(secretsToRedact("vllm-key-1")).toEqual(["vllm-key-1"]);
  });

  it("removes a 12+ character run inside one SSE event", async () => {
    const event = `data: ${JSON.stringify({ delta: { text: SECRET.slice(10, 30) } })}\n\n`;
    const joined = (await pipe([event], secrets)).join("");
    expect(joined).not.toContain(SECRET.slice(10, 22));
    expect(joined).toContain(PROVIDER_KEY_REDACTION);
  });

  it("does not release the tail of a run that ended a chunk", async () => {
    // The run is caught in chunk one; its last 11 characters, alone too short to match,
    // must not slip out in chunk two.
    const joined = (await pipe([`a ${SECRET.slice(0, 20)}`, "\n\n"], secrets)).join("");
    for (let i = 0; i + 4 <= 20; i++) expect(joined).not.toContain(SECRET.slice(i, i + 4));
    expect(joined).toBe(`a ${PROVIDER_KEY_REDACTION}\n\n`);
  });

  it("redacts a run held at the very end of the stream", async () => {
    const joined = (await pipe([`ends ${SECRET.slice(0, 20)}`], secrets)).join("");
    expect(joined).toBe(`ends ${PROVIDER_KEY_REDACTION}`);
  });

  it("still does not hold back ordinary SSE events", async () => {
    const events = ['data: {"delta":"Hel"}\n\n', 'data: {"delta":"lo"}\n\n', "data: [DONE]\n\n"];
    expect(await pipe(events, secrets)).toEqual(events);
  });

  // ~100 needles for a real-length key now, not one: a big buffered answer and a long
  // stream must still pass quickly.
  it("redacts a 2 MB body and a 2 MB stream quickly", async () => {
    const filler = "The quick brown fox jumps over the lazy dog. ".repeat(46_000);
    const body = `${filler}${ANT}${filler}`;
    let started = performance.now();
    const out = clean(body);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(out.text).not.toContain(SECRET.slice(0, 12));
    const chunks = (body.match(/[\s\S]{1,512}/g) ?? []).map((c) => `data: ${JSON.stringify({ d: c })}\n\n`);
    started = performance.now();
    const joined = (await pipe(chunks, secrets)).join("");
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(joined).toContain(PROVIDER_KEY_REDACTION);
  });

  // WAS THE DOCUMENTED LIMIT, pinned here as "does NOT catch" until 2026-11-10. A key
  // streamed a few characters per event never forms a 12-character byte run: only
  // something that joins the deltas (as the agent's SDK does) can see it. The stream now
  // does that for text inside a `delta`. tests/secret-redaction-sse.test.ts has the rest.
  it("catches a key split across SSE events in pieces under 12 characters", async () => {
    const pieces = ANT.match(/.{1,7}/g) ?? [];
    const events = pieces.map((p) => `data: ${JSON.stringify({ delta: { text: p } })}\n\n`);
    const out = (await pipe(events, secrets)).join("");
    const joined = out
      .split("\n\n")
      .filter(Boolean)
      .map((e) => JSON.parse(e.slice("data: ".length)).delta.text)
      .join("");
    expect(joined).toBe(PROVIDER_KEY_REDACTION);
    expect(leaked(out)).toBe(false);
    // One event out for each event in: the pieces are emptied, not dropped.
    expect(out.split("\n\n").filter(Boolean)).toHaveLength(events.length);
  });
});
