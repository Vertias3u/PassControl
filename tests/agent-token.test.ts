import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";

const h = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  claimNonceMock: vi.fn(),
  touchLastSeenMock: vi.fn(),
  maybeSingleMock: vi.fn(),
  readCurrentOwnerMock: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...a: unknown[]) => h.rateLimitMock(...a) }));
vi.mock("@/lib/state/redis", () => ({
  claimNonce: (...a: unknown[]) => h.claimNonceMock(...a),
  touchLastSeen: (...a: unknown[]) => h.touchLastSeenMock(...a),
}));
vi.mock("@/lib/owner/current", () => ({
  readCurrentOwner: (...a: unknown[]) => h.readCurrentOwnerMock(...a),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => {
    const b: any = { select: () => b, eq: () => b, maybeSingle: () => h.maybeSingleMock() };
    return { from: () => b };
  },
}));

import { POST } from "@/app/api/auth/agent-token/route";
import { AGENT_TOKEN_TYP, verifyCompactJws } from "@/lib/crypto/jws";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";

const AGENT_SEED = ed25519.utils.randomPrivateKey();
const PASSPORT_ID = bytesToBase64url(ed25519.getPublicKey(AGENT_SEED));
const INSTANCE_SEED = bytesToBase64url(new Uint8Array(32).fill(7));
const ISSUER = "https://gw.example.com";

function signedRequest(
  overrides: Record<string, unknown> = {},
  { tamper }: { tamper?: (payload: Record<string, unknown>) => Record<string, unknown> } = {}
) {
  const payload = {
    passport_id: PASSPORT_ID,
    ts: Date.now(),
    nonce: crypto.randomUUID(),
    aud: "billing-service",
    ...overrides,
  };
  // Signed over the raw JSON bytes, then base64url'd for transport — the same
  // canonicalisation sdk/passcontrol.ts uses for the challenge.
  const payloadBytes = utf8ToBytes(JSON.stringify(payload));
  const signature = bytesToBase64url(ed25519.sign(payloadBytes, AGENT_SEED));

  // Tampering re-encodes the payload but keeps the ORIGINAL signature — exactly
  // what an attacker on the path can do.
  const sent = bytesToBase64url(
    tamper ? utf8ToBytes(JSON.stringify(tamper(payload))) : payloadBytes
  );

  return new Request("https://gw.example.com/api/auth/agent-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: sent, signature }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INSTANCE_SIGNING_KEY = INSTANCE_SEED;
  process.env.PASSCONTROL_ISSUER = ISSUER;
  h.rateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  h.claimNonceMock.mockResolvedValue(true);
  h.touchLastSeenMock.mockResolvedValue(undefined);
  h.readCurrentOwnerMock.mockResolvedValue(null);
  h.maybeSingleMock.mockResolvedValue({
    data: { id: "agent-1", user_id: "user-1", status: "active" },
    error: null,
  });
});

describe("minting an agent token", () => {
  it("issues an EdDSA token verifiable against the instance key", async () => {
    const res = await POST(signedRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.token_type).toBe("Bearer");

    const signer = loadInstanceSigner()!;
    const verified = verifyCompactJws(body.token, signer.publicKey, { typ: AGENT_TOKEN_TYP });
    expect(verified).not.toBeNull();
    expect(verified!.claims).toMatchObject({
      iss: ISSUER,
      sub: PASSPORT_ID,
      aud: "billing-service",
      agid: "agent-1",
    });
  });

  // Not VISA_ISS. The issuer is the origin a verifier resolves the JWKS from, so
  // it must be the deployment's real https origin.
  it("issues from the configured origin, not the visa issuer constant", async () => {
    const body = await (await POST(signedRequest())).json();
    const claims = verifyCompactJws(body.token, loadInstanceSigner()!.publicKey)!.claims;

    expect(claims.iss).toBe(ISSUER);
    expect(claims.iss).not.toBe("passport.gateway");
  });

  // An issuer an attacker can choose is an issuer they can point at a key set
  // they control. It must never come from a request header.
  it("never derives the issuer from a hostile Host header", async () => {
    process.env.PASSCONTROL_ISSUER = ISSUER;
    const req = new Request("https://evil.example.com/api/auth/agent-token", {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example.com" },
      body: await signedRequest().text(),
    });

    const body = await (await POST(req)).json();
    const claims = verifyCompactJws(body.token, loadInstanceSigner()!.publicKey)!.claims;
    expect(claims.iss).toBe(ISSUER);
  });

  it("refuses to mint when no issuer is configured", async () => {
    delete process.env.PASSCONTROL_ISSUER;
    const res = await POST(signedRequest());

    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe("signing_not_configured");
  });

  it("refuses to mint when no signing key is configured", async () => {
    delete process.env.INSTANCE_SIGNING_KEY;
    expect((await POST(signedRequest())).status).toBe(501);
  });

  it("carries a published owner", async () => {
    const owner = { kind: "domain", sub: "acme.com", tier: "domain", vat: null };
    h.readCurrentOwnerMock.mockResolvedValue(owner);

    const body = await (await POST(signedRequest())).json();
    const claims = verifyCompactJws(body.token, loadInstanceSigner()!.publicKey)!.claims;
    expect(claims.own).toEqual(owner);
  });

  // Scope and budget describe this agent's relationship with THIS proxy. A
  // counterparty has no business seeing them, and the tenant id even less.
  it("carries no tenant id, scope, or budget", async () => {
    const body = await (await POST(signedRequest())).json();
    const claims = verifyCompactJws(body.token, loadInstanceSigner()!.publicKey)!.claims;

    for (const claim of ["uid", "scope", "bt", "bc", "st", "sc"]) {
      expect(claims).not.toHaveProperty(claim);
    }
  });

  it.each([
    [30, 60],
    [300, 300],
    [99_999, 900],
  ])("clamps a requested ttl of %s to %s", async (requested, expected) => {
    const body = await (await POST(signedRequest({ ttl: requested }))).json();
    expect(body.expires_in).toBe(expected);
  });
});

describe("the audience is part of what the agent signs", () => {
  // THE security-critical shape. If `aud` travelled beside the signature rather
  // than inside it, anything on the path could retarget a token minted for one
  // counterparty at another.
  it("rejects a token whose audience was swapped after signing", async () => {
    const res = await POST(
      signedRequest({}, { tamper: (p) => ({ ...p, aud: "payroll-service" }) })
    );

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["oversized", "a".repeat(300)],
    ["containing a space", "billing service"],
    ["containing a newline", "billing\nservice"],
  ])("rejects an audience that is %s", async (_label, aud) => {
    const res = await POST(signedRequest({ aud }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_audience");
  });

  // The gateway has no business knowing, or approving, who an agent talks to.
  it("accepts any well-formed audience without an allowlist", async () => {
    for (const aud of ["https://partner.example.com/api", "urn:acme:billing", "a"]) {
      expect((await POST(signedRequest({ aud }))).status).toBe(200);
    }
  });
});

describe("the same guarantees as the challenge route", () => {
  it("burns the nonce before verifying the signature", async () => {
    h.claimNonceMock.mockResolvedValue(false);
    const res = await POST(signedRequest());

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("replay_detected");
    // The lookup never happened: the replay was rejected before any work.
    expect(h.maybeSingleMock).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp", async () => {
    const res = await POST(signedRequest({ ts: Date.now() - 200_000 }));
    expect((await res.json()).error).toBe("stale_timestamp");
  });

  it("rejects a forged signature", async () => {
    const req = new Request("https://gw.example.com/api/auth/agent-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: bytesToBase64url(
          utf8ToBytes(
            JSON.stringify({
              passport_id: PASSPORT_ID,
              ts: Date.now(),
              nonce: "n1",
              aud: "billing",
            })
          )
        ),
        signature: bytesToBase64url(new Uint8Array(64).fill(1)),
      }),
    });

    expect((await POST(req)).status).toBe(401);
  });

  it.each(["suspended", "revoked"])("refuses to mint for a %s agent", async (status) => {
    h.maybeSingleMock.mockResolvedValue({
      data: { id: "agent-1", user_id: "user-1", status },
      error: null,
    });
    const res = await POST(signedRequest());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("agent_not_active");
  });

  it("refuses an unknown passport", async () => {
    h.maybeSingleMock.mockResolvedValue({ data: null, error: null });
    expect((await POST(signedRequest())).status).toBe(401);
  });

  it("rate limits by client ip", async () => {
    h.rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    const res = await POST(signedRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("requires a JSON content type", async () => {
    const res = await POST(
      new Request("https://gw.example.com/api/auth/agent-token", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      })
    );
    expect(res.status).toBe(415);
  });
});

describe("the existing challenge contract is untouched", () => {
  // Every SDK, the CLI, the examples and the tests depend on this shape. It is
  // the drop-in contract, and this is the change that would have broken it.
  it("still answers /api/auth/challenge with visa, token_type, expires_in, jti", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("app/api/auth/challenge/route.ts", "utf8")
    );
    expect(source).toMatch(
      /NextResponse\.json\(\{\s*visa: token,\s*token_type: "Bearer",\s*expires_in: expSeconds,\s*jti\s*\}\)/
    );
  });
});
