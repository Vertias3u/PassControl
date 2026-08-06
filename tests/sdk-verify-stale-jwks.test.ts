// A stale key list must never be allowed to call a genuine receipt forged.
//
// The JWKS route ships `public, max-age=300, stale-while-revalidate=86400`, so a
// browser may hold a key list up to a day old. The moment that matters is a key
// rotation — which is exactly the event INSTANCE_SIGNING_KEY_PREV exists to make
// safe. _PREV keeps the OLD public key published so old receipts still verify;
// but a reader whose cache predates the rotation is missing the NEW key, so a
// brand-new, perfectly genuine receipt resolves to `unknown_key`.
//
// `unknown_key` is presented as kind "forged" — "The issuer does not publish this
// signing key", red rail, "Do not rely on this". So an HTTP cache alone could
// make the page accuse an honest issuer. This was reproduced by accident on
// 2026-08-06: the dev server briefly served `{"keys":[]}`, the browser cached it,
// and a receipt that had verified 8/8 minutes earlier started failing at `key`.
//
// The rule the whole page runs on, applied one layer down: do not accuse until
// you have actually looked. Before concluding `unknown_key`, go back to the
// origin once, bypassing the cache.
import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { verifyReceipt, type VerifyStep } from "@/sdk/verify";

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const ISSUER = "https://issuer.test";
const OLD_SEED = new Uint8Array(32).fill(7);
const NEW_SEED = new Uint8Array(32).fill(9);

const jwk = (seed: Uint8Array, kid: string) => ({
  kty: "OKP",
  crv: "Ed25519",
  x: b64url(ed25519.getPublicKey(seed)),
  kid,
});

const CLAIMS = {
  iss: ISSUER,
  sub: "passport",
  jti: "receipt-1",
  iat: 1785958835,
  agid: "agent-1",
  vjti: "visa-1",
  prov: "demo",
  mdl: "demo-1",
  mth: "POST",
  path: "chat/completions",
  use: { in: 15, out: 46 },
  cost: 61,
  res: { status: "ok", http: 200 },
  t0: 1785958835348,
  lat: 60,
  ver: 1,
};

/** Signed with the NEW key, as any receipt minted after a rotation would be. */
function signWithNewKey(): string {
  const h = b64url(JSON.stringify({ alg: "EdDSA", typ: "passcontrol-receipt+jwt", kid: "k2" }));
  const p = b64url(JSON.stringify(CLAIMS));
  return `${h}.${p}.${b64url(ed25519.sign(new TextEncoder().encode(`${h}.${p}`), NEW_SEED))}`;
}

const RECEIPT = signWithNewKey();

/**
 * Models a browser HTTP cache in front of the issuer: the default request is
 * answered from a key list captured before the rotation; only a request that
 * explicitly bypasses the cache reaches the origin.
 */
function staleCachingFetch() {
  const seen: (string | undefined)[] = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    const bypassing = init?.cache === "no-cache" || init?.cache === "reload";
    seen.push(init?.cache);
    const keys = bypassing
      ? [jwk(OLD_SEED, "k1"), jwk(NEW_SEED, "k2")] // origin: both, mid-rotation
      : [jwk(OLD_SEED, "k1")]; // cache: pre-rotation snapshot
    return new Response(JSON.stringify({ keys }), { status: 200 });
  });
  return { impl, seen };
}

const run = (fetchImpl: unknown, extra: Record<string, unknown> = {}) => {
  const steps: VerifyStep[] = [];
  return verifyReceipt(RECEIPT, {
    trustedIssuers: [ISSUER],
    fetch: fetchImpl as typeof fetch,
    onStep: (s) => steps.push(s),
    ...extra,
  }).then((result) => ({ result, steps }));
};

describe("a stale key list cannot make a genuine receipt look forged", () => {
  it("revalidates against the origin before concluding unknown_key", async () => {
    const { impl, seen } = staleCachingFetch();
    const { result } = await run(impl);

    // Without the retry this is { ok: false, reason: "unknown_key" } — rendered
    // as "Do not rely on this" against a receipt the issuer really did sign.
    expect(result.ok).toBe(true);
    // Exactly two requests: the cheap one, then one that bypasses the cache.
    expect(impl).toHaveBeenCalledTimes(2);
    expect(seen[1]).toBe("no-cache");
  });

  it("does not pay for a second request when the first list already matches", async () => {
    const impl = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [jwk(NEW_SEED, "k2")] }), { status: 200 })
    );
    const { result } = await run(impl);

    expect(result.ok).toBe(true);
    // The common case must stay a single fetch: the retry is the price of an
    // accusation, not of verification.
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("still reports unknown_key when the origin genuinely lacks the key", async () => {
    const impl = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [jwk(OLD_SEED, "k1")] }), { status: 200 })
    );
    const { result } = await run(impl);

    // The retry must not become a way to launder a real failure into a pass.
    expect(result).toEqual({ ok: false, reason: "unknown_key" });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("reports unknown_key, not jwks_unreachable, if the revalidation fails", async () => {
    let call = 0;
    const impl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ keys: [jwk(OLD_SEED, "k1")] }), { status: 200 });
      }
      throw new Error("network down");
    });
    const { result, steps } = await run(impl);

    // We DID reach the issuer once and DID look at a key list. Downgrading to
    // "could not reach" would misdescribe what happened; the honest answer is
    // that the key we were given does not cover this receipt.
    expect(result).toEqual({ ok: false, reason: "unknown_key" });
    expect(steps.at(-1)!.step).toBe("key");
  });

  it("refreshes a caller-supplied jwksCache rather than leaving it stale", async () => {
    const { impl } = staleCachingFetch();
    const jwksCache = new Map<string, unknown[]>();
    const { result } = await run(impl, { jwksCache });

    expect(result.ok).toBe(true);
    // A cache that kept the pre-rotation list would make the NEXT verification
    // fail without even reaching the network.
    expect((jwksCache.get(ISSUER) as { kid: string }[]).map((k) => k.kid)).toContain("k2");
  });

  it("emits one jwks step, not two — the trace shows checks, not retries", async () => {
    const { impl } = staleCachingFetch();
    const { steps } = await run(impl);

    expect(steps.filter((s) => s.step === "jwks")).toHaveLength(1);
    expect(steps.map((s) => s.step)).toEqual([
      "parse",
      "algorithm",
      "type",
      "issuer",
      "version",
      "jwks",
      "key",
      "signature",
    ]);
  });
});
