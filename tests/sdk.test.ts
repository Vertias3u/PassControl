import { describe, it, expect, vi, beforeEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
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
    const headers = new Headers(init.headers);
    calls.proxy.push({ url, authorization: headers.get("authorization"), xApiKey: headers.get("x-api-key") });
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
});

describe("PassControl.clientOptions", () => {
  it("returns baseURL + fetch for the provider", () => {
    const opts = client().clientOptions("anthropic");
    expect(opts.baseURL).toBe(`${GATEWAY}/api/v1/anthropic`);
    expect(typeof opts.fetch).toBe("function");
    expect(opts.apiKey).toBeTruthy(); // placeholder; the fetch wrapper sets the real visa
  });
});
