import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — plain .mjs CLI module, no types
import { createVisaClient } from "../cli/visa-client.mjs";
// @ts-expect-error — plain .mjs CLI module, no types
import { keyStorageDeclaration, resolvePassportKey } from "../cli/passport-key-store.mjs";

const GATEWAY = "https://gateway.test";
const PASSPORT_ID = Buffer.alloc(32, 3).toString("base64url");
const PASSPORT_SECRET = Buffer.alloc(32, 7).toString("base64url");

function visaResponse() {
  return new Response(JSON.stringify({ visa: "visa-one", expires_in: 300 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function signedPayload(fetchMock: ReturnType<typeof vi.fn>) {
  const init = fetchMock.mock.calls[0]?.[1] as { body?: unknown };
  const body = JSON.parse(String(init.body));
  return JSON.parse(Buffer.from(body.payload, "base64url").toString("utf8"));
}

// The declaration is built from the SAME resolution that produced the key, so
// the CLI can never declare a tier it did not actually read from.
describe("what the CLI declares about its own key storage", () => {
  const store = (secret: string | null) => ({
    name: "macOS Keychain",
    write: () => ({ ok: true }),
    read: () => (secret ? { ok: true, secret } : { ok: false, reason: "unavailable" }),
    delete: () => ({ ok: true }),
  });

  it("declares a file key as tier 0", () => {
    const resolved = resolvePassportKey({ passportId: PASSPORT_ID, fileSecret: PASSPORT_SECRET });
    expect(keyStorageDeclaration(resolved.storage)).toEqual({ store: "file" });
  });

  it("declares an OS credential store as tier 1", () => {
    const resolved = resolvePassportKey({
      passportId: PASSPORT_ID,
      storageMarker: "os",
      store: store(PASSPORT_SECRET),
    });
    expect(keyStorageDeclaration(resolved.storage)).toEqual({ store: "os" });
  });

  // The state the whole panel is worth building for: the operator configured
  // tier 1, the store could not be read, and the file key answered instead.
  it("declares the fall back to the file, not a clean tier 0", () => {
    const resolved = resolvePassportKey({
      passportId: PASSPORT_ID,
      fileSecret: PASSPORT_SECRET,
      storageMarker: "os",
      store: store(null),
    });
    expect(keyStorageDeclaration(resolved.storage)).toEqual({ store: "file", fallback: true });
  });

  it("declares nothing when there is no key to describe", () => {
    const resolved = resolvePassportKey({ passportId: PASSPORT_ID });
    expect(keyStorageDeclaration(resolved.storage)).toBeNull();
  });

  // Tier 1 configured, the store unreadable, and no file key to fall back to.
  // The CLI cannot sign at all in this state, so no mint can carry the claim —
  // but the guard is pinned here so a later refactor cannot start declaring a
  // tier off a resolution that produced no key.
  it("declares nothing when tier 1 is configured and unavailable", () => {
    const resolved = resolvePassportKey({
      passportId: PASSPORT_ID,
      storageMarker: "os",
      store: store(null),
    });
    expect(resolved.storage).toMatchObject({ tier: 1, available: false });
    expect(keyStorageDeclaration(resolved.storage)).toBeNull();
  });
});

describe("carrying the declaration to the gateway", () => {
  it("puts it inside the signed payload, where a network attacker cannot forge it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(visaResponse());
    const visas = createVisaClient({
      gateway: GATEWAY,
      passportId: PASSPORT_ID,
      passportSecret: PASSPORT_SECRET,
      keyStorage: { store: "os" },
      fetch: fetchMock,
      now: () => 1_000,
      randomUUID: () => "nonce-for-test",
    });

    await visas.getVisa();

    expect(signedPayload(fetchMock)).toMatchObject({
      passport_id: PASSPORT_ID,
      key_storage: { store: "os" },
    });
  });

  // Every older client, the SDK, and examples/*.mjs mint without one. The field
  // must be absent rather than guessed at, and the mint must not care.
  it("omits the field entirely when the caller declares nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(visaResponse());
    const visas = createVisaClient({
      gateway: GATEWAY,
      passportId: PASSPORT_ID,
      passportSecret: PASSPORT_SECRET,
      fetch: fetchMock,
      now: () => 1_000,
      randomUUID: () => "nonce-for-test",
    });

    await visas.getVisa();

    expect(signedPayload(fetchMock)).not.toHaveProperty("key_storage");
  });
});
