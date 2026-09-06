import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bareGatewayOrigin, formatChallengeError } from "./config.mjs";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (value) =>
  new Uint8Array(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

export function createVisaClient({
  gateway,
  passportId,
  passportSecret,
  // What this machine claims about where its passport key is kept, or null.
  // Built by cli/passport-key-store.mjs from the resolution that produced the
  // secret above; see lib/passport-key-storage.ts for why it travels inside the
  // signed bytes rather than beside them.
  keyStorage = null,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  randomUUID = () => globalThis.crypto.randomUUID(),
  refreshSkewSeconds = 30,
  missingVisaMessage = "Challenge returned no visa.",
}) {
  // Both callers (`sidecar`, `mcp`) already hand this a validated origin, and it
  // is validated AGAIN here on purpose. This is the one function in the CLI that
  // signs with the passport private key, so the guard belongs where the
  // signature is produced rather than only where the caller happened to
  // remember it — that omission is exactly how the passport paths ended up on
  // the raw string while the control plane was guarded. Idempotent: an origin
  // that passed the rule passes it unchanged.
  const origin = bareGatewayOrigin(gateway);
  const skewMs = Math.max(0, Number(refreshSkewSeconds) * 1000);
  let cached = null;
  let inflight = null;

  async function mint() {
    const payloadObject = {
      passport_id: passportId,
      ts: now(),
      nonce: randomUUID(),
      // Omitted, never guessed at: every older client, the SDK and the examples
      // mint without one, and an absent claim is a state the dashboard says out
      // loud rather than a tier it assumes.
      ...(keyStorage ? { key_storage: keyStorage } : {}),
    };
    const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObject)));
    const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(passportSecret)));
    const response = await fetchImpl(`${origin}/api/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });

    if (!response.ok) {
      throw new Error(formatChallengeError(response.status, await response.text()));
    }

    const data = await response.json();
    if (!data.visa) throw new Error(missingVisaMessage);
    return {
      token: data.visa,
      expiresAt: now() + (data.expires_in ?? 300) * 1000,
    };
  }

  async function getVisa() {
    if (cached && now() < cached.expiresAt - skewMs) return cached.token;
    if (inflight) return inflight;

    inflight = mint()
      .then((visa) => {
        cached = visa;
        return visa.token;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function invalidate() {
    cached = null;
  }

  function createProof(visa, method, url) {
    const target = new URL(url);
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({
        htm: String(method ?? "GET").toUpperCase(),
        htu: `${target.origin}${target.pathname}`,
        iat: Math.floor(now() / 1000),
        jti: randomUUID(),
        vh: b64url(sha256(new TextEncoder().encode(visa))),
      })
    );
    return `${b64url(payloadBytes)}.${b64url(ed25519.sign(payloadBytes, fromB64url(passportSecret)))}`;
  }

  async function fetchWithVisa(request) {
    let response = await request(await getVisa());
    if (response.status === 401) {
      invalidate();
      response = await request(await getVisa());
    }
    return response;
  }

  return { getVisa, invalidate, fetchWithVisa, createProof };
}
