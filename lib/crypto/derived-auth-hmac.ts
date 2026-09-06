import { utf8ToBytes } from "@/lib/encoding";

export const AUTH_HMAC_LABELS = {
  passportSourceFingerprint: "passport-source-fingerprint",
  challengeRateLimit: "challenge-rate-limit",
} as const;

export type AuthHmacLabel = (typeof AUTH_HMAC_LABELS)[keyof typeof AUTH_HMAC_LABELS];

const LABEL_PREFIX = "passcontrol:auth-hmac-subkey:v1\0";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Derive purpose-specific, non-extractable HMAC keys from VISA_SECRET.
 *
 * This is intentionally one HMAC of the root secret over a fixed, versioned
 * label. The root import, derivation, and derived-key import are each cached by
 * the returned object, so an edge isolate does the work once per purpose.
 */
export function createAuthHmacKeyDeriver(secret: string, subtle = crypto.subtle) {
  if (!secret) throw new Error("visa signing secret unavailable for HMAC derivation");

  let rootKey: Promise<CryptoKey> | null = null;
  const derivedBytes = new Map<AuthHmacLabel, Promise<Uint8Array>>();
  const derivedKeys = new Map<AuthHmacLabel, Promise<CryptoKey>>();

  const root = () => {
    rootKey ??= subtle.importKey(
      "raw",
      arrayBuffer(utf8ToBytes(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return rootKey;
  };

  const bytes = (label: AuthHmacLabel): Promise<Uint8Array> => {
    let pending = derivedBytes.get(label);
    if (!pending) {
      pending = root()
        .then((key) => subtle.sign(
          "HMAC",
          key,
          arrayBuffer(utf8ToBytes(`${LABEL_PREFIX}${label}`))
        ))
        .then((value) => new Uint8Array(value));
      derivedBytes.set(label, pending);
    }
    return pending;
  };

  const key = (label: AuthHmacLabel): Promise<CryptoKey> => {
    let pending = derivedKeys.get(label);
    if (!pending) {
      // Do not retain the raw derived bytes in production. The promise cached
      // here resolves only to the non-extractable CryptoKey; bytes() exists for
      // the explicit derivation tests and is not on the request path.
      pending = root()
        .then((rootKeyValue) => subtle.sign(
          "HMAC",
          rootKeyValue,
          arrayBuffer(utf8ToBytes(`${LABEL_PREFIX}${label}`))
        ))
        .then((value) => subtle.importKey(
          "raw",
          value,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        ));
      derivedKeys.set(label, pending);
    }
    return pending;
  };

  return { bytes, key };
}

let isolateDeriver: ReturnType<typeof createAuthHmacKeyDeriver> | null = null;

export function authHmacKey(label: AuthHmacLabel): Promise<CryptoKey> {
  isolateDeriver ??= createAuthHmacKeyDeriver(process.env.VISA_SECRET ?? "");
  return isolateDeriver.key(label);
}
