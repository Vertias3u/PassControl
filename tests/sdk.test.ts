import { describe, it, expect, vi, beforeEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { endpointAllows } from "../lib/scope";
import type { ProviderId } from "../lib/providers";
import { PassControl } from "../sdk/passcontrol";

// --- test passport keypair ---------------------------------------------------
const sk = ed25519.utils.randomPrivateKey();
const pk = ed25519.getPublicKey(sk);
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const PASSPORT_ID = b64url(pk);
const PASSPORT_SECRET = b64url(sk);
const GATEWAY = "https://gw.example.com";

// Mock transport: route challenge vs proxied calls. Captures the last request to
// each so tests can assert signatures/headers. `proxyStatus` lets a test force a 401.
function makeFetch(opts: { proxyStatus?: () => number; expiresIn?: number } = {}) {
  const calls = { challenge: [] as any[], proxy: [] as any[] };
  let visaSeq = 0;
  const fn = vi.fn(async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/auth/challenge")) {
      calls.challenge.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          visa: `visa-${++visaSeq}`,
          token_type: "Bearer",
          expires_in: opts.expiresIn ?? 300,
          jti: "j",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    const request = input instanceof Request ? input : null;
    const headers = new Headers(init.headers ?? request?.headers);
    calls.proxy.push({
      url,
      authorization: headers.get("authorization"),
      xApiKey: headers.get("x-api-key"),
      method: init.method ?? request?.method,
      body: init.body ?? (request ? await request.text() : undefined),
    });
    return new Response("{}", { status: opts.proxyStatus ? opts.proxyStatus() : 200 });
  });
  return { fn, calls };
}

let mock: ReturnType<typeof makeFetch>;
beforeEach(() => {
  mock = makeFetch();
});
const client = (extra: any = {}) =>
  new PassControl({ gateway: GATEWAY, passportId: PASSPORT_ID, passportSecret: PASSPORT_SECRET, fetch: mock.fn, ...extra });

describe("PassControl.getVisa — minting", () => {
  it("signs a valid challenge the gateway can verify", async () => {
    const visa = await client().getVisa();
    expect(visa).toBe("visa-1");
    expect(mock.calls.challenge).toHaveLength(1);
    const { payload, signature } = mock.calls.challenge[0];
    expect(JSON.stringify(mock.calls.challenge[0])).not.toContain(PASSPORT_SECRET);
    // Signature must verify against the passport public key over the payload bytes.
    expect(ed25519.verify(fromB64url(signature), fromB64url(payload), pk)).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    expect(claims.passport_id).toBe(PASSPORT_ID);
    expect(typeof claims.ts).toBe("number");
    expect(typeof claims.nonce).toBe("string");
  });

  it("caches the visa and does not re-mint while it is fresh", async () => {
    const c = client();
    await c.getVisa();
    await c.getVisa();
    expect(mock.calls.challenge).toHaveLength(1);
  });

  it("re-mints when the visa is within the refresh skew of expiry", async () => {
    // expires_in 300s but skew 400s => always considered near-expiry => re-mint.
    const c = client({ refreshSkewSeconds: 400 });
    expect(await c.getVisa()).toBe("visa-1");
    expect(await c.getVisa()).toBe("visa-2");
    expect(mock.calls.challenge).toHaveLength(2);
  });

  it("single-flights concurrent mints into one challenge call", async () => {
    const c = client();
    const [a, b] = await Promise.all([c.getVisa(), c.getVisa()]);
    expect(a).toBe(b);
    expect(mock.calls.challenge).toHaveLength(1);
  });
});

describe("PassControl.fetch — drop-in transport", () => {
  it("refuses to attach a visa outside the configured gateway", async () => {
    const c = client();
    await expect(c.fetch("https://attacker.example/api/v1/openai/chat/completions")).rejects.toThrow("refusing to send a visa");
    await expect(c.fetch(`${GATEWAY}/api/auth/challenge`)).rejects.toThrow("refusing to send a visa");
    // URL.origin ignores userinfo, so the origin comparison alone lets this through.
    // The constructor already rejects credentials in the gateway; the transport has
    // to reject them too, rather than leaving it to whichever platform Request throws.
    await expect(c.fetch("https://a:b@gw.example.com/api/v1/openai/chat/completions"))
      .rejects.toThrow("refusing to send a visa");
    expect(mock.calls.challenge).toHaveLength(0);
    expect(mock.calls.proxy).toHaveLength(0);
  });
  it("injects Authorization: Bearer <visa> and strips x-api-key", async () => {
    const c = client();
    await c.fetch(`${GATEWAY}/api/v1/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "should-be-removed", "content-type": "application/json" },
      body: "{}",
    });
    expect(mock.calls.proxy).toHaveLength(1);
    expect(mock.calls.proxy[0].authorization).toBe("Bearer visa-1");
    expect(mock.calls.proxy[0].xApiKey).toBeNull();
  });

  it("preserves Request method and body while replacing its credential", async () => {
    const c = client();
    await c.fetch(new Request(`${GATEWAY}/api/v1/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "should-be-removed", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5" }),
    }));
    expect(mock.calls.proxy[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5" }),
      authorization: "Bearer visa-1",
      xApiKey: null,
    });
  });

  it("re-mints once and retries on a 401 (expired/rejected visa)", async () => {
    let n = 0;
    mock = makeFetch({ proxyStatus: () => (++n === 1 ? 401 : 200) });
    const c = client();
    const res = await c.fetch(`${GATEWAY}/api/v1/openai/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(mock.calls.challenge).toHaveLength(2); // initial mint + re-mint after 401
    expect(mock.calls.proxy).toHaveLength(2);
    expect(mock.calls.proxy[1].authorization).toBe("Bearer visa-2");
  });

  it("retries a Request body from an unread clone after a 401", async () => {
    let n = 0;
    mock = makeFetch({ proxyStatus: () => (++n === 1 ? 401 : 200) });
    const c = client();
    const body = JSON.stringify({ model: "gpt-5-mini" });
    const res = await c.fetch(new Request(`${GATEWAY}/api/v1/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    expect(res.status).toBe(200);
    expect(mock.calls.proxy.map((call) => call.body)).toEqual([body, body]);
  });

  // A `Request` input survives a retry because clone() tees its stream. A stream
  // passed through `init.body` has no such copy: the first attempt consumes it, so
  // replaying it either throws a platform TypeError or silently sends nothing.
  // Surfacing the gateway's 401 is the only honest option.
  it("does not retry a 401 when init.body cannot be replayed", async () => {
    let n = 0;
    mock = makeFetch({ proxyStatus: () => (++n === 1 ? 401 : 200) });
    const c = client();
    const res = await c.fetch(`${GATEWAY}/api/v1/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: "gpt-5-mini" })));
          controller.close();
        },
      }),
      // Required by undici for a streamed request body; absent from lib.dom's RequestInit.
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(401);
    expect(mock.calls.proxy).toHaveLength(1);
    // The rejected visa is still dropped, so the NEXT call mints a fresh one.
    expect(await c.getVisa()).toBe("visa-2");
  });

  // A `Request` input is NOT replay-safe by itself. `send()` passes
  // `{ ...init, headers }` alongside the cloned template, and a non-null `init.body`
  // there is the body fetch actually sends — the clone's teed copy is overridden and
  // never read. So this is the unrepeatable-stream case wearing a Request, and it must
  // be refused for the same reason: the second attempt would send a consumed stream.
  it("does not retry a 401 when an unrepeatable init.body overrides the Request input", async () => {
    let n = 0;
    mock = makeFetch({ proxyStatus: () => (++n === 1 ? 401 : 200) });
    const c = client();
    const res = await c.fetch(
      new Request(`${GATEWAY}/api/v1/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5-mini" }),
      }),
      {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: "gpt-5-mini" })));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit
    );
    expect(res.status).toBe(401);
    expect(mock.calls.proxy).toHaveLength(1);
    // Nothing replaced this response, so nothing may have cancelled its body — it is
    // still the caller's to read. (Not decoration: `body.cancel()` flips bodyUsed to
    // true and makes text() throw "Body is unusable", so moving the cleanup outside
    // the canReplay branch would fail right here.)
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("{}");
    // The rejected visa is still dropped, so the NEXT call mints a fresh one.
    expect(await c.getVisa()).toBe("visa-2");
  });

  it("still retries when a replayable init.body overrides the Request input", async () => {
    let n = 0;
    mock = makeFetch({ proxyStatus: () => (++n === 1 ? 401 : 200) });
    const c = client();
    const override = JSON.stringify({ model: "gpt-5-nano" });
    const res = await c.fetch(
      new Request(`${GATEWAY}/api/v1/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5-mini" }),
      }),
      { body: override }
    );
    expect(res.status).toBe(200);
    // Both attempts send the OVERRIDE, not the template's own body.
    expect(mock.calls.proxy.map((call) => call.body)).toEqual([override, override]);
  });

  it("retries a streamed Request body from the clone's tee when init does not override it", async () => {
    let n = 0;
    mock = makeFetch({ proxyStatus: () => (++n === 1 ? 401 : 200) });
    const c = client();
    const body = JSON.stringify({ model: "gpt-5-mini" });
    const res = await c.fetch(
      new Request(`${GATEWAY}/api/v1/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit)
    );
    expect(res.status).toBe(200);
    expect(mock.calls.proxy.map((call) => call.body)).toEqual([body, body]);
  });

  it("still retries a 401 for every replayable init.body shape", async () => {
    for (const body of [
      undefined,
      JSON.stringify({ model: "gpt-5-mini" }),
      new TextEncoder().encode("bytes"),
      new URLSearchParams({ model: "gpt-5-mini" }),
    ]) {
      let n = 0;
      mock = makeFetch({ proxyStatus: () => (++n === 1 ? 401 : 200) });
      const res = await client().fetch(`${GATEWAY}/api/v1/openai/v1/chat/completions`, {
        method: "POST",
        body,
      } as RequestInit);
      expect(res.status).toBe(200);
      expect(mock.calls.proxy).toHaveLength(2);
    }
  });
});

describe("PassControl constructor boundary", () => {
  it("requires a bare HTTPS origin and valid key sizes before network access", () => {
    expect(() => client({ gateway: "http://gw.example.com" })).toThrow("bare HTTPS origin");
    expect(() => client({ gateway: "https://gw.example.com/path" })).toThrow("bare HTTPS origin");
    expect(() => client({ passportSecret: "bad" })).toThrow("encode 32 bytes");
    expect(() => client({ passportId: "bad" })).toThrow("encode 32 bytes");
    expect(() => client({ gateway: "http://127.0.0.1:8788" })).not.toThrow();
  });
});

describe("PassControl.clientOptions", () => {
  it("returns baseURL + fetch for the provider", () => {
    const opts = client().clientOptions("anthropic");
    expect(opts.baseURL).toBe(`${GATEWAY}/api/v1/anthropic`);
    expect(typeof opts.fetch).toBe("function");
    expect(opts.apiKey).toBeTruthy(); // placeholder; the fetch wrapper sets the real visa
  });
  it("returns baseURL for OpenAI-compatible providers", () => {
    expect(client().clientOptions("groq").baseURL).toBe(`${GATEWAY}/api/v1/groq`);
    expect(client().clientOptions("deepseek").baseURL).toBe(`${GATEWAY}/api/v1/deepseek`);
  });
  it.each([
    ["openai", "chat/completions", "POST"],
    ["openai", "models", "GET"],
    ["groq", "chat/completions", "POST"],
    ["mistral", "chat/completions", "POST"],
    ["together", "chat/completions", "POST"],
    ["anthropic", "v1/messages", "POST"],
    ["deepseek", "chat/completions", "POST"],
  ] as const)("produces an allowlisted route for %s SDK path %s", (provider, sdkPath, method) => {
    const { baseURL } = client().clientOptions(provider);
    const url = new URL(sdkPath, `${baseURL}/`);
    const segments = url.pathname.split("/").filter(Boolean);

    expect(segments.slice(0, 2)).toEqual(["api", "v1"]);
    expect(segments[2]).toBe(provider);
    expect(endpointAllows(provider as ProviderId, method, segments.slice(3))).toBe(true);
  });
});
