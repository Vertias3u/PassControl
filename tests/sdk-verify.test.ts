import { describe, it, expect, beforeEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";
import { publicJwk } from "@/lib/crypto/instanceKey";
import { signReceipt } from "@/lib/receipt";
import { matchesIssuer, verifyReceipt } from "@/sdk/verify";

const SEED = new Uint8Array(32).fill(7);
const PUBLIC_KEY = ed25519.getPublicKey(SEED);
const ISSUER = "https://gw.example.com";
const JWK = publicJwk(PUBLIC_KEY);

const INPUT = {
  receiptId: "11111111-2222-4333-8444-555555555555",
  passportId: "cGFzc3BvcnQ",
  agentId: "agent-1",
  visaJti: "visa-1",
  provider: "openai",
  model: "gpt-4o-mini",
  method: "POST",
  path: "v1/chat/completions",
  rawBody: JSON.stringify({ model: "gpt-4o-mini" }),
  inputTokens: 3,
  outputTokens: 5,
  costMicrocents: 100,
  status: "ok" as const,
  httpStatus: 200,
  startedAt: 1_700_000_000_000,
  latencyMs: 12,
};

function jwksFetch(keys: unknown[] = [JWK], { ok = true } = {}) {
  return (async () => ({ ok, status: ok ? 200 : 404, json: async () => ({ keys }) })) as never;
}

const opts = (over: Record<string, unknown> = {}) => ({
  trustedIssuers: [ISSUER],
  fetch: jwksFetch(),
  ...over,
});

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(SEED);
  process.env.PASSCONTROL_ISSUER = ISSUER;
});

describe("verifying a genuine receipt", () => {
  it("accepts one the gateway actually signed", async () => {
    const result = await verifyReceipt(signReceipt(INPUT)!, opts());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.jti).toBe(INPUT.receiptId);
      expect(result.claims.use).toEqual({ in: 3, out: 5 });
      expect(result.claims.cost).toBe(100);
    }
  });

  it("fetches the key set from the issuer named in the token", async () => {
    let requested = "";
    await verifyReceipt(
      signReceipt(INPUT)!,
      opts({
        fetch: async (url: string) => {
          requested = String(url);
          return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
        },
      })
    );
    expect(requested).toBe(`${ISSUER}/.well-known/jwks.json`);
  });

  it("reuses a supplied JWKS cache instead of refetching", async () => {
    let calls = 0;
    const jwksCache = new Map();
    const fetchImpl = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    };
    const jws = signReceipt(INPUT)!;
    await verifyReceipt(jws, opts({ fetch: fetchImpl, jwksCache }));
    await verifyReceipt(jws, opts({ fetch: fetchImpl, jwksCache }));
    expect(calls).toBe(1);
  });
});

describe("algorithm confusion", () => {
  // THE test for this file. A verifier that reads `alg` from the token and
  // dispatches on it accepts both of these. The JWK's `x` is public key
  // material, so an HS256 MAC keyed on it is forgeable by anyone who can read
  // the JWKS — that is, anyone. Get this wrong and the signatures are theatre.
  it("rejects a token declaring alg:none", async () => {
    const header = bytesToBase64url(
      utf8ToBytes(JSON.stringify({ alg: "none", typ: "passcontrol-receipt+jwt" }))
    );
    const payload = bytesToBase64url(
      utf8ToBytes(JSON.stringify({ iss: ISSUER, ver: 1, jti: "x" }))
    );

    const result = await verifyReceipt(`${header}.${payload}.`, opts());
    expect(result.ok).toBe(false);
  });

  it("rejects an HS256 token MACed with the JWK's own public key material", async () => {
    const header = bytesToBase64url(
      utf8ToBytes(JSON.stringify({ alg: "HS256", typ: "passcontrol-receipt+jwt", kid: JWK.kid }))
    );
    const payload = bytesToBase64url(
      utf8ToBytes(JSON.stringify({ iss: ISSUER, ver: 1, jti: "forged", cost: 0 }))
    );
    const mac = hmac(sha256, PUBLIC_KEY, utf8ToBytes(`${header}.${payload}`));

    const result = await verifyReceipt(`${header}.${payload}.${bytesToBase64url(mac)}`, opts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });
});

describe("issuer trust", () => {
  it("rejects a validly signed receipt from an issuer that is not trusted", async () => {
    const result = await verifyReceipt(signReceipt(INPUT)!, opts({ trustedIssuers: ["https://other.example.com"] }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("untrusted_issuer");
  });

  it("never trusts an empty issuer list", async () => {
    const result = await verifyReceipt(signReceipt(INPUT)!, opts({ trustedIssuers: [] }));
    expect(result.ok).toBe(false);
  });

  // Substring and suffix matching are the classic issuer-confusion bugs.
  it.each([
    ["https://good.com.evil.com", "a suffix-style lookalike"],
    ["https://evil.com/?x=https://good.com", "a trusted origin inside a query string"],
    ["https://good.com@evil.com", "userinfo smuggling"],
    ["https://goodxcom", "a near-miss host"],
  ])("does not match %s against https://good.com (%s)", (candidate) => {
    expect(matchesIssuer(candidate, ["https://good.com"])).toBe(false);
  });

  it("tolerates only a trailing slash difference", () => {
    expect(matchesIssuer("https://good.com/", ["https://good.com"])).toBe(true);
    expect(matchesIssuer("https://good.com", ["https://good.com/"])).toBe(true);
  });
});

describe("tampering and transport", () => {
  it("rejects a receipt whose cost was altered after signing", async () => {
    const [header, payload, signature] = signReceipt(INPUT)!.split(".");
    const claims = JSON.parse(new TextDecoder().decode(Buffer.from(payload!, "base64url")));
    const forged = bytesToBase64url(utf8ToBytes(JSON.stringify({ ...claims, cost: 1 })));

    const result = await verifyReceipt(`${header}.${forged}.${signature}`, opts());
    expect(result.ok).toBe(false);
  });

  it("rejects a receipt signed by a key the issuer does not publish", async () => {
    const strangerJwk = publicJwk(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
    const result = await verifyReceipt(signReceipt(INPUT)!, opts({ fetch: jwksFetch([strangerJwk]) }));

    expect(result.ok).toBe(false);
  });

  it("reports an unreachable JWKS distinctly from a bad signature", async () => {
    const result = await verifyReceipt(signReceipt(INPUT)!, opts({ fetch: jwksFetch([], { ok: false }) }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jwks_unreachable");
  });

  it.each(["", "abc", "a.b", "a.b.c.d"])("rejects malformed input (%s)", async (token) => {
    const result = await verifyReceipt(token, opts());
    expect(result.ok).toBe(false);
  });

  it("rejects an agent token presented as a receipt", async () => {
    const [, payload, signature] = signReceipt(INPUT)!.split(".");
    const header = bytesToBase64url(
      utf8ToBytes(JSON.stringify({ alg: "EdDSA", typ: "passcontrol-agent+jwt", kid: JWK.kid }))
    );

    const result = await verifyReceipt(`${header}.${payload}.${signature}`, opts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_type");
  });
});

describe("forward compatibility", () => {
  // Phase 2 adds an `own` claim. Every verifier already deployed in the field
  // must keep working — that is the whole reason receipts are versioned
  // additively rather than with the visa's strict equality check.
  it("accepts a receipt carrying a claim this verifier has never heard of", async () => {
    const jws = signReceipt({ ...INPUT, owner: { kind: "domain", sub: "acme.com", tier: "domain", vat: null } })!;
    const result = await verifyReceipt(jws, opts());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.own).toMatchObject({ sub: "acme.com" });
  });

  it("refuses an artifact from a future version it cannot fully interpret", async () => {
    const [, , signature] = signReceipt(INPUT)!.split(".");
    const header = bytesToBase64url(
      utf8ToBytes(JSON.stringify({ alg: "EdDSA", typ: "passcontrol-receipt+jwt", kid: JWK.kid }))
    );
    const payload = bytesToBase64url(utf8ToBytes(JSON.stringify({ iss: ISSUER, ver: 99 })));

    const result = await verifyReceipt(`${header}.${payload}.${signature}`, opts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_version");
  });
});

describe("a receipt from a failover chain", () => {
  const CHAINED = {
    ...INPUT,
    receiptId: "99999999-2222-4333-8444-555555555555",
    previousReceiptId: INPUT.receiptId,
    failoverReason: "upstream_5xx",
  };

  it("verifies, and hands the chain claims through", async () => {
    const result = await verifyReceipt(signReceipt(CHAINED)!, opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.prev).toBe(INPUT.receiptId);
      expect(result.claims.why).toBe("upstream_5xx");
    }
  });

  // The reason `ver` stays 1. A verifier already deployed in the field refuses
  // anything newer than it knows (SUPPORTED_VER), so bumping the version to add
  // two optional claims would invalidate every existing verifier for a feature
  // none of them need to understand.
  it("does not bump the version, so older verifiers still accept it", async () => {
    const result = await verifyReceipt(signReceipt(CHAINED)!, opts());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.ver).toBe(1);
  });

  it("carries the same request digest as the attempt it replaced", async () => {
    // Both attempts digest the bytes the CLIENT sent, which do not change. That
    // is exactly why the link has to be explicit: matching two receipts by a
    // shared digest would be a guess, `prev` is a statement.
    const first = await verifyReceipt(signReceipt(INPUT)!, opts());
    const second = await verifyReceipt(signReceipt(CHAINED)!, opts());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.claims.req).toEqual(first.claims.req);
      expect(second.claims.jti).not.toBe(first.claims.jti);
    }
  });

  it("omits both claims on a call that never failed over", async () => {
    const result = await verifyReceipt(signReceipt(INPUT)!, opts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Absent, not null: presence alone must mean "this attempt followed
      // another", with no second reading needed to tell them apart.
      expect("prev" in result.claims).toBe(false);
      expect("why" in result.claims).toBe(false);
    }
  });
});
