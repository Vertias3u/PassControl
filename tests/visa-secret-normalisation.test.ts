import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import { mintVisa, verifyVisa, VISA_ISS, VISA_AUD, VISA_VER } from "../lib/auth/visa";
import {
  issuePasswordRecoveryTicket,
  verifyPasswordRecoveryTicket,
} from "../lib/auth/passwordRecovery";

/**
 * Surrounding whitespace in VISA_SECRET.
 *
 * `lib/auth/passwordRecovery.ts` has always read `VISA_SECRET?.trim()`;
 * `lib/auth/visa.ts` read it raw. That asymmetry is NOT a live bug — each file
 * signs and verifies with its own reading, and nothing cross-verifies — but it
 * leaves one way to take the gateway down:
 *
 *   VISA_SECRET_PREV is set by a human copying the old secret. If the old value
 *   carried a trailing newline (`openssl rand -base64 32 | pbcopy`, a dashboard
 *   paste) and the copy into _PREV does not, then _PREV is a DIFFERENT key and
 *   every visa minted before the rotation fails verification — the exact failure
 *   zero-downtime rotation exists to prevent. Same trap that made
 *   CACHE_ENC_KEY throw InvalidCharacterError in production.
 *
 * So: normalise, and keep accepting the un-normalised form so the fix itself
 * cannot invalidate a visa that is already in flight.
 */

const BASE32 = "test-secret-test-secret-test-secret-32";
const OTHER32 = "other-secret-other-secret-other-32-ok";

const base = {
  passportId: "pid",
  agentId: "aid",
  userId: "uid",
  jti: "j1",
  scope: [] as { provider: string; models: string[] }[],
  budgetTokens: null,
  budgetCents: null,
  spentTokens: 0,
  spentMicrocents: 0,
};

const ORIGINAL = {
  secret: process.env.VISA_SECRET,
  prev: process.env.VISA_SECRET_PREV,
  ttl: process.env.VISA_TTL_SECONDS,
};

beforeEach(() => {
  process.env.VISA_SECRET = BASE32;
  delete process.env.VISA_SECRET_PREV;
  process.env.VISA_TTL_SECONDS = "300";
});

afterAll(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("VISA_SECRET", ORIGINAL.secret);
  restore("VISA_SECRET_PREV", ORIGINAL.prev);
  restore("VISA_TTL_SECONDS", ORIGINAL.ttl);
});

/** Sign a structurally valid visa with an exact key, bypassing visa.ts's own
 *  reading of the environment — this is how a visa minted by the PREVIOUS
 *  build (raw, untrimmed secret) is reproduced. */
async function mintWithExactKey(secret: string): Promise<string> {
  return new SignJWT({
    agid: base.agentId,
    uid: base.userId,
    scope: base.scope,
    bt: null,
    bc: null,
    st: 0,
    sc: 0,
    ver: VISA_VER,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(VISA_ISS)
    .setAudience(VISA_AUD)
    .setSubject(base.passportId)
    .setJti(base.jti)
    .setIssuedAt()
    .setExpirationTime("300s")
    .sign(new TextEncoder().encode(secret));
}

describe("VISA_SECRET whitespace normalisation", () => {
  it("signs with the trimmed secret, so the key does not depend on how it was pasted", async () => {
    process.env.VISA_SECRET = `${BASE32}\n`;
    const { token } = await mintVisa(base);

    // Verified against the TRIMMED bytes with no help from visa.ts.
    await expect(
      jwtVerify(token, new TextEncoder().encode(BASE32), {
        issuer: VISA_ISS,
        audience: VISA_AUD,
        algorithms: ["HS256"],
      }),
    ).resolves.toBeTruthy();
  });

  it("accepts a visa minted by the previous build from the raw, untrimmed secret", async () => {
    // Deploying the fix must not 401 visas that are already in flight.
    process.env.VISA_SECRET = `${BASE32}\n`;
    const legacy = await mintWithExactKey(`${BASE32}\n`);
    expect(await verifyVisa(legacy)).toMatchObject({ sub: "pid", agid: "aid" });
  });

  it("verifies across a rotation where _PREV was pasted without the trailing newline", async () => {
    // THE failure this fix exists to prevent. Old secret carried a newline; the
    // operator copies the displayed value into _PREV, losing it. Before the fix
    // the two are different keys and every in-flight visa dies.
    process.env.VISA_SECRET = `${BASE32}\n`;
    const { token } = await mintVisa(base);

    process.env.VISA_SECRET = OTHER32;
    process.env.VISA_SECRET_PREV = BASE32; // newline lost in the copy

    expect(await verifyVisa(token)).toMatchObject({ sub: "pid", agid: "aid" });
  });

  it("verifies across the same rotation in the opposite direction", async () => {
    // Old secret had no newline; the operator pastes into _PREV and the
    // dashboard/shell adds one.
    process.env.VISA_SECRET = BASE32;
    const { token } = await mintVisa(base);

    process.env.VISA_SECRET = OTHER32;
    process.env.VISA_SECRET_PREV = `${BASE32}\n`;

    expect(await verifyVisa(token)).toMatchObject({ sub: "pid", agid: "aid" });
  });

  it("tolerates whitespace generally, not just a trailing newline", async () => {
    process.env.VISA_SECRET = `  ${BASE32}\r\n`;
    const { token } = await mintVisa(base);
    process.env.VISA_SECRET = BASE32;
    expect(await verifyVisa(token)).toMatchObject({ sub: "pid" });
  });

  it("treats a whitespace-only VISA_SECRET_PREV as absent, not as a broken secret", async () => {
    // Blanking a dashboard field commonly leaves "" or "\n" rather than deleting
    // the variable. `"\n"` is truthy, so the old code entered the rotation branch
    // and threw "must be at least 32 bytes" — from acceptedSecrets(), i.e. on the
    // VERIFY path, so every agent call 500s. A cleared secret must read as absent.
    const { token } = await mintVisa(base);
    for (const blank of ["\n", " ", "  \r\n  ", ""]) {
      process.env.VISA_SECRET_PREV = blank;
      expect(await verifyVisa(token), `blank _PREV ${JSON.stringify(blank)}`).toMatchObject({
        sub: "pid",
      });
      expect(await verifyVisa("not.a.jwt")).toBeNull();
    }
  });

  it("still rejects a visa signed with a genuinely different secret", async () => {
    // Whitespace tolerance must not become "accepts anything nearby".
    const foreign = await mintWithExactKey(OTHER32);
    expect(await verifyVisa(foreign)).toBeNull();
  });

  it("keeps the 32-byte floor — trimming does not rescue a short secret", async () => {
    // Whitespace tolerance must not quietly disable the floor.
    process.env.VISA_SECRET = "  short  ";
    await expect(mintVisa(base)).rejects.toThrow("VISA_SECRET must be at least 32 bytes");
  });

  it("falls back to the raw value rather than throwing on the hot path", async () => {
    // ...but ONLY when the raw value is itself below the floor. A deployment
    // whose secret satisfies the floor today must not be pushed below it by this
    // change: secretVariants() is reached from verifyVisa() as well as mintVisa(),
    // so a new throw here would take the whole gateway down on deploy — mint and
    // verify together — for a secret the previous build accepted.
    //
    // This is a deliberate, narrow escape hatch, not an oversight. It can only
    // fire for a secret that is weak AND whitespace-padded, and the readiness
    // gate below refuses to launch on exactly that shape.
    process.env.VISA_SECRET = `${" ".repeat(20)}too-short${" ".repeat(20)}`;
    const { token } = await mintVisa(base);
    expect(await verifyVisa(token)).toMatchObject({ sub: "pid" });
  });

  // The weak-but-padded secret the fallback above tolerates is refused before
  // launch by check-cloud-beta-readiness.mjs, which measures the floor on the
  // trimmed value. That assertion lives in tests/cloud-beta-readiness.test.mjs
  // (importing the .mjs gate from TypeScript has no declaration file).
});

describe("visa.ts and passwordRecovery.ts derive the same key", () => {
  it("agree on the trimmed secret", async () => {
    // The original concern: two files reading one env var differently. Pin the
    // parity so they cannot drift apart again.
    process.env.VISA_SECRET = `${BASE32}\n`;
    const ticket = await issuePasswordRecoveryTicket("user-1");
    expect(ticket).not.toBeNull();

    const { token } = await mintVisa(base);
    const key = new TextEncoder().encode(BASE32);

    // One key verifies both artifacts.
    await expect(jwtVerify(ticket!, key, { audience: "passcontrol-password-recovery" })).resolves
      .toBeTruthy();
    await expect(jwtVerify(token, key, { issuer: VISA_ISS, audience: VISA_AUD })).resolves
      .toBeTruthy();
  });

  it("password recovery survives the same whitespace-mismatched rotation", async () => {
    process.env.VISA_SECRET = `${BASE32}\n`;
    const ticket = await issuePasswordRecoveryTicket("user-1");

    process.env.VISA_SECRET = OTHER32;
    process.env.VISA_SECRET_PREV = BASE32;

    expect(await verifyPasswordRecoveryTicket(ticket!, "user-1")).toBe(true);
  });

  it("password recovery refuses to sign a ticket with a below-floor secret", async () => {
    // visa.ts throws loudly on a short secret; passwordRecovery used to sign
    // with it silently. It keeps its soft-fail contract (no throw in an auth
    // route) but must not mint a token under a weak key.
    process.env.VISA_SECRET = "too-short";
    expect(await issuePasswordRecoveryTicket("user-1")).toBeNull();
  });

  it("still binds a recovery ticket to its user", async () => {
    const ticket = await issuePasswordRecoveryTicket("user-1");
    expect(await verifyPasswordRecoveryTicket(ticket!, "user-1")).toBe(true);
    expect(await verifyPasswordRecoveryTicket(ticket!, "user-2")).toBe(false);
  });
});
