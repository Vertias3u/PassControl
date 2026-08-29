// Codes for the `passcontrol login` device-authorization flow.
//
// Two codes, with deliberately different jobs and therefore different shapes:
//
//   user_code    8 chars, shown to a human, moved terminal → browser by hand
//                (pasted from the clipboard, or typed). LOW value: it authorizes
//                nothing on its own and expires in 600s.
//   device_code  256 bits, never displayed, held only by the CLI process. It is
//                the secret that redeems the grant, and it never touches the
//                browser leg of the flow.
//
// The asymmetry is the security property. Because the browser only ever handles
// the user_code, a shoulder-surfer, a screenshot, or a clipboard-history tool
// captures something that cannot be redeemed — redemption needs the device_code,
// which stays in the terminal.

/**
 * Crockford-style alphabet: no `0`/`O`, no `1`/`I`/`L`, no `U`.
 *
 * Homoglyphs are not a cosmetic concern here. This code is read off a terminal
 * and re-entered in a browser, so a `0`/`O` confusion turns a valid login into
 * "code not found" — and the operator's next move is to assume the flow is
 * broken, not that they misread a character. `U` is out to avoid the alphabet
 * spelling anything unfortunate in an 8-character window.
 */
export const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const USER_CODE_LENGTH = 8;

/**
 * Uniform index into `max`, by rejection sampling.
 *
 * `crypto.getRandomValues(b)[0] % 30` would be the obvious one-liner and it is
 * biased: 256 is not a multiple of 30, so bytes 0–15 map to their character
 * ~9 times per 256 draws while bytes 16–29 map ~8 times. That is a measurable
 * skew toward the first half of the alphabet — it shaves entropy off every code
 * and it is invisible in any test that only checks length and character set.
 *
 * Discarding the ragged tail (240–255) first makes the remaining range an exact
 * multiple of 30, so the `%` below is uniform rather than merely convenient.
 */
function uniformIndex(max: number): number {
  const ceiling = 256 - (256 % max);
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const byte = buf[0] ?? 0;
    if (byte < ceiling) return byte % max;
  }
}

/**
 * An 8-character user code, ~2^39 of entropy over this alphabet.
 *
 * That is small on purpose — it has to be re-entered by a person. It is not
 * carrying the security of the flow on its own: a 600s TTL, a fail-closed
 * per-user lookup limit, and a per-code attempt cap are what make guessing
 * uneconomic. See lib/state/device-auth.ts for which of those bounds what.
 */
export function generateUserCode(): string {
  let out = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    out += USER_CODE_ALPHABET[uniformIndex(USER_CODE_ALPHABET.length)];
  }
  return out;
}

/** Display form, `FKDR-8T2W`. The hyphen is presentation only — never stored. */
export function formatUserCode(code: string): string {
  return code.length === USER_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Accept what a human actually types: lowercase, the display hyphen, stray
 * whitespace. Returns null for anything that is not a well-formed code, so a
 * malformed entry is refused before it reaches Redis and costs a round trip.
 *
 * This does NOT repair homoglyphs (`0` → `O`). Mapping them would widen the
 * effective guess space by silently accepting several inputs per real code —
 * the alphabet already excludes them, so a `0` here means a genuinely wrong code.
 */
export function normalizeUserCode(input: string): string | null {
  const clean = String(input ?? "").trim().toUpperCase().replace(/[\s-]/gu, "");
  if (clean.length !== USER_CODE_LENGTH) return null;
  for (const ch of clean) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return clean;
}

const DEVICE_CODE_BYTES = 32; // 256 bits

/** The CLI's secret. Never displayed, never sent to the browser. */
export function generateDeviceCode(): string {
  const rand = new Uint8Array(DEVICE_CODE_BYTES);
  crypto.getRandomValues(rand);
  let bin = "";
  for (const b of rand) bin += String.fromCharCode(b);
  const b64 = typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * Redis is keyed by the HASH of the device code, never the code itself.
 *
 * Same reasoning as `api_keys.key_hash`: the token that redeems a credential
 * should not be readable from the store that tracks it. An operator with Redis
 * console access can see that a login is pending without being able to complete
 * one.
 */
export async function hashDeviceCode(deviceCode: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceCode));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Shape pre-filter, so a giant string never reaches the hash. */
export function isDeviceCodeFormat(token: string): boolean {
  return /^[A-Za-z0-9_-]{40,60}$/u.test(token);
}
