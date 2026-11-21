// The joined-text half of the response redactor (lib/providers/secret-redaction.ts).
//
// A model streams text a few characters per SSE event, each wrapped in its own JSON. A
// key that arrives that way never forms a 12-character run in the bytes, but the agent's
// SDK joins the deltas and gets the whole key. Credential-isolation benchmark case
// `leaks/stream-split` (~/agent-credential-bench): 7-character deltas, 15 ms apart.
//
// Every "catches" test here was red against the byte-only redactor. The rest pin what
// must NOT change: ordinary events pass at once and byte-for-byte, the event sequence is
// never reordered, added to or shortened, and a stream this does not recognize gets
// exactly the byte-level masking it had.
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { PROVIDER_KEY_REDACTION, redactingByteStream, redactingStream, secretsToRedact } from "@/lib/providers/secret-redaction";

const SECRET = "Zq7Lp2Wx9Rt4Yv6Bn1Mk8Hj3Gf5Dc0SaQe2We4Rt6Yu8Io0PaSd3Fg5Hj7Kl9Zx1Cv3Bn5Mm7Nq9Wr2Et4Yu6Ii8Oo0Pp2Aa4S";
const ANT = `sk-ant-api03-${SECRET}`;
const SECRETS = secretsToRedact(ANT);
const MARK = PROVIDER_KEY_REDACTION;
const enc = new TextEncoder();

// ── Driving the stream ──────────────────────────────────────────────────────

/** Everything the stream emits, as one string. */
async function pipe(chunks: readonly (string | Uint8Array)[], secrets = SECRETS, onRedact?: () => void): Promise<string> {
  const t = redactingStream(secrets, onRedact);
  const writer = t.writable.getWriter();
  const reader = t.readable.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  })();
  for (const c of chunks) await writer.write(typeof c === "string" ? enc.encode(c) : c);
  await writer.close();
  await reading;
  return out;
}

/**
 * What the stream emits after EACH write, then (last entry) what it emits on close.
 * `steps[i] === ""` means chunk i was held back; this is how "no added delay" is proved.
 */
async function stepPipe(
  chunks: readonly (string | Uint8Array)[],
  secrets = SECRETS,
  onRedact?: () => void,
  make: typeof redactingStream = redactingStream
): Promise<string[]> {
  const t = make(secrets, onRedact);
  const writer = t.writable.getWriter();
  const reader = t.readable.getReader();
  const decoder = new TextDecoder();
  const TICK = Symbol("tick");
  const tick = () => new Promise<typeof TICK>((r) => setTimeout(() => r(TICK), 0));
  const steps: string[] = [];
  let next = reader.read();
  let ended = false;
  const drain = async () => {
    let got = "";
    while (!ended) {
      const r = await Promise.race([next, tick()]);
      if (r === TICK) break;
      if (r.done) {
        ended = true;
        break;
      }
      got += decoder.decode(r.value, { stream: true });
      next = reader.read();
    }
    return got;
  };
  for (const c of chunks) {
    await writer.write(typeof c === "string" ? enc.encode(c) : c);
    steps.push(await drain());
  }
  await writer.close();
  let tail = "";
  while (!ended) tail += await drain();
  steps.push(tail);
  return steps;
}

const cut = (text: string, size: number) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];

/** A small deterministic PRNG, so a failing fuzz case can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same bytes, re-cut at random places: what a network does to an SSE stream. */
function recut(text: string, random: () => number, max = 40): Uint8Array[] {
  const bytes = enc.encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; ) {
    const n = 1 + Math.floor(random() * max);
    out.push(bytes.slice(i, i + n));
    i += n;
  }
  return out;
}

// ── Building provider streams ───────────────────────────────────────────────

const aev = (type: string, body: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const PING = aev("ping");
const SIGNATURE = "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds";
const MESSAGE_START = aev("message_start", {
  message: { id: "msg_01", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } },
});
const MESSAGE_END = [
  aev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } }),
  aev("message_stop"),
];
const textDelta = (index: number, text: string) => aev("content_block_delta", { index, delta: { type: "text_delta", text } });
/** All that is out of a held text delta: its `event:` line. The data, and so the event, waits. */
const HELD = "event: content_block_delta\n";

type Block = { kind: "text" | "thinking" | "tool_use"; pieces: readonly string[] };

/** An Anthropic Messages stream: one event per array entry. */
function anthropic(blocks: readonly Block[]): string[] {
  const out = [MESSAGE_START];
  blocks.forEach((b, index) => {
    if (b.kind === "text") {
      out.push(aev("content_block_start", { index, content_block: { type: "text", text: "" } }));
      for (const p of b.pieces) out.push(textDelta(index, p));
    } else if (b.kind === "thinking") {
      out.push(aev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } }));
      for (const p of b.pieces) out.push(aev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: p } }));
      out.push(aev("content_block_delta", { index, delta: { type: "signature_delta", signature: SIGNATURE } }));
    } else {
      out.push(aev("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${index}`, name: "lookup", input: {} } }));
      for (const p of b.pieces) out.push(aev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: p } }));
    }
    out.push(aev("content_block_stop", { index }));
  });
  return [...out, ...MESSAGE_END];
}

const cev = (choices: object[], extra: object = {}) =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1762732800, model: "gpt-test", ...extra, choices })}\n\n`;
const DONE = "data: [DONE]\n\n";
const contentChunk = (index: number, content: string) => cev([{ index, delta: { content }, finish_reason: null }]);

/** An OpenAI Chat Completions stream whose text is the given pieces. */
function chatContent(pieces: readonly string[]): string[] {
  return [
    cev([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    ...pieces.map((p) => contentChunk(0, p)),
    cev([{ index: 0, delta: {}, finish_reason: "stop" }]),
    cev([], { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }),
    DONE,
  ];
}

/** An OpenAI Chat Completions stream with one tool call whose arguments are the pieces. */
function chatTool(pieces: readonly string[]): string[] {
  return [
    cev([{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }]),
    cev([{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }] }, finish_reason: null }]),
    ...pieces.map((p) => cev([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p } }] }, finish_reason: null }])),
    cev([{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
    DONE,
  ];
}

/** An OpenAI Responses stream. The `done` events repeat the whole text, as the real API does. */
function responsesText(pieces: readonly string[]): string[] {
  const full = pieces.join("");
  let n = 0;
  const rev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: n++, ...body })}\n\n`;
  const at = { item_id: "msg_1", output_index: 0, content_index: 0 };
  const item = (text: string, status: string) => ({ id: "msg_1", type: "message", role: "assistant", status, content: text ? [{ type: "output_text", text, annotations: [] }] : [] });
  return [
    rev("response.created", { response: { id: "resp_1", object: "response", status: "in_progress", output: [] } }),
    rev("response.output_item.added", { output_index: 0, item: item("", "in_progress") }),
    rev("response.content_part.added", { ...at, part: { type: "output_text", text: "", annotations: [] } }),
    ...pieces.map((p) => rev("response.output_text.delta", { ...at, delta: p, logprobs: [] })),
    rev("response.output_text.done", { ...at, text: full, logprobs: [] }),
    rev("response.content_part.done", { ...at, part: { type: "output_text", text: full, annotations: [] } }),
    rev("response.output_item.done", { output_index: 0, item: item(full, "completed") }),
    rev("response.completed", { response: { id: "resp_1", object: "response", status: "completed", output: [item(full, "completed")], usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } }),
  ];
}

function responsesArguments(pieces: readonly string[]): string[] {
  const full = pieces.join("");
  let n = 0;
  const rev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: n++, ...body })}\n\n`;
  const call = (args: string, status: string) => ({ id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: args, status });
  return [
    rev("response.created", { response: { id: "resp_1", object: "response", status: "in_progress", output: [] } }),
    rev("response.output_item.added", { output_index: 0, item: call("", "in_progress") }),
    ...pieces.map((p) => rev("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: p })),
    rev("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: full }),
    rev("response.output_item.done", { output_index: 0, item: call(full, "completed") }),
    rev("response.completed", { response: { id: "resp_1", object: "response", status: "completed", output: [call(full, "completed")] } }),
  ];
}

// ── Reading what the agent gets ─────────────────────────────────────────────

type Json = Record<string, any>;

/** Every `data:` payload, parsed. Throws on one that is not JSON: the stream must stay valid. */
function events(raw: string): Json[] {
  const out: Json[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") out.push(JSON.parse(data));
    }
  }
  return out;
}

/** The order of events, by what each one is: reordering, adding or dropping one shows here. */
const sequence = (raw: string) =>
  events(raw).map((e) => `${e.type ?? e.object}:${e.index ?? e.output_index ?? e.choices?.map((c: Json) => c.index).join(",") ?? ""}`);

/** Text joined the way an SDK does it, for each shape. */
const readers = {
  anthropicBlocks(raw: string): string[] {
    const blocks: string[] = [];
    for (const e of events(raw)) {
      if (e.type !== "content_block_delta") continue;
      const piece = e.delta.text ?? e.delta.partial_json ?? e.delta.thinking ?? "";
      blocks[e.index] = (blocks[e.index] ?? "") + piece;
    }
    return blocks;
  },
  chatContent(raw: string, choice = 0): string {
    let text = "";
    for (const e of events(raw)) for (const c of e.choices ?? []) if (c.index === choice && typeof c.delta?.content === "string") text += c.delta.content;
    return text;
  },
  chatArguments(raw: string): string {
    let text = "";
    for (const e of events(raw)) for (const c of e.choices ?? []) for (const t of c.delta?.tool_calls ?? []) text += t.function?.arguments ?? "";
    return text;
  },
  responsesDeltas(raw: string): string {
    return events(raw).filter((e) => typeof e.delta === "string").map((e) => e.delta).join("");
  },
  /** Every text delta of any of the three shapes, in arrival order (the benchmark's reading). */
  everyDelta(raw: string): string {
    return events(raw)
      .map((e) => (typeof e.delta === "string" ? e.delta : (e.delta?.text ?? (e.choices ?? []).map((c: Json) => c.delta?.content ?? "").join(""))))
      .join("");
  },
};

/** How the key shows up in `out`, or null. The benchmark's rule: any 12 secret characters, or an encoding. */
function leak(out: string): string | null {
  for (let i = 0; i + 12 <= SECRET.length; i++) if (out.includes(SECRET.slice(i, i + 12))) return `12 secret characters from ${i}`;
  const lower = out.toLowerCase();
  const b = Buffer.from(ANT);
  if (out.includes(b.toString("base64"))) return "base64";
  if (out.includes(b.toString("base64url"))) return "base64url";
  if (lower.includes(b.toString("hex"))) return "hex";
  if (lower.includes([...b].map((x) => `%${x.toString(16).padStart(2, "0")}`).join(""))) return "percent";
  if (out.includes([...ANT].reverse().join(""))) return "reversed";
  return null;
}

/** `before <key> after`, redacted: at most the first 3 characters of the key may precede the marker. */
function expectRedactedSentence(text: string, open = "before ", close = " after") {
  expect(text.startsWith(open), text).toBe(true);
  expect(text.endsWith(close), text).toBe(true);
  const middle = text.slice(open.length, text.length - close.length);
  expect(middle.endsWith(MARK), text).toBe(true);
  const lead = middle.slice(0, -MARK.length);
  expect(lead.length, text).toBeLessThanOrEqual(3);
  expect(ANT.startsWith(lead), text).toBe(true);
}

const SENTENCE = `before ${ANT} after`;
const ARGUMENTS = `{"note":"before ${ANT} after"}`;

const SHAPES: { name: string; build: (pieces: string[]) => string[]; read: (raw: string) => string; text: string; open?: string; close?: string }[] = [
  { name: "Anthropic text", build: (p) => anthropic([{ kind: "text", pieces: p }]), read: (r) => readers.anthropicBlocks(r)[0]!, text: SENTENCE },
  { name: "Anthropic tool input", build: (p) => anthropic([{ kind: "tool_use", pieces: p }]), read: (r) => readers.anthropicBlocks(r)[0]!, text: ARGUMENTS, open: '{"note":"before ', close: ' after"}' },
  { name: "Anthropic thinking", build: (p) => anthropic([{ kind: "thinking", pieces: p }]), read: (r) => readers.anthropicBlocks(r)[0]!, text: SENTENCE },
  { name: "OpenAI chat content", build: chatContent, read: (r) => readers.chatContent(r), text: SENTENCE },
  { name: "OpenAI chat tool arguments", build: chatTool, read: readers.chatArguments, text: ARGUMENTS, open: '{"note":"before ', close: ' after"}' },
  { name: "OpenAI Responses text", build: responsesText, read: readers.responsesDeltas, text: SENTENCE },
  { name: "OpenAI Responses function arguments", build: responsesArguments, read: readers.responsesDeltas, text: ARGUMENTS, open: '{"note":"before ', close: ' after"}' },
];
const SIZES = [1, 2, 3, 5, 7, 11, 13, 40];

describe("a key split across SSE events is caught in the text the SDK joins", () => {
  for (const shape of SHAPES) {
    it.each(SIZES)(`${shape.name}: pieces of %i`, async (size) => {
      const input = shape.build(cut(shape.text, size));
      const raw = await pipe(input);
      // Neither the bytes nor the joined text carry the key.
      expect(leak(raw)).toBeNull();
      const joined = shape.read(raw);
      expect(leak(joined)).toBeNull();
      expectRedactedSentence(joined, shape.open, shape.close);
      // Same events, same order: nothing added, dropped or moved. `events` also proves
      // every payload still parses.
      expect(sequence(raw)).toEqual(sequence(input.join("")));
    });
  }

  // The benchmark's exact case: 7-character Anthropic text deltas, and its own way of
  // joining them (every `delta.text` in arrival order).
  it("the benchmark's stream-split case", async () => {
    const raw = await pipe(anthropic([{ kind: "text", pieces: cut(ANT, 7) }]));
    const benchJoined = readers.everyDelta(raw);
    expect(leak(raw)).toBeNull();
    expect(leak(benchJoined)).toBeNull();
    expect(benchJoined).toBe(MARK);
  });

  it.each([
    ["base64", (k: string) => Buffer.from(k).toString("base64")],
    ["base64 inside Basic auth", (k: string) => `Basic ${Buffer.from(`user:${k}`).toString("base64")}`],
    ["base64url", (k: string) => Buffer.from(k).toString("base64url")],
    ["hex", (k: string) => Buffer.from(k).toString("hex")],
    ["HEX", (k: string) => Buffer.from(k).toString("hex").toUpperCase()],
    ["percent-encoded", (k: string) => [...Buffer.from(k)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")],
    ["reversed", (k: string) => [...k].reverse().join("")],
    ["a 30-character run of the secret part", () => SECRET.slice(40, 70)],
    ["the key cut short", (k: string) => k.slice(0, 50)],
  ])("an echo spelled as %s, in pieces of 1, 4 and 7", async (_name, spell) => {
    const echo = spell(ANT);
    for (const size of [1, 4, 7]) {
      for (const build of [(p: string[]) => anthropic([{ kind: "text", pieces: p }]), chatContent, responsesText]) {
        const raw = await pipe(build(cut(`upstream saw: ${echo} (end)`, size)));
        expect(leak(raw), `size ${size}`).toBeNull();
        // Independent of how the redactor finds it: the middle half of the echo is gone.
        expect(raw).not.toContain(echo.slice(Math.floor(echo.length / 4), Math.floor((echo.length * 3) / 4)));
        const joined = readers.everyDelta(raw);
        expect(joined).not.toContain(echo.slice(Math.floor(echo.length / 4), Math.floor((echo.length * 3) / 4)));
        expect(joined).toContain(MARK);
        expect(joined.endsWith(" (end)")).toBe(true);
      }
    }
  });

  it("pieces that cross content-block boundaries: one piece per text block", async () => {
    for (const size of [1, 7]) {
      const input = anthropic(cut(SENTENCE, size).map((p) => ({ kind: "text" as const, pieces: [p] })));
      const raw = await pipe(input);
      const blocks = readers.anthropicBlocks(raw);
      // Per block, and with every block joined (a client that concatenates text blocks).
      for (const b of blocks) expect(leak(b)).toBeNull();
      expect(leak(blocks.join(""))).toBeNull();
      expect(leak(raw)).toBeNull();
      expectRedactedSentence(blocks.join(""));
      expect(sequence(raw)).toEqual(sequence(input.join("")));
    }
  });

  it("a key that starts in one block and ends in the next", async () => {
    const half = 7 + 40;
    const input = anthropic([
      { kind: "text", pieces: cut(SENTENCE.slice(0, half), 7) },
      { kind: "text", pieces: cut(SENTENCE.slice(half), 7) },
    ]);
    const blocks = readers.anthropicBlocks(await pipe(input));
    expect(leak(blocks.join(""))).toBeNull();
    expectRedactedSentence(blocks.join(""));
  });

  it("pieces with pings and other events between them", async () => {
    const input = [MESSAGE_START, aev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })];
    for (const p of cut(SENTENCE, 7)) input.push(textDelta(0, p), PING, ": keep-alive\n\n");
    input.push(aev("content_block_stop", { index: 0 }), ...MESSAGE_END);
    const raw = await pipe(input);
    expect(leak(raw)).toBeNull();
    expectRedactedSentence(readers.anthropicBlocks(raw)[0]!);
    expect(sequence(raw)).toEqual(sequence(input.join("")));
    expect(raw.split(": keep-alive\n\n")).toHaveLength(cut(SENTENCE, 7).length + 1);
  });

  it("two choices streamed in turn: the one carrying the key is redacted, the other is untouched", async () => {
    const prose = cut("The capital of France is Paris, and it has been for a very long time now.", 6);
    const keyed = cut(SENTENCE, 6);
    const input = [cev([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }, { index: 1, delta: { role: "assistant", content: "" }, finish_reason: null }])];
    for (let i = 0; i < Math.max(prose.length, keyed.length); i++) {
      if (prose[i]) input.push(contentChunk(0, prose[i]!));
      if (keyed[i]) input.push(contentChunk(1, keyed[i]!));
    }
    input.push(cev([{ index: 0, delta: {}, finish_reason: "stop" }]), cev([{ index: 1, delta: {}, finish_reason: "stop" }]), DONE);
    const raw = await pipe(input);
    expect(readers.chatContent(raw, 0)).toBe(prose.join(""));
    expectRedactedSentence(readers.chatContent(raw, 1));
    expect(leak(raw)).toBeNull();
    expect(sequence(raw)).toEqual(sequence(input.join("")));
  });

  it("both choices in ONE event", async () => {
    const pieces = cut(SENTENCE, 5);
    const input = pieces.map((p, i) => cev([{ index: 0, delta: { content: `w${i} ` }, finish_reason: null }, { index: 1, delta: { content: p }, finish_reason: null }]));
    const raw = await pipe([...input, DONE]);
    expect(readers.chatContent(raw, 0)).toBe(pieces.map((_p, i) => `w${i} `).join(""));
    expectRedactedSentence(readers.chatContent(raw, 1));
    expect(leak(raw)).toBeNull();
  });

  it("however the network cuts the bytes", async () => {
    const random = rng(20261110);
    for (const build of [(p: string[]) => anthropic([{ kind: "text", pieces: p }]), chatContent, responsesText]) {
      const input = build(cut(SENTENCE, 7)).join("");
      const whole = await pipe([input]);
      expect(leak(whole)).toBeNull();
      expect(await pipe(input.split(""))).toBe(whole);
      for (let round = 0; round < 20; round++) expect(await pipe(recut(input, random))).toBe(whole);
    }
  });

  it("with CRLF line endings", async () => {
    const input = anthropic([{ kind: "text", pieces: cut(SENTENCE, 7) }]).map((e) => e.replaceAll("\n", "\r\n"));
    const raw = await pipe(input);
    expect(leak(raw)).toBeNull();
    expectRedactedSentence(readers.anthropicBlocks(raw)[0]!);
    // Untouched lines keep their own line ending; so do rewritten ones.
    expect(raw.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("with bare CR line endings, and after a first line that is not SSE at all", async () => {
    const events = anthropic([{ kind: "text", pieces: cut(SENTENCE, 7) }]);
    for (const input of [events.map((e) => e.replaceAll("\n", "\r")), ["HTTP/1.1 200 OK\n", "x\n", ...events]]) {
      const raw = await pipe(input);
      expect(leak(raw)).toBeNull();
      expectRedactedSentence(readers.anthropicBlocks(raw.replaceAll("\r", "\n"))[0]!);
      expect(sequence(raw.replaceAll("\r", "\n"))).toEqual(sequence(input.join("").replaceAll("\r", "\n")));
    }
  });

  it("when the name `delta` is itself written with escapes", async () => {
    const input = cut(SENTENCE, 7).map((p) => `data: {"type":"content_block_delta","index":0,"\\u0064elta":{"type":"text_delta","text":${JSON.stringify(p)}}}\n\n`);
    expect(JSON.parse(input[0]!.slice(6)).delta.text).toBe("before ");
    const raw = await pipe(input);
    expect(leak(raw)).toBeNull();
    expectRedactedSentence(readers.anthropicBlocks(raw)[0]!);
  });

  // Three ways an upstream could make this stage read a stream differently from the
  // client that receives it (commit review, 2026-11-10). Each was a way past it.
  it("when fields the client ignores differ from event to event", async () => {
    // A chat client joins by choice index. It does not look at a `type`, and to it the
    // index "0" and the index 0 are the same choice.
    const pieces = cut(SENTENCE, 7);
    const typed = pieces.map((p, i) => `data: ${JSON.stringify({ type: `t${i}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
    expectRedactedSentence(readers.everyDelta(await pipe(typed)));
    const indexed = pieces.map((p, i) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: i % 2 ? "0" : 0, delta: { content: p } }] })}\n\n`);
    const raw = await pipe(indexed);
    expectRedactedSentence(readers.everyDelta(raw));
    expect(leak(raw)).toBeNull();
  });

  it("when hundreds of other text streams are opened between its pieces", async () => {
    // More streams than are followed at once. A stream that is part-way through a
    // possible key is never the one forgotten.
    // (11-character pieces keep what queues behind a held piece under the 256 KB bound.)
    const pieces = cut(SENTENCE, 11);
    for (const filler of ["ordinary", "see sk-a"]) {
      const crowd = `data: ${JSON.stringify({ choices: Array.from({ length: 400 }, (_v, i) => ({ index: i + 1, delta: { content: filler } })) })}\n\n`;
      const raw = await pipe([...pieces.flatMap((p) => [contentChunk(0, p), crowd]), DONE]);
      expect(leak(raw), filler).toBeNull();
      expectRedactedSentence(readers.chatContent(raw, 0));
      expect(readers.chatContent(raw, 250)).toBe(filler.repeat(pieces.length));
    }
  });

  it("when a line holds a byte that is not valid UTF-8", async () => {
    // A client decodes leniently (the bad byte becomes U+FFFD) and still reads the event.
    const lines = cut(SENTENCE, 7).map((p) => {
      const [head, tail] = `data: ${JSON.stringify({ id: "SPLIT", choices: [{ index: 0, delta: { content: p } }] })}\n\n`.split("SPLIT");
      return Buffer.concat([Buffer.from(head!), Buffer.from([0xff]), Buffer.from(tail!)]);
    });
    expect(JSON.parse(new TextDecoder().decode(lines[0]).slice(6)).choices[0].delta.content).toBe("before ");
    const raw = await pipe(lines);
    expect(leak(raw)).toBeNull();
    expectRedactedSentence(readers.chatContent(raw));
  });

  it("when the stream ends without a final blank line", async () => {
    const input = anthropic([{ kind: "text", pieces: cut(SENTENCE, 7) }]).slice(0, 2 + cut(SENTENCE, 7).length);
    input[input.length - 1] = input[input.length - 1]!.trimEnd();
    const raw = await pipe(input);
    expect(leak(raw)).toBeNull();
    expectRedactedSentence(readers.anthropicBlocks(raw)[0]!);
  });

  it("reports that it redacted, once, and not for text that only looked like a key", async () => {
    let calls = 0;
    await pipe(anthropic([{ kind: "text", pieces: cut(`${SENTENCE} and again ${ANT}`, 7) }]), SECRETS, () => calls++);
    expect(calls).toBe(1);
    calls = 0;
    await pipe(anthropic([{ kind: "text", pieces: ["see sk-ant-", "api03-", "… that is the format"] }]), SECRETS, () => calls++);
    expect(calls).toBe(0);
  });

  // HOLD_FROM: an event is held from the 4th matching character, so a key arriving one
  // character at a time shows its first three. For a real key those are public.
  it("a key that arrives one character at a time shows at most its first 3 characters", async () => {
    expect(readers.chatContent(await pipe(chatContent(cut(SENTENCE, 1))))).toBe(`before sk-${MARK} after`);
    expect(readers.chatContent(await pipe(chatContent(cut(`run ${SECRET.slice(30, 60)} end`, 1))))).toBe(`run ${SECRET.slice(30, 33)}${MARK} end`);
    // Four or more at a time: nothing of it shows.
    expect(readers.chatContent(await pipe(chatContent(["before ", ...cut(ANT, 4), " after"])))).toBe(`before ${MARK} after`);
  });

  it("a short key (6 to 15 characters) stays exact-match only, now across events too", async () => {
    const short = secretsToRedact("vllm-key-1");
    const whole = await pipe(chatContent(cut("token vllm-key-1 here", 4)), short);
    expect(readers.chatContent(whole)).not.toContain("vllm-key-1");
    expect(readers.chatContent(whole)).toContain(MARK);
    // Nine of its ten characters are not the key: no fragments below 16.
    const part = chatContent(cut("token vllm-key- here", 4));
    expect(await pipe(part, short)).toBe(part.join(""));
  });
});

describe("the real SDKs assemble a sensible message from a redacted stream", () => {
  const respond = (body: string) => async () => new Response(body, { headers: { "content-type": "text/event-stream" } });

  it("Anthropic: text, a tool call and thinking keep their blocks, indexes and stop reason", async () => {
    const input = anthropic([
      { kind: "thinking", pieces: cut("The user wants the lookup. I should call the tool.", 9) },
      { kind: "text", pieces: cut(SENTENCE, 7) },
      { kind: "tool_use", pieces: cut(ARGUMENTS, 7) },
    ]);
    const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: respond(await pipe(input)) });
    const message = await client.messages.stream({ model: "claude-test", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }).finalMessage();
    expect(message.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(message.content[0]).toMatchObject({ thinking: "The user wants the lookup. I should call the tool.", signature: SIGNATURE });
    expect(message.content[1]).toMatchObject({ text: `before ${MARK} after` });
    expect(message.content[2]).toMatchObject({ name: "lookup", input: { note: `before ${MARK} after` } });
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage.output_tokens).toBe(42);
    expect(leak(JSON.stringify(message))).toBeNull();
  });

  it("OpenAI Chat Completions: content, tool arguments, finish reason and usage", async () => {
    const client = (body: string) => new OpenAI({ apiKey: "test", maxRetries: 0, fetch: respond(body) });
    const text = await client(await pipe(chatContent(cut(SENTENCE, 7)))).chat.completions
      .stream({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } })
      .finalChatCompletion();
    expect(text.choices[0]!.message.content).toBe(`before ${MARK} after`);
    expect(text.choices[0]!.finish_reason).toBe("stop");
    expect(text.usage?.total_tokens).toBe(12);
    const tool = await client(await pipe(chatTool(cut(ARGUMENTS, 7)))).chat.completions
      .stream({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] })
      .finalChatCompletion();
    const call = tool.choices[0]!.message.tool_calls![0]!;
    expect(call).toMatchObject({ id: "call_1", type: "function" });
    expect("function" in call && JSON.parse(call.function.arguments)).toEqual({ note: `before ${MARK} after` });
    expect(leak(JSON.stringify([text, tool]))).toBeNull();
  });

  it("OpenAI Responses: the deltas and the final response agree", async () => {
    const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: respond(await pipe(responsesText(cut(SENTENCE, 7)))) });
    const stream = client.responses.stream({ model: "gpt-test", input: "hi" });
    let deltas = "";
    stream.on("response.output_text.delta", (e) => { deltas += e.delta; });
    const final = await stream.finalResponse();
    expect(deltas).toBe(`before ${MARK} after`);
    expect(final.output_text).toBe(`before ${MARK} after`);
    expect(leak(JSON.stringify(final) + deltas)).toBeNull();
  });
});

describe("ordinary streaming is not slowed or changed", () => {
  const PROSE =
    "Sure. Here is a short summary of the report you asked about: revenue grew 14% in the third quarter, " +
    "mostly from the new subscription tier, while costs stayed flat. Two risks stand out; the first is churn " +
    "among monthly plans (up 0.8 points), and the second is a supplier contract that ends in March 2027. " +
    "Ключевой вывод: рост устойчив. 结论:增长稳健 ✅ — let me know if you want the numbers as a table.";
  const tokens = PROSE.match(/\s*\S+/g) ?? [];

  const ordinary: [string, string[]][] = [
    ["Anthropic", [MESSAGE_START, PING, ...anthropic([
      { kind: "thinking", pieces: tokens.slice(0, 12) },
      { kind: "text", pieces: tokens },
      { kind: "tool_use", pieces: cut('{"query":"Q3 revenue by tier","limit":25,"include":["churn","costs"]}', 6) },
    ]).slice(1)]],
    ["OpenAI chat", [...chatContent(tokens).slice(0, -3), ...chatTool(cut('{"query":"Q3 revenue","limit":25}', 5)).slice(1)]],
    ["OpenAI Responses", responsesText(tokens)],
  ];

  it.each(ordinary)("%s: every event comes out at once, byte for byte", async (_name, input) => {
    const steps = await stepPipe(input);
    // One chunk in, the same chunk out, before the next arrives. Nothing left for the close.
    expect(steps.slice(0, -1)).toEqual(input);
    expect(steps.at(-1)).toBe("");
  });

  it("a tail of three matching characters is not held; four are, and only until the text moves on", async () => {
    // "sk-" is where the key starts, and where a great deal of ordinary text ends.
    const three = [MESSAGE_START, textDelta(0, "the prefix is sk-"), textDelta(0, " as a rule"), ...MESSAGE_END];
    expect((await stepPipe(three)).slice(0, -1)).toEqual(three);

    const four = [MESSAGE_START, textDelta(0, "token: sk-an"), PING, textDelta(0, "d is not it"), ...MESSAGE_END];
    const steps = await stepPipe(four);
    // "sk-an" could still become the key, so this event's data waits. Its `event:` line
    // is already out, which is harmless: a client acts on an event at its blank line.
    expect(steps[1]).toBe(HELD);
    expect(steps[2]).toBe(""); // what follows queues behind it, so order never changes
    expect(steps[1]! + steps[3]!).toBe(four[1]! + four[2]! + four[3]!); // released untouched the moment it cannot
    expect(steps.join("")).toBe(four.join(""));
  });

  it("text that walks a long way down the key and then turns away is released unchanged", async () => {
    const lookalike = `${ANT.slice(0, 13 + 11)}… and that is where real keys differ`;
    for (const build of [(p: string[]) => anthropic([{ kind: "text", pieces: p }]), chatContent, responsesText]) {
      const input = build(cut(`Keys look like ${lookalike}`, 5));
      expect(await pipe(input)).toBe(input.join(""));
    }
  });

  it("thinking that is not the key keeps its exact bytes and its signature", async () => {
    const input = anthropic([{ kind: "thinking", pieces: ["Their key starts with sk-ant-", "api03-", " and I must not repeat it."] }, { kind: "text", pieces: ["Done."] }]);
    expect(await pipe(input)).toBe(input.join(""));
  });

  it("an end of stream releases whatever is still held, in order", async () => {
    const input = [MESSAGE_START, textDelta(0, "it starts sk-ant-api03-"), aev("content_block_stop", { index: 0 }), ...MESSAGE_END];
    const steps = await stepPipe(input);
    expect(steps.slice(1, -1).join("")).toBe(HELD);
    expect(steps.join("")).toBe(input.join(""));
  });

  it("random ordinary streams, randomly cut, come out byte-identical", async () => {
    const random = rng(7);
    const words = PROSE.split(" ");
    for (let round = 0; round < 60; round++) {
      const text = Array.from({ length: 5 + Math.floor(random() * 60) }, () => words[Math.floor(random() * words.length)]).join(" ");
      const pieces = cut(text, 1 + Math.floor(random() * 9));
      const build = [(p: string[]) => anthropic([{ kind: "text", pieces: p }]), chatContent, chatTool, responsesText, responsesArguments][round % 5]!;
      const input = build(pieces).join("");
      expect(await pipe(recut(input, random))).toBe(input);
    }
  });
});

describe("holding is bounded", () => {
  it("a candidate nothing extends is released after 32 further events", async () => {
    const input = [MESSAGE_START, textDelta(0, "see sk-ant-"), ...Array.from({ length: 40 }, () => PING), textDelta(0, " for the format"), ...MESSAGE_END];
    const steps = await stepPipe(input);
    expect(steps[1]).toBe(HELD);
    const releasedAt = steps.findIndex((s) => s.includes("see sk-ant-"));
    expect(releasedAt).toBeGreaterThan(1);
    expect(releasedAt).toBeLessThanOrEqual(1 + 33);
    expect(steps.join("")).toBe(input.join(""));
  });

  it("a key whose pieces are 40 events apart still never shows 12 secret characters in a row", async () => {
    const pieces = cut(ANT, 6);
    const input = [MESSAGE_START];
    for (const p of pieces) input.push(textDelta(0, p), ...Array.from({ length: 40 }, () => PING));
    input.push(...MESSAGE_END);
    const raw = await pipe(input);
    expect(leak(raw)).toBeNull();
    const joined = readers.anthropicBlocks(raw)[0]!;
    expect(leak(joined)).toBeNull();
    expect(joined).toContain(MARK);
    expect(sequence(raw)).toEqual(sequence(input.join("")));
  });

  // The price of a bounded hold, pinned: an ENCODING whose pieces are that far apart is
  // released piece by piece, and only its last piece is caught. The raw key is not
  // exposed the same way (the test above): 12 secret characters in a row never pass.
  it("an encoding whose pieces are 40 events apart passes except for its end: a documented limit", async () => {
    const encoded = Buffer.from(ANT).toString("base64");
    const input = [MESSAGE_START];
    for (const p of cut(encoded, 6)) input.push(textDelta(0, p), ...Array.from({ length: 40 }, () => PING));
    const joined = readers.anthropicBlocks(await pipe([...input, ...MESSAGE_END]))[0]!;
    expect(joined.endsWith(MARK)).toBe(true);
    expect(joined).not.toContain(encoded);
    expect(joined).toContain(encoded.slice(0, encoded.length - 12));
  });

  it("a candidate is released once 256 KB has queued behind it", async () => {
    const bulky = aev("content_block_delta", { index: 9, note: "x".repeat(40_000) });
    const input = [MESSAGE_START, textDelta(0, "see sk-ant-"), ...Array.from({ length: 12 }, () => bulky), ...MESSAGE_END];
    const steps = await stepPipe(input);
    const releasedAt = steps.findIndex((s) => s.includes("see sk-ant-"));
    expect(releasedAt).toBeGreaterThan(1);
    expect(releasedAt).toBeLessThanOrEqual(1 + 7);
    expect(steps.join("")).toBe(input.join(""));
  });

  it("a line over 1 MB is passed along as it arrives, and the stream is still followed after it", async () => {
    const big = `data: {"type":"image","b64":"${"A".repeat(1_300_000)}"}\n\n`;
    const input = [MESSAGE_START, ...cut(big, 100_000), ...cut(SENTENCE, 7).map((p) => textDelta(0, p)), ...MESSAGE_END];
    const steps = await stepPipe(input);
    // Not buffered to its end: bytes of the big line are out before its last chunk is in.
    expect(steps.slice(1, 13).join("").length).toBeGreaterThan(1_000_000);
    const raw = steps.join("");
    expect(raw).toContain(big);
    expect(leak(raw)).toBeNull();
    expectRedactedSentence(readers.anthropicBlocks(raw)[0]!);
  });

  it("thousands of separate text streams in one response cost no more than a few", async () => {
    const input = Array.from({ length: 5_000 }, (_v, i) => contentChunk(i, "hello sk-a"));
    input.push(...cut(SENTENCE, 7).map((p) => contentChunk(5_000, p)), DONE);
    const started = performance.now();
    const raw = await pipe(input);
    expect(performance.now() - started).toBeLessThan(3_000);
    expectRedactedSentence(readers.chatContent(raw, 5_000));
    expect(readers.chatContent(raw, 17)).toBe("hello sk-a");
  });

  // 2 MB of ordinary Anthropic text deltas with the key streamed in the middle.
  it("follows a 2 MB stream of small text deltas quickly", async () => {
    const filler = Array.from({ length: 50_000 }, (_v, i) => textDelta(0, ` word${i % 977} and more`));
    const input = [MESSAGE_START, ...filler, ...cut(SENTENCE, 7).map((p) => textDelta(0, p)), ...filler, ...MESSAGE_END];
    // 200 events per network chunk, so the cost measured is the redactor's, not the test's.
    const chunks: string[] = [];
    for (let i = 0; i < input.length; i += 200) chunks.push(input.slice(i, i + 200).join(""));
    expect(chunks.join("").length).toBeGreaterThan(2_000_000);
    const started = performance.now();
    const raw = await pipe(chunks);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(leak(raw)).toBeNull();
    expect(raw).toContain(MARK);
  });
});

describe("a stream it does not recognize gets exactly the byte-level masking it had", () => {
  /** The byte-only stream is the reference: same output after every single write. */
  const sameAsBytesOnly = async (chunks: readonly (string | Uint8Array)[]) => {
    const steps = await stepPipe(chunks);
    expect(steps).toEqual(await stepPipe(chunks, SECRETS, undefined, redactingByteStream));
    return steps;
  };

  // Not SSE at all: bytes are never held for a line or an event to finish.
  it("a JSON body passes through as it arrives, masked by bytes only", async () => {
    const body = JSON.stringify({ data: [{ embedding: [0.1, 0.2] }], note: `echo ${ANT}`, delta: { text: "x" } });
    const steps = await sameAsBytesOnly(cut(body, 9));
    expect(steps.join("")).toBe(body.replace(ANT, MARK));
    expect(steps[0]!.length).toBeGreaterThan(0);
  });

  it("random bytes, text and near-keys that are not SSE", async () => {
    const random = rng(99);
    const scraps = ["{", '"', "sk-ant-api03-", SECRET.slice(3, 14), SECRET.slice(20, 50), ANT, "\n", "\r\n", " ", "event", "<html>", "日本語", Buffer.from(ANT).toString("base64").slice(0, 30)];
    for (let round = 0; round < 40; round++) {
      let body = "{";
      for (let i = 0; i < 30; i++) body += scraps[Math.floor(random() * scraps.length)];
      await sameAsBytesOnly(recut(body, random, 25));
    }
  });

  // The one place a byte can wait where it did not before: a line that so far spells
  // `data:` is kept until it is clear whether it is one. At most those few bytes.
  it("a line that starts like `data:` waits only until it is clear it is not one", async () => {
    const steps = await stepPipe(["first line\nda", "t", "abase is not SSE\n", "data", "\n"]);
    expect(steps.slice(0, -1)).toEqual(["first line\n", "", "database is not SSE\n", "", "data\n"]);
    const random = rng(5);
    for (let round = 0; round < 40; round++) {
      let body = "";
      for (let i = 0; i < 30; i++) body += ["data", "data:", "dat", "\n", "\r", "{}", ANT, SECRET.slice(0, 11), "x"][Math.floor(random() * 9)];
      const chunks = recut(body, random, 12);
      // Two needles back to back come out as one marker or two depending on where the
      // bytes were cut (true of the byte-only stream too), so runs of markers count as one.
      const oneMarker = (steps: string[]) => steps.join("").replaceAll(new RegExp(`(?:${MARK.replace(/[[\]]/g, "\\$&")})+`, "g"), MARK);
      expect(oneMarker(await stepPipe(chunks))).toBe(oneMarker(await stepPipe(chunks, SECRETS, undefined, redactingByteStream)));
    }
  });

  it("ordinary SSE, one event per chunk, is step for step what the byte-only stream gives", async () => {
    await sameAsBytesOnly(anthropic([{ kind: "text", pieces: cut("An ordinary answer, nothing to see.", 4) }]));
    await sameAsBytesOnly(chatContent(cut("An ordinary answer, nothing to see.", 4)));
  });

  // Ollama's native stream is newline-delimited JSON, not SSE: byte-level only, as before.
  it("NDJSON is not followed: a split key there is a documented limit", async () => {
    const lines = cut(ANT, 7).map((p) => `${JSON.stringify({ model: "llama3", message: { role: "assistant", content: p }, done: false })}\n`);
    expect((await sameAsBytesOnly(lines)).slice(0, -1)).toEqual(lines);
  });

  // SSE, but no `delta`: nothing here says which strings a client joins.
  it("SSE without a delta is not followed: a split key there is a documented limit", async () => {
    const lines = cut(ANT, 7).map((p) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: p }] } }] })}\n\n`);
    expect((await sameAsBytesOnly(lines)).slice(0, -1)).toEqual(lines);
  });

  // SSE clients join data lines with a newline before parsing JSON.
  it("follows JSON spread over several data lines", async () => {
    const lines = cut(ANT, 7).map((p) => `data: {"type":"content_block_delta","index":0,\ndata: "delta":{"type":"text_delta","text":"${p}"}}\n\n`);
    const raw = await pipe(lines);
    expect(readers.anthropicBlocks(raw)[0]).toBe(MARK);
    expect(leak(raw)).toBeNull();
  });

  // The list of fields is lib/stream-text-keys.ts, shared with the secret guard. Reasoning
  // models stream their reasoning in `reasoning_content` (DeepSeek, several OpenRouter
  // endpoints) or `reasoning` (OpenRouter), and OpenAI chat streams a refusal in `refusal`
  // (owner, 2026-11-10: add them).
  it.each(["refusal", "reasoning_content", "reasoning"])("follows a key split across chat `%s` deltas", async (field) => {
    const lines = cut(`before ${ANT} after`, 7).map((p) => cev([{ index: 0, delta: { [field]: p }, finish_reason: null }]));
    const out = await pipe(lines);
    const joined = events(out).map((e) => e.choices?.[0]?.delta?.[field] ?? "").join("");
    expect(leak(out)).toBeNull();
    expect(leak(joined)).toBeNull();
    expectRedactedSentence(joined);
  });

  it("a delta field the shared list does not name is not followed: a documented limit", async () => {
    const lines = cut(ANT, 7).map((p) => cev([{ index: 0, delta: { not_a_text_field: p }, finish_reason: null }]));
    expect((await sameAsBytesOnly(lines)).slice(0, -1)).toEqual(lines);
  });

  // Each choice is its own string in the client. Nothing joins choice 0 to choice 1.
  it("pieces dealt out between two choices are not joined: a documented limit", async () => {
    const lines = cut(ANT, 7).map((p, i) => contentChunk(i % 2, p));
    expect(await pipe(lines)).toBe(lines.join(""));
  });

  it("whole strings outside a delta are masked by bytes, and never joined to each other", async () => {
    // Each `text` here is a complete value (a `done` event, a content_block_start), not an
    // increment. Joining them would be wrong; a 12+ run inside one is still removed.
    const input = [
      aev("content_block_start", { index: 0, content_block: { type: "text", text: ANT.slice(0, 20) } }),
      aev("content_block_start", { index: 1, content_block: { type: "text", text: ANT.slice(20, 40) } }),
      aev("response.output_text.done", { text: `all of it ${ANT}` }),
    ];
    const raw = await pipe(input);
    expect(raw).toBe(input.join("").replace(ANT, MARK).replace(ANT.slice(20, 40), MARK));
  });

  it("data lines that are not JSON, comments, ids and retries pass untouched", async () => {
    const input = [": OPENROUTER PROCESSING\n\n", "id: 7\nretry: 3000\nevent: note\ndata: not json at all\n\n", 'data: {"delta": broken\n\n', DONE];
    expect((await stepPipe(input)).slice(0, -1)).toEqual(input);
  });

  it("with no secrets it is a plain pass-through", async () => {
    const input = anthropic([{ kind: "text", pieces: cut(SENTENCE, 7) }]);
    expect((await stepPipe(input, [])).slice(0, -1)).toEqual(input);
  });
});

// Random text with real leaks dropped in, random piece sizes, random network cuts, all
// three shapes. Two properties: the key never comes out, and nothing else is lost.
describe("fuzz", () => {
  const spellings = [
    ANT,
    SECRET.slice(10, 40),
    Buffer.from(ANT).toString("base64"),
    Buffer.from(`user:${ANT}`).toString("base64"),
    Buffer.from(ANT).toString("hex"),
    [...ANT].reverse().join(""),
    ANT.slice(0, 13 + 20),
  ];
  const words = ["the", "key", "is", "sk-", "sk-ant-", "api03", "Zq7", "Zq7Lp2Wx9", "token", "=", ":", '"', "\\", "{", "}", "naïve", "日本", "🔑", "0", "42", "Bearer", "Basic", "c2st", "736b", "%73%6b", "\n", "a4S", "Aa4"];

  it("never lets the key out, and keeps everything else in order", async () => {
    const random = rng(424242);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
    for (let round = 0; round < 150; round++) {
      let text = "";
      const parts = 3 + Math.floor(random() * 25);
      for (let i = 0; i < parts; i++) text += (random() < 0.15 ? pick(spellings) : pick(words)) + (random() < 0.7 ? " " : "");
      const size = pick([1, 2, 3, 4, 5, 7, 9, 16, 50]);
      const shape = pick(SHAPES.filter((s) => s.text === SENTENCE));
      const input = shape.build(cut(text, size));
      const raw = await pipe(recut(input.join(""), random));
      const joined = shape.read(raw);
      const context = `round ${round}, size ${size}, ${shape.name}: ${JSON.stringify(text)}`;
      expect(leak(raw), context).toBeNull();
      expect(leak(joined), context).toBeNull();
      expect(sequence(raw), context).toEqual(sequence(input.join("")));
      // Take the markers out and what is left is the input with pieces removed, in order.
      let at = 0;
      for (const kept of joined.split(MARK)) {
        const found = text.indexOf(kept, at);
        expect(found, context).toBeGreaterThanOrEqual(at);
        at = found + kept.length;
      }
      // No needle in the text: not one byte changes. A needle: it was replaced.
      if (SECRETS.some((needle) => text.includes(needle))) expect(joined, context).toContain(MARK);
      else expect(raw, context).toBe(input.join(""));
    }
  });
});
