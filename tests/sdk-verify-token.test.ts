import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { publicJwk } from "@/lib/crypto/instanceKey";
import { AGENT_TOKEN_TYP, RECEIPT_TYP, signCompactJws } from "@/lib/crypto/jws";
import { verifyAgentToken } from "@/sdk/verify";

const SEED = new Uint8Array(32).fill(7);
const JWK = publicJwk(ed25519.getPublicKey(SEED));
const ISSUER = "https://gw.example.com";
const AUDIENCE = "billing-service";
const NOW = 1_800_000_000_000;

function mint(overrides: Record<string, unknown> = {}, typ = AGENT_TOKEN_TYP) {
  return signCompactJws({
    typ,
    kid: JWK.kid,
    seed: SEED,
    claims: {
      iss: ISSUER,
      sub: "cGFzc3BvcnQ",
      aud: AUDIENCE,
      jti: "token-1",
      iat: Math.floor(NOW / 1000) - 10,
      exp: Math.floor(NOW / 1000) + 300,
      agid: "agent-1",
      own: null,
      ver: 1,
      ...overrides,
    },
  });
}

const opts = (over: Record<string, unknown> = {}) => ({
  audience: AUDIENCE,
  trustedIssuers: [ISSUER],
  now: () => NOW,
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({ keys: [JWK] }) })) as never,
  ...over,
});

describe("verifying an agent token", () => {
  it("accepts a token minted for this audience by a trusted issuer", async () => {
    const result = await verifyAgentToken(mint(), opts());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("cGFzc3BvcnQ");
      // Returned so the verifier can dedupe: replay is explicitly their problem.
      expect(result.claims.jti).toBe("token-1");
    }
  });

  it("surfaces the owner so a counterparty knows whose agent this is", async () => {
    const own = { kind: "domain", sub: "acme.com", tier: "domain", vat: null };
    const result = await verifyAgentToken(mint({ own }), opts());

    expect(result.ok && result.claims.own).toEqual(own);
  });
});

describe("audience binding", () => {
  // A token is a statement to ONE counterparty. Accepting one minted for someone
  // else is the difference between authentication and a bearer free-for-all.
  it("rejects a token minted for a different audience", async () => {
    const result = await verifyAgentToken(mint({ aud: "payroll-service" }), opts());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_audience");
  });

  it("requires the verifier to say who it is", async () => {
    const result = await verifyAgentToken(mint(), opts({ audience: "" }));
    expect(result.ok).toBe(false);
  });

  it("matches the audience exactly, not by prefix", async () => {
    const result = await verifyAgentToken(mint({ aud: "billing" }), opts());
    expect(result.ok).toBe(false);
  });
});

describe("issuer trust", () => {
  it("rejects a validly signed token from an untrusted issuer", async () => {
    const result = await verifyAgentToken(mint(), opts({ trustedIssuers: ["https://other.com"] }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("untrusted_issuer");
  });

  // Cross-instance trust is "B's operator typed A's origin into a config file".
  // Loose matching there would let anyone who can register a lookalike domain
  // mint tokens B accepts.
  it.each([
    "https://gw.example.com.evil.com",
    "https://evil.com/?x=https://gw.example.com",
    "https://gw.example.com@evil.com",
  ])("does not accept lookalike issuer %s", async (iss) => {
    const token = signCompactJws({
      typ: AGENT_TOKEN_TYP,
      kid: JWK.kid,
      seed: SEED,
      claims: { iss, aud: AUDIENCE, ver: 1, exp: Math.floor(NOW / 1000) + 300 },
    });
    const result = await verifyAgentToken(token, opts());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("untrusted_issuer");
  });

  it("never trusts an empty issuer list", async () => {
    expect((await verifyAgentToken(mint(), opts({ trustedIssuers: [] }))).ok).toBe(false);
  });
});

describe("expiry", () => {
  it("rejects an expired token", async () => {
    const result = await verifyAgentToken(mint({ exp: Math.floor(NOW / 1000) - 1 }), opts());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a token with no expiry at all", async () => {
    const result = await verifyAgentToken(mint({ exp: undefined }), opts());
    expect(result.ok).toBe(false);
  });
});

describe("type separation", () => {
  // Receipts and agent tokens are signed by the same key. Without RFC 8725
  // explicit typing, a historical receipt would satisfy a live authentication
  // decision — a permanent, replayable credential.
  it("rejects a receipt presented as an agent token", async () => {
    const result = await verifyAgentToken(mint({}, RECEIPT_TYP), opts());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_type");
  });
});

describe("optional online revocation", () => {
  function fetchWith(jwks: unknown, status: unknown) {
    return (async (url: string) => {
      if (String(url).includes("jwks")) {
        return { ok: true, status: 200, json: async () => jwks };
      }
      return { ok: true, status: 200, json: async () => ({ data: { status } }) };
    }) as never;
  }

  it("does not call the issuer at all by default", async () => {
    let calls = 0;
    await verifyAgentToken(
      mint(),
      opts({
        fetch: (async () => {
          calls++;
          return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
        }) as never,
      })
    );
    // Exactly one: the JWKS. No liveness check unless asked for.
    expect(calls).toBe(1);
  });

  it("accepts an active passport when an online check is requested", async () => {
    const result = await verifyAgentToken(
      mint(),
      opts({ requireOnline: true, fetch: fetchWith({ keys: [JWK] }, "active") })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a revoked passport when an online check is requested", async () => {
    const result = await verifyAgentToken(
      mint(),
      opts({ requireOnline: true, fetch: fetchWith({ keys: [JWK] }, "revoked") })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  // An outage is not a revocation. Conflating them would make every issuer's
  // downtime look like a mass revocation to every verifier.
  it("distinguishes an unreachable issuer from a revocation", async () => {
    const result = await verifyAgentToken(
      mint(),
      opts({
        requireOnline: true,
        fetch: (async (url: string) => {
          if (String(url).includes("jwks")) {
            return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
          }
          return { ok: false, status: 503, json: async () => ({}) };
        }) as never,
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("status_unavailable");
  });
});

describe("signature integrity", () => {
  it("rejects a token signed by a key the issuer does not publish", async () => {
    const stranger = publicJwk(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
    const result = await verifyAgentToken(
      mint(),
      opts({
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ keys: [stranger] }),
        })) as never,
      })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects alg:none", async () => {
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url").replace(/=+$/, "");
    const token = `${b64({ alg: "none", typ: AGENT_TOKEN_TYP })}.${b64({
      iss: ISSUER,
      aud: AUDIENCE,
      ver: 1,
      exp: Math.floor(NOW / 1000) + 300,
    })}.`;

    expect((await verifyAgentToken(token, opts())).ok).toBe(false);
  });

  it.each(["", "abc", "a.b", "a.b.c.d"])("rejects malformed input (%s)", async (token) => {
    expect((await verifyAgentToken(token, opts())).ok).toBe(false);
  });
});
