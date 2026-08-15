import { describe, it, expect, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import {
  stepUpRequired,
  needsMfaStepUp,
  mfaAuthorizedUser,
  mfaSatisfied,
} from "../lib/mfa";

describe("stepUpRequired", () => {
  it("requires step-up only when authenticated at aal1 with aal2 available", () => {
    expect(stepUpRequired("aal1", "aal2")).toBe(true); // has a factor, not yet verified
  });
  it("does NOT require step-up for a non-MFA user (the unchanged path)", () => {
    expect(stepUpRequired("aal1", "aal1")).toBe(false); // no factor
  });
  it("does NOT require step-up once already at aal2", () => {
    expect(stepUpRequired("aal2", "aal2")).toBe(false);
  });
  it("treats missing levels as no step-up", () => {
    expect(stepUpRequired(null, null)).toBe(false);
    expect(stepUpRequired("aal2", "aal1")).toBe(false);
  });
});

function supa(aal: { data?: { currentLevel: string; nextLevel: string }; error?: unknown } | (() => never)) {
  return {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: typeof aal === "function" ? aal : async () => aal,
      },
    },
  } as any;
}

/**
 * KEEP, BUT KNOW WHAT THESE PROVE.
 *
 * These tests mock `getAuthenticatorAssuranceLevel` wholesale. They therefore
 * prove that `needsMfaStepUp` maps a *given* (currentLevel, nextLevel) pair onto
 * the right answer, and that it fails open on an error or a throw.
 *
 * They prove NOTHING about where those two levels come from — and that is where
 * the real defect lived: in auth-js the no-argument form takes `currentLevel`
 * from the signed access token but `nextLevel` from `session.user.factors`, i.e.
 * straight out of unauthenticated cookie storage. A wholesale mock of that call
 * is structurally incapable of catching it. The `real @supabase/ssr cookie
 * storage` block below is the test that can, and it is the one to extend.
 */
describe("needsMfaStepUp (level mapping only — see comment above)", () => {
  it("true when aal1→aal2", async () => {
    expect(await needsMfaStepUp(supa({ data: { currentLevel: "aal1", nextLevel: "aal2" } }))).toBe(true);
  });
  it("false for a non-MFA user (aal1→aal1)", async () => {
    expect(await needsMfaStepUp(supa({ data: { currentLevel: "aal1", nextLevel: "aal1" } }))).toBe(false);
  });
  it("fails OPEN (false) on error — never locks out a legit user", async () => {
    expect(await needsMfaStepUp(supa({ error: { message: "down" } }))).toBe(false);
    expect(
      await needsMfaStepUp(
        supa(() => {
          throw new Error("network");
        })
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The regression fixture: a REAL @supabase/ssr server client over a synthetic
// cookie, with fetch stubbed so the auth server is honest and reachable.
//
// Nothing here is mocked inside auth-js. The session travels the same path it
// travels in a Server Action: cookie -> base64 -> JSON.parse -> session object,
// with `_isValidSession` checking only that three keys exist. That is what makes
// `session.user.factors` attacker-editable, and it is why this fixture — not a
// mocked AAL call — is the thing that holds the fix in place.
// ---------------------------------------------------------------------------

const USER_ID = "11111111-1111-1111-1111-111111111111";
const COOKIE_NAME = "sb-test-auth-token";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A structurally real JWT. The signature is opaque: nothing verifies it locally,
 *  so authenticity comes from the stubbed auth server accepting it (or not). */
function accessToken(aal: "aal1" | "aal2") {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      sub: USER_ID,
      aal,
      amr: [{ method: "password" }],
      session_id: "s1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "c2lnbmF0dXJl",
  ].join(".");
}

const VERIFIED_TOTP = {
  id: "f1",
  status: "verified",
  factor_type: "totp",
  friendly_name: "phone",
  created_at: "",
  updated_at: "",
};

function serverUser(factors: unknown[]) {
  return {
    id: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "victim@example.com",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
    factors,
  };
}

interface Fixture {
  /** `aal` claim inside the signed access token. */
  aal?: "aal1" | "aal2";
  /** Factors in the UNSIGNED outer cookie wrapper — attacker-editable. */
  wrapperFactors?: unknown[];
  /** Factors the auth server reports — the authoritative answer. */
  serverFactors?: unknown[];
  /** Make GET /user reject the token, as it would for a forged or dead session. */
  rejectUser?: boolean;
  /** Make the transport throw, as a network blip would. */
  throwOnFetch?: boolean;
}

function makeClient(fx: Fixture) {
  const {
    aal = "aal1",
    wrapperFactors = [VERIFIED_TOTP],
    serverFactors = [VERIFIED_TOTP],
    rejectUser = false,
    throwOnFetch = false,
  } = fx;

  const token = accessToken(aal);
  const session = {
    access_token: token,
    refresh_token: "rt-unchanged",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: "bearer",
    user: { ...serverUser(serverFactors), factors: wrapperFactors },
  };
  const cookieValue = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");

  const userCalls: string[] = [];
  const fetchStub = vi.fn(async (url: unknown, init?: any) => {
    const u = String(url);
    if (throwOnFetch) throw new TypeError("fetch failed");
    if (u.endsWith("/user")) {
      userCalls.push(String(init?.headers?.Authorization ?? ""));
      if (rejectUser) {
        return new Response(JSON.stringify({ code: 401, msg: "invalid claim: token is invalid" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(serverUser(serverFactors)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected " + u }), { status: 500 });
  });

  const db = createServerClient("https://example.supabase.co", "anon-key", {
    cookieOptions: { name: COOKIE_NAME },
    global: { fetch: fetchStub as unknown as typeof fetch },
    cookies: {
      getAll: () => [{ name: COOKIE_NAME, value: cookieValue }],
      setAll: () => {},
    },
  });

  return { db, userCalls, token };
}

describe("MFA gate over real @supabase/ssr cookie storage", () => {
  /**
   * THE BYPASS, stated as a fact about the lenient helper.
   *
   * Signed tokens untouched; only the outer wrapper's `user.factors` emptied.
   * The auth server still reports the verified TOTP factor. `needsMfaStepUp`
   * nonetheless says "no step-up needed", because auth-js derives `nextLevel`
   * from the cookie. This assertion is expected to keep passing forever: it
   * documents why the lenient helper must never authorize a write.
   */
  it("lenient helper IS fooled by an edited cookie wrapper (documented, unchanged)", async () => {
    const { db } = makeClient({ aal: "aal1", wrapperFactors: [], serverFactors: [VERIFIED_TOTP] });

    const {
      data: { user },
    } = await db.auth.getUser();
    expect(user?.factors).toHaveLength(1); // the server tells the truth

    const aal = await db.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal.data?.currentLevel).toBe("aal1"); // signed claim: honest
    expect(aal.data?.nextLevel).toBe("aal1"); // cookie-derived: the lie

    expect(await needsMfaStepUp(db)).toBe(false); // -> a write would proceed
  });

  it("strict helper REFUSES the same edited cookie (the regression)", async () => {
    const { db } = makeClient({ aal: "aal1", wrapperFactors: [], serverFactors: [VERIFIED_TOTP] });

    const gate = await mfaSatisfied(db);
    expect(gate.ok).toBe(false);
    expect(gate).toMatchObject({ reason: "step_up_required" });
  });

  it("strict helper refuses an honest aal1 session that has a factor", async () => {
    const { db } = makeClient({ aal: "aal1", wrapperFactors: [VERIFIED_TOTP] });
    expect((await mfaSatisfied(db)).ok).toBe(false);
  });

  it("strict helper admits a session that actually reached aal2", async () => {
    const { db } = makeClient({ aal: "aal2", wrapperFactors: [VERIFIED_TOTP] });
    expect((await mfaSatisfied(db)).ok).toBe(true);
  });

  it("strict helper admits a non-MFA user — the common path must not break", async () => {
    const { db } = makeClient({ aal: "aal1", wrapperFactors: [], serverFactors: [] });
    expect((await mfaSatisfied(db)).ok).toBe(true);
  });

  it("a wrapper that INVENTS a factor cannot lock the real user out either", async () => {
    // The mirror of the bypass. Trusting the wrapper in the other direction
    // would let anyone who can write the cookie deny service to a non-MFA user.
    const { db } = makeClient({ aal: "aal1", wrapperFactors: [VERIFIED_TOTP], serverFactors: [] });
    expect((await mfaSatisfied(db)).ok).toBe(true);
  });

  it("strict helper fails CLOSED when the auth server rejects the token", async () => {
    const { db } = makeClient({ rejectUser: true });
    const gate = await mfaSatisfied(db);
    expect(gate.ok).toBe(false);
    expect(gate).toMatchObject({ reason: "unauthenticated" });
  });

  it("strict helper fails CLOSED on a transport failure", async () => {
    const strict = await mfaSatisfied(makeClient({ throwOnFetch: true }).db);
    expect(strict.ok).toBe(false);
    expect(strict).toMatchObject({ reason: "indeterminate" });
  });

  it("strict helper fails CLOSED on a malformed access token, lenient one fails open", async () => {
    // Reaching the lenient helper's fail-open needs the AAL call itself to
    // break, which a garbled token does (decodeJWT throws inside auth-js).
    const bad = { aal: "aal1" as const, wrapperFactors: [VERIFIED_TOTP] };
    const strictClient = makeClient(bad);
    const lenientClient = makeClient(bad);
    for (const c of [strictClient, lenientClient]) {
      const original = c.db.auth.getSession.bind(c.db.auth);
      c.db.auth.getSession = (async () => {
        const r = await original();
        if (r.data.session) r.data.session.access_token = "not-a-jwt";
        return r;
      }) as typeof c.db.auth.getSession;
    }

    expect((await mfaSatisfied(strictClient.db)).ok).toBe(false);
    expect(await needsMfaStepUp(lenientClient.db)).toBe(false); // lenient: open
  });

  it("the lenient helper never contacts the auth server at all", async () => {
    // Why it cannot be an authorization gate, in one assertion: its answer is
    // computed entirely from the cookie, with zero corroboration from anyone.
    const { db, userCalls } = makeClient({ aal: "aal1", wrapperFactors: [] });
    expect(await needsMfaStepUp(db)).toBe(false);
    expect(userCalls).toHaveLength(0);
  });

  it("returns the exact network-validated user without a second /user round-trip", async () => {
    const { db, userCalls } = makeClient({ aal: "aal2", wrapperFactors: [VERIFIED_TOTP] });
    const gate = await mfaAuthorizedUser(db);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.user.id).toBe(USER_ID);
    expect(userCalls).toHaveLength(1);
  });

  // The old helper accepted an optional user and skipped its network check.
  // JavaScript callers can still pass extra arguments after TypeScript removes
  // one, so prove that doing so has no effect: the server is always consulted.
  it("has no threaded-user bypass: an extra fabricated argument is ignored", async () => {
    const { db, userCalls } = makeClient({ aal: "aal2", rejectUser: true });
    const fabricated = { id: USER_ID, factors: [VERIFIED_TOTP] } as never;
    expect((await (mfaSatisfied as (...args: never[]) => Promise<{ ok: boolean }>)(db as never, fabricated)).ok)
      .toBe(false);
    expect(userCalls).toHaveLength(1);
  });

  it("without threading, the strict helper fetches the user itself", async () => {
    const { db, userCalls } = makeClient({ aal: "aal2", wrapperFactors: [VERIFIED_TOTP] });
    expect((await mfaSatisfied(db)).ok).toBe(true);
    expect(userCalls).toHaveLength(1);
  });

  it("never consults session.user — the untrusted object is not read at all", async () => {
    // Strongest form of the invariant: poison every field of the wrapper user.
    // If the helper reads any of it, this throws and the test fails.
    const { db } = makeClient({ aal: "aal2", wrapperFactors: [VERIFIED_TOTP] });
    const realGetSession = db.auth.getSession.bind(db.auth);
    db.auth.getSession = (async () => {
      const result = await realGetSession();
      if (result.data.session) {
        result.data.session.user = new Proxy({} as any, {
          get(_t, prop) {
            if (typeof prop === "symbol") return undefined;
            throw new Error(`strict helper read untrusted session.user.${String(prop)}`);
          },
        });
      }
      return result;
    }) as typeof db.auth.getSession;

    expect((await mfaSatisfied(db)).ok).toBe(true);
  });
});
