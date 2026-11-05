// The secret guard's detector and redactor (owner, 2026-10-08: "start the secret guard";
// the discovery round ranked keys in prompts, keys in output and the agent holding real
// keys as the top worries).
//
// Measured before writing a rule (2026-10-08): a draft of these rules over every tracked
// file in this repo found 18 key-shaped strings, all of them test fixtures or the
// committed public demo credentials, and over a real 209 KB Claude Code request from this
// repo (system prompt, CLAUDE.md, memory, tools) found none. The fake heuristics below are
// the ones those fixtures needed: an alphabet walk ("Ab3dEf6hIj9k…"), a run of one
// character, a counting sequence, a give-away word, Telegram's own documentation token.
//
// GitHub tokens end in a CRC32 checksum, but GitHub's post does not say what it covers or
// which base62 alphabet it uses, and a wrong guess would dismiss REAL tokens. Not used.
//
// Every key-shaped value here is generated at run time: a literal in the source trips
// GitHub push protection on the private repo and the mirror.
import { describe, expect, it, vi } from "vitest";

// lib/demo/identity.ts is server-only, which Next enforces at build time and vitest cannot
// resolve; the same stub every route test uses.
vi.mock("server-only", () => ({}));
import {
  createSecretWatchStream,
  createStreamSecretDetector,
  findSecrets,
  redactSecrets,
  redactSecretsInText,
  type SecretKind,
} from "@/lib/secret-guard";
import { publiclyCommittedDemoValues } from "@/lib/demo/identity";

const [DEMO_CONTROL_KEY, DEMO_PASSPORT_SECRET] = publiclyCommittedDemoValues();

// A small seeded generator, so fixtures are random-looking and stable between runs.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64URL = `${B62}_-`;
const HEX = "0123456789abcdef";
const UPPER_NUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const KEYS: Record<Exclude<SecretKind, "private_key" | "passport_secret">, () => string> = {
  anthropic: () => ["sk", "ant", "api03", pick(B64URL, 93)].join("-"),
  openai: () => ["sk", "proj", pick(B64URL, 120)].join("-"),
  openrouter: () => ["sk", "or", "v1", pick(HEX, 64)].join("-"),
  groq: () => ["gsk", pick(B62, 52)].join("_"),
  xai: () => ["xai", pick(B62, 80)].join("-"),
  github: () => ["ghp", pick(B62, 36)].join("_"),
  github_fine: () => ["github", "pat", pick(B62, 22), pick(B62, 59)].join("_"),
  aws: () => ["AK", "IA", pick(UPPER_NUM, 16)].join(""),
  google: () => ["AI", "za", pick(B64URL, 35)].join(""),
  slack: () => ["xoxb", pick("0123456789", 12), pick("0123456789", 13), pick(B62, 24)].join("-"),
  stripe: () => ["sk", "live", pick(B62, 99)].join("_"),
  huggingface: () => ["hf", pick("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 34)].join("_"),
  passcontrol_agent: () => ["pc", "agent", pick(B64URL, 43)].join("_"),
  passcontrol_control: () => ["pc", pick(B64URL, 43)].join("_"),
  telegram: () => `${pick("123456789", 1)}${pick("0123456789", 9)}:AA${pick(B64URL, 33)}`,
  notion: () => ["ntn", pick(B62, 46)].join("_"),
};

const prompt = (text: string) => ({ model: "claude-sonnet-5", messages: [{ role: "user", content: [{ type: "text", text }] }] });

describe("findSecrets: what it catches", () => {
  it.each(Object.entries(KEYS))("a %s key in a prompt", (kind, make) => {
    const findings = findSecrets(prompt(`here you go: ${make()} thanks`));
    expect(findings).toEqual([{ kind, path: "messages[0].content[0].text" }]);
  });

  it("a private key block", () => {
    const pem = ["-----BEGIN ", "PRIVATE KEY-----\n", pick(B62, 64), "\n-----END ", "PRIVATE KEY-----"].join("");
    expect(findSecrets(prompt(pem))).toEqual([{ kind: "private_key", path: "messages[0].content[0].text" }]);
  });

  it("a ROTATED demo value is a real secret, not the public one", () => {
    // Only the committed values are public; one set through the environment is not.
    const rotated = pick(B64URL, 43);
    expect(findSecrets(prompt(`PASSPORT_SECRET=${rotated}`))).toEqual([{ kind: "passport_secret", path: "messages[0].content[0].text" }]);
  });

  it("a passport secret only where it is named as one", () => {
    const secret = pick(B64URL, 43);
    expect(findSecrets(prompt(`PASSPORT_SECRET=${secret}`))).toEqual([{ kind: "passport_secret", path: "messages[0].content[0].text" }]);
    // A bare 43-character base64url string is exactly what a passport ID looks like.
    expect(findSecrets(prompt(`passport ${secret}`))).toEqual([]);
  });

  it("anywhere in the body: system prompt, tool input, tool result, Responses input", () => {
    const k = KEYS.github();
    const body = {
      system: [{ type: "text", text: k }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: `export T=${k}` } }] }],
      input: [{ role: "user", content: k }],
    };
    expect(findSecrets(body).map((f) => f.path)).toEqual(["system[0].text", "messages[0].content[0].input.command", "input[0].content"]);
  });
});

describe("findSecrets: what it leaves alone", () => {
  it.each([
    ["an alphabet walk", ["sk", "proj", "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z", "ECHO_TEST"].join("-")],
    ["a run of one character", ["ghp", "a".repeat(36)].join("_")],
    ["a counting sequence", ["ghp", "0123456789abcdefghijklmnopqrstuvwxyz"].join("_")],
    ["a give-away word", ["AK", "IA", "IOSFODNN7EXAMPLE"].join("")],
    ["Telegram's documentation token", `123456789:AA${"HdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"}`],
    ["the public demo control key", DEMO_CONTROL_KEY!],
    ["the public demo passport secret", `PASSPORT_SECRET=${DEMO_PASSPORT_SECRET!}`],
  ])("%s", (_name, text) => {
    expect(findSecrets(prompt(`value: ${text}`))).toEqual([]);
  });

  it("base64 media: an image's bytes are not scanned", () => {
    const data = `${"iVBORw0KGgo"}${KEYS.aws()}${pick(B62, 1000)}`;
    const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] };
    expect(findSecrets(body)).toEqual([]);
  });

  it("the model and other non-prompt fields are part of the body too, and a key there is found", () => {
    // Nothing legitimate puts a key in `metadata`; a scan that skipped it would be a gap.
    expect(findSecrets({ metadata: { user_id: KEYS.github() }, messages: [] })).toEqual([{ kind: "github", path: "metadata.user_id" }]);
  });
});

const FP_KEY = "fingerprint-key-for-tests-only-32bytes!";

describe("redactSecrets", () => {
  it("replaces each secret with a placeholder that names its kind and never contains it", () => {
    const k = KEYS.anthropic();
    const { value, findings } = redactSecrets(prompt(`key ${k} end`), FP_KEY);
    const text = (value as ReturnType<typeof prompt>).messages[0]!.content[0]!.text;
    expect(text).toMatch(/^key \[SECRET_REDACTED:anthropic:[0-9a-f]{8}\] end$/);
    expect(JSON.stringify(value)).not.toContain(k);
    expect(findings).toEqual([{ kind: "anthropic", path: "messages[0].content[0].text" }]);
  });

  it("is deterministic, so Claude Code's prompt cache prefix stays the same from call to call", () => {
    const k = KEYS.github();
    const a = JSON.stringify(redactSecrets(prompt(k), FP_KEY).value);
    const b = JSON.stringify(redactSecrets(prompt(k), FP_KEY).value);
    expect(a).toBe(b);
  });

  it("tells two different secrets apart, without revealing either", () => {
    const one = redactSecrets(prompt(KEYS.github()), FP_KEY).value;
    const two = redactSecrets(prompt(KEYS.github()), FP_KEY).value;
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
  });

  it("a placeholder is not itself a secret, so a redacted body scans clean", () => {
    expect(findSecrets(redactSecrets(prompt(KEYS.openai()), FP_KEY).value)).toEqual([]);
  });

  it("redacts a whole private key block, not only its first line", () => {
    const inner = pick(B62, 200);
    const pem = ["-----BEGIN RSA ", "PRIVATE KEY-----\n", inner, "\n-----END RSA ", "PRIVATE KEY-----"].join("");
    const out = JSON.stringify(redactSecrets(prompt(`before ${pem} after`), FP_KEY).value);
    expect(out).not.toContain(inner);
    expect(out).toContain("before [SECRET_REDACTED:private_key:");
  });

  it("returns the same object when there is nothing to redact", () => {
    const body = prompt("nothing here");
    expect(redactSecrets(body, FP_KEY).value).toBe(body);
  });

  it("leaves base64 media byte for byte", () => {
    const data = pick(B62, 5000);
    const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }, { type: "text", text: KEYS.github() }] }] };
    const out = redactSecrets(body, FP_KEY).value as typeof body;
    expect(out.messages[0]!.content[0]).toEqual(body.messages[0]!.content[0]);
  });
});

describe("redactSecretsInText (a provider's answer)", () => {
  it("redacts a key the model wrote", () => {
    const k = KEYS.stripe();
    const { text, findings } = redactSecretsInText(`config: ${k}`, FP_KEY);
    expect(text).not.toContain(k);
    expect(findings).toEqual(["stripe"]);
  });
});

describe("the stream detector (a streamed answer arrives in fragments)", () => {
  it("finds a key split across many deltas, once", () => {
    const k = KEYS.anthropic();
    const d = createStreamSecretDetector();
    d.push("Sure, set ");
    for (let i = 0; i < k.length; i += 3) d.push(k.slice(i, i + 3));
    d.push(" in your env. Again: ");
    expect(d.findings()).toEqual(["anthropic"]);
  });

  it("keeps a bounded window, however long the answer", () => {
    const d = createStreamSecretDetector();
    for (let i = 0; i < 20_000; i++) d.push("lorem ipsum dolor sit amet ");
    expect(d.findings()).toEqual([]);
  });
});

describe("cost", () => {
  it("scans a 4 MB prompt quickly (edge, attacker-controlled input)", () => {
    const body = { messages: Array.from({ length: 40 }, () => ({ role: "user", content: pick(`${B62} -_:/=+.`, 100_000) })) };
    const started = performance.now();
    findSecrets(body);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  // Cloud review 2026-11-03, B3, measured on this file's own findSecrets before the fix:
  // 1.1 MB of private-key headers with no END took 4,651 ms (each header's lazy block
  // search read up to 16 KB ahead), and 1.05 MB of one AWS key repeated took 3,219 ms and
  // 2.1 MB took 8,498 ms (every match was compared with every earlier one). Tool output
  // stays in the conversation, so one hostile result slowed every later call.
  const BEGIN = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const END = ["-----END ", "PRIVATE KEY-----"].join("");
  it("scans 1.1 MB of private-key headers with no END quickly", () => {
    const text = `${BEGIN}\n`.repeat(39_286);
    const started = performance.now();
    const found = findSecrets(prompt(text));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(found).toHaveLength(39_286);
  });
  it("scans 2.1 MB of one real-looking key repeated quickly, through the redactor too", () => {
    const key = KEYS.aws();
    const text = `${key} `.repeat(100_000);
    let started = performance.now();
    expect(findSecrets(prompt(text))).toHaveLength(100_000);
    expect(performance.now() - started).toBeLessThan(1_000);
    started = performance.now();
    expect(redactSecrets(prompt(text), "k").findings).toHaveLength(100_000);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
  it("many keys of several kinds, interleaved, quickly", () => {
    const keys = [KEYS.aws(), KEYS.github(), KEYS.google(), KEYS.telegram(), KEYS.passcontrol_control()];
    const text = Array.from({ length: 60_000 }, (_, i) => keys[i % keys.length]).join(" ");
    const started = performance.now();
    expect(findSecrets(prompt(text))).toHaveLength(60_000);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

// B3's fix finds a private key's block without the lazy regex; these pin what that
// regex meant, so the faster search keeps it exactly.
describe("a private key block's extent", () => {
  const BEGIN = (v = "") => ["-----BEGIN ", v, "PRIVATE KEY-----"].join("");
  const END = (v = "") => ["-----END ", v, "PRIVATE KEY-----"].join("");
  const redact = (text: string) => redactSecretsInText(text, "k");
  it("takes the block up to the first END of any variant", () => {
    const r = redact(`a ${BEGIN("RSA ")}\n${pick(B62, 64)}\n${END("EC ")} b ${END()} c`);
    expect(r.findings).toEqual(["private_key"]);
    expect(r.text).toMatch(/^a \[SECRET_REDACTED:private_key:[0-9a-f]{8}\] b -----END PRIVATE KEY----- c$/);
  });
  it("an END exactly 16,384 characters after the header is inside the block; one further is not", () => {
    // Lower-case letters only: no other rule's prefix can appear in the filler.
    const filler = (n: number) => pick("abcdefghijklmnopqrstuvwxyz \n", n);
    const inside = redact(`${BEGIN()}${filler(16_384)}${END()}!`);
    expect(inside.text).toMatch(/^\[SECRET_REDACTED:private_key:[0-9a-f]{8}\]!$/);
    const far = filler(16_385);
    const outside = redact(`${BEGIN()}${far}${END()}!`);
    expect(outside.findings).toEqual(["private_key"]);
    expect(outside.text).toMatch(/^\[SECRET_REDACTED:private_key:[0-9a-f]{8}\]/);
    expect(outside.text.endsWith(`${far}${END()}!`)).toBe(true);
  });
  it("two headers before one END are one block", () => {
    const r = redact(`${BEGIN()}\nAAA\n${BEGIN("EC ")}\nBBB\n${END()}`);
    expect(r.findings).toEqual(["private_key"]);
  });
  it("a header right before an END's dashes, then a later END", () => {
    // `…KEY-----END PRIVATE KEY-----` shares its dashes with the header, so the regex
    // never saw an END there; the block runs to the next one.
    const r = redact(`${BEGIN()}END PRIVATE KEY----- mid ${END()} tail`);
    expect(r.findings).toEqual(["private_key"]);
    expect(r.text).toMatch(/^\[SECRET_REDACTED:private_key:[0-9a-f]{8}\] tail$/);
  });
  it("a header after a block that ended starts its own", () => {
    const r = redact(`${BEGIN()}\nA\n${END()} ${BEGIN()} ${pick(B62, 10)}`);
    expect(r.findings).toEqual(["private_key", "private_key"]);
  });
  it("an earlier rule's key inside a block wins the overlap, as it always has", () => {
    // The private-key rule is last, and a later rule's match that overlaps an earlier
    // one's is dropped. So the key inside is redacted and the block is not. Kept as is
    // by B3, which changes how fast, never what.
    const aws = KEYS.aws();
    const r = redact(`${BEGIN()}\n${aws}\n${END()} ${aws}`);
    expect(r.findings).toEqual(["aws", "aws"]);
    expect(r.text.startsWith(BEGIN())).toBe(true);
  });
});

describe("createSecretWatchStream (a streamed answer, end to end)", () => {
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  async function run(chunks: string[]) {
    const seen: string[][] = [];
    const watch = createSecretWatchStream((kinds) => seen.push(kinds));
    const enc = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    let out = "";
    const reader = source.pipeThrough(watch).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return { out, seen };
  }

  it("finds a key Claude wrote across many text deltas, and passes every byte through unchanged", async () => {
    const k = KEYS.anthropic();
    const events = [sse({ type: "message_start", message: { usage: { input_tokens: 1 } } })];
    for (let i = 0; i < k.length; i += 5) events.push(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: k.slice(i, i + 5) } }));
    events.push(sse({ type: "message_stop" }));
    // Split the bytes at awkward places too.
    const joined = events.join("");
    const chunks = [joined.slice(0, 37), joined.slice(37, 300), joined.slice(300)];
    const { out, seen } = await run(chunks);
    expect(out).toBe(joined);
    expect(seen).toEqual([["anthropic"]]);
  });

  it("finds one in tool input JSON (Claude) and in an OpenAI chat delta", async () => {
    const gh = KEYS.github();
    const half = Math.floor(gh.length / 2);
    const { seen } = await run([
      sse({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: `{"cmd":"export T=${gh.slice(0, half)}` } }),
      sse({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: `${gh.slice(half)}"}` } }),
      sse({ choices: [{ delta: { content: `and ${KEYS.aws()} too` } }] }),
      "data: [DONE]\n\n",
    ]);
    expect(seen).toEqual([["github", "aws"]]);
  });

  it("reports nothing for an ordinary answer", async () => {
    const { seen } = await run([sse({ type: "content_block_delta", delta: { type: "text_delta", text: "hello world" } })]);
    expect(seen).toEqual([]);
  });
});
