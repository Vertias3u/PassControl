import { ed25519 } from "@noble/curves/ed25519";
import { formatChallengeError } from "./config.mjs";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (value) =>
  new Uint8Array(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

export function createVisaClient({
  gateway,
  passportId,
  passportSecret,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  randomUUID = () => globalThis.crypto.randomUUID(),
  refreshSkewSeconds = 30,
  missingVisaMessage = "Challenge returned no visa.",
}) {
  const skewMs = Math.max(0, Number(refreshSkewSeconds) * 1000);
  let cached = null;
  let inflight = null;

  async function mint() {
    const payloadObject = { passport_id: passportId, ts: now(), nonce: randomUUID() };
    const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObject)));
    const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(passportSecret)));
    const response = await fetchImpl(`${gateway}/api/auth/challenge`, {
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

  async function fetchWithVisa(request) {
    let response = await request(await getVisa());
    if (response.status === 401) {
      invalidate();
      response = await request(await getVisa());
    }
    return response;
  }

  return { getVisa, invalidate, fetchWithVisa };
}
