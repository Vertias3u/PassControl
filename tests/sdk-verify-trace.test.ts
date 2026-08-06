import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { verifyReceipt, type VerifyStep, type VerifyStepName } from "@/sdk/verify";

// The trace hook exists so the public verification page can SHOW the checks it
// runs. That is only worth doing if the steps shown are the steps that actually
// ran — so the hook lives in the verifier itself rather than being re-derived by
// the page. A second implementation would drift, and a green result on our page
// would stop meaning a green result on someone else's machine.
//
// Everything here defends two properties: the hook changes no outcome, and the
// trace is a faithful record of the real gate order.

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const ISSUER = "https://issuer.test";
const SEED = new Uint8Array(32).fill(7);
const PUBLIC_KEY = ed25519.getPublicKey(SEED);

function sign(header: object, claims: object): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  return `${h}.${p}.${b64url(ed25519.sign(new TextEncoder().encode(`${h}.${p}`), SEED))}`;
}

const CLAIMS = {
  iss: ISSUER,
  sub: "passport",
  jti: "receipt-1",
  iat: 1785925292,
  agid: "agent-1",
  vjti: "visa-1",
  prov: "anthropic",
  mdl: "claude-sonnet-4-5",
  mth: "POST",
  path: "v1/messages",
  use: { in: 0, out: 0 },
  cost: 0,
  res: { status: "blocked_scope", http: 403 },
  t0: 1785925292026,
  lat: 22,
  ver: 1,
};

const HEADER = { alg: "EdDSA", typ: "passcontrol-receipt+jwt", kid: "k1" };
const GOOD = sign(HEADER, CLAIMS);

const jwksFetch = (keys: unknown[] = [{ kty: "OKP", crv: "Ed25519", x: b64url(PUBLIC_KEY), kid: "k1" }]) =>
  vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200 }));

const opts = (extra: Record<string, unknown> = {}) => ({
  trustedIssuers: [ISSUER],
  fetch: jwksFetch() as unknown as typeof fetch,
  ...extra,
});

function collect() {
  const steps: VerifyStep[] = [];
  return { steps, onStep: (s: VerifyStep) => steps.push(s) };
}

describe("the trace never changes the answer", () => {
  it("verifies a good receipt identically with and without a hook", async () => {
    const withoutHook = await verifyReceipt(GOOD, opts());
    const { onStep } = collect();
    const withHook = await verifyReceipt(GOOD, opts({ onStep }));

    expect(withoutHook).toEqual(withHook);
    expect(withHook.ok).toBe(true);
  });

  it("rejects a forgery identically with and without a hook", async () => {
    const forged = `${GOOD.split(".")[0]}.${b64url(
      JSON.stringify({ ...CLAIMS, cost: 999999 })
    )}.${GOOD.split(".")[2]}`;

    const withoutHook = await verifyReceipt(forged, opts());
    const { onStep } = collect();
    const withHook = await verifyReceipt(forged, opts({ onStep }));

    expect(withoutHook).toEqual(withHook);
    expect(withHook).toEqual({ ok: false, reason: "bad_signature" });
  });

  // A consumer's broken callback is a UI bug. It must never become a
  // verification failure — the same reason safeReceipt wraps signReceipt in the
  // proxy: a governance answer may not depend on a presentation path behaving.
  it("survives an onStep that throws on every call", async () => {
    const result = await verifyReceipt(
      GOOD,
      opts({
        onStep: () => {
          throw new Error("consumer bug");
        },
      })
    );
    expect(result.ok).toBe(true);
  });
});

describe("the trace records the real gate order", () => {
  it("reports every check in order for a receipt that passes", async () => {
    const { steps, onStep } = collect();
    await verifyReceipt(GOOD, opts({ onStep }));

    expect(steps.map((s) => s.step)).toEqual([
      "parse",
      "algorithm",
      "type",
      "issuer",
      "version",
      "jwks",
      "key",
      "signature",
    ] satisfies VerifyStepName[]);
    expect(steps.every((s) => s.ok)).toBe(true);
  });

  it("measures each step, without inventing durations", async () => {
    const { steps, onStep } = collect();
    await verifyReceipt(GOOD, opts({ onStep }));
    for (const step of steps) {
      expect(step.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(step.ms)).toBe(true);
    }
  });

  // The page renders un-run checks as "not reached", which is the difference
  // between "the signature is forged" and "we never got as far as looking at the
  // signature". That distinction is only true if the trace really does stop.
  it.each([
    ["not a compact JWS", "abc", "parse", 1],
    [
      "alg is not EdDSA",
      sign({ alg: "HS256", typ: "passcontrol-receipt+jwt" }, CLAIMS),
      "algorithm",
      2,
    ],
    [
      "typed as an agent token",
      sign({ alg: "EdDSA", typ: "passcontrol-agent+jwt" }, CLAIMS),
      "type",
      3,
    ],
    [
      "issuer is not trusted",
      sign(HEADER, { ...CLAIMS, iss: "https://evil.test" }),
      "issuer",
      4,
    ],
    ["signed by a newer version", sign(HEADER, { ...CLAIMS, ver: 99 }), "version", 5],
  ])("stops at the first failure: %s", async (_label, token, failedAt, length) => {
    const { steps, onStep } = collect();
    await verifyReceipt(token, opts({ onStep }));

    expect(steps).toHaveLength(length);
    expect(steps.at(-1)!.step).toBe(failedAt);
    expect(steps.at(-1)!.ok).toBe(false);
    expect(steps.slice(0, -1).every((s) => s.ok)).toBe(true);
  });

  it("carries the same reason the caller receives", async () => {
    const { steps, onStep } = collect();
    const result = await verifyReceipt(
      sign(HEADER, { ...CLAIMS, iss: "https://evil.test" }),
      opts({ onStep })
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("untrusted_issuer");
    expect(steps.at(-1)!.reason).toBe("untrusted_issuer");
  });

  it("marks the jwks step failed when the key set cannot be fetched", async () => {
    const { steps, onStep } = collect();
    await verifyReceipt(
      GOOD,
      opts({ onStep, fetch: vi.fn(async () => new Response("nope", { status: 404 })) })
    );

    expect(steps.at(-1)).toMatchObject({ step: "jwks", ok: false, reason: "jwks_unreachable" });
  });

  it("marks the key step failed when the issuer publishes no matching kid", async () => {
    const { steps, onStep } = collect();
    await verifyReceipt(
      GOOD,
      opts({
        onStep,
        fetch: jwksFetch([
          { kty: "OKP", crv: "Ed25519", x: b64url(ed25519.getPublicKey(new Uint8Array(32).fill(9))), kid: "other" },
        ]) as unknown as typeof fetch,
      })
    );

    expect(steps.at(-1)).toMatchObject({ step: "key", ok: false, reason: "unknown_key" });
  });
});
