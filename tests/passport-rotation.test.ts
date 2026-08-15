// Passport expiry and rotation, at both doors.
//
// There are TWO routes that turn a signed challenge into a credential:
// /api/auth/challenge mints the work-visa this gateway accepts, and
// /api/auth/agent-token mints an EdDSA token asserting this agent's identity to
// a THIRD PARTY. An expired passport that still opens the second door is worse
// than one that still opens the first: the artifact outlives the gateway's
// involvement entirely and is verified offline against the JWKS. So every rule
// here is asserted against both, from one table, and neither route is allowed a
// private interpretation of "active".
//
// ── The two failure modes that make rotation worse than no rotation ─────────
//
//  1. THE OLD KEY IS ACCEPTED FOREVER. A grace window that never closes is not
//     a rotation, it is a second permanent credential — and the operator
//     believes the old one is dead.
//  2. THE NEW KEY IS REJECTED. The agent is locked out at exactly the moment
//     its owner did the responsible thing.
//
// Both come from the same mistake: verifying the signature against a key other
// than the one that matched. That is structurally prevented rather than
// remembered — the lookup helper does not select passport_pubkey at all, so
// there is no row field to derive the wrong key from — and pinned below by a
// row whose stored key deliberately differs from the presented one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";

const h = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  claimNonceMock: vi.fn(),
  touchLastSeenMock: vi.fn(),
  readCurrentOwnerMock: vi.fn(),
  // Every agents row the fake database holds, plus a record of the filters each
  // query applied — which is how the sequential-lookup behaviour is observed.
  rows: [] as Record<string, unknown>[],
  filters: [] as [string, unknown][][],
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
  serviceClient: () => ({
    from: () => {
      const applied: [string, unknown][] = [];
      const b: {
        select: () => typeof b;
        eq: (c: string, v: unknown) => typeof b;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
      } = {
        select: () => b,
        eq: (column: string, value: unknown) => {
          applied.push([column, value]);
          return b;
        },
        maybeSingle: async () => {
          h.filters.push([...applied]);
          const match = h.rows.find((row) =>
            applied.every(([column, value]) => row[column] === value)
          );
          return { data: match ?? null, error: null };
        },
      };
      return b;
    },
  }),
}));

import { POST as challenge } from "@/app/api/auth/challenge/route";
import { POST as agentToken } from "@/app/api/auth/agent-token/route";

const CURRENT_SEED = ed25519.utils.randomPrivateKey();
const CURRENT_ID = bytesToBase64url(ed25519.getPublicKey(CURRENT_SEED));
const RETIRED_SEED = ed25519.utils.randomPrivateKey();
const RETIRED_ID = bytesToBase64url(ed25519.getPublicKey(RETIRED_SEED));

const AGENT_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";

const MINUTE = 60_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** One agents row, with every column the lookup may read. */
function agentRow(over: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: USER_ID,
    status: "active",
    allowed_scopes: [{ provider: "openai", models: ["*"] }],
    budget_tokens: null,
    budget_cents: null,
    spent_tokens: 0,
    spent_microcents: 0,
    passport_pubkey: CURRENT_ID,
    previous_passport_pubkey: null,
    previous_valid_until: null,
    expires_at: null,
    ...over,
  };
}

function signed(seed: Uint8Array, passportId: string, extra: Record<string, unknown> = {}) {
  const payload = {
    passport_id: passportId,
    ts: Date.now(),
    nonce: crypto.randomUUID(),
    ...extra,
  };
  const bytes = utf8ToBytes(JSON.stringify(payload));
  return {
    payload: bytesToBase64url(bytes),
    signature: bytesToBase64url(ed25519.sign(bytes, seed)),
  };
}

const request = (path: string, body: unknown) =>
  new Request(`https://gw.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * The two doors, driven identically.
 *
 * agent-token needs an audience and a configured instance signer; challenge
 * needs neither. Folding that difference in here is what lets every rule below
 * be stated once and asserted against both.
 */
const DOORS = [
  {
    name: "challenge",
    call: (seed: Uint8Array, id: string) =>
      challenge(request("/api/auth/challenge", signed(seed, id))),
  },
  {
    name: "agent-token",
    call: (seed: Uint8Array, id: string) =>
      agentToken(
        request("/api/auth/agent-token", signed(seed, id, { aud: "billing-service" }))
      ),
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [agentRow()];
  h.filters = [];
  process.env.VISA_SECRET = "x".repeat(48);
  process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(7));
  process.env.PASSCONTROL_ISSUER = "https://gw.example.com";
  h.rateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  h.claimNonceMock.mockResolvedValue(true);
  h.touchLastSeenMock.mockResolvedValue(undefined);
  h.readCurrentOwnerMock.mockResolvedValue(null);
});

describe.each(DOORS)("$name", ({ call }) => {
  it("admits the current key when nothing has been rotated or expired", async () => {
    expect((await call(CURRENT_SEED, CURRENT_ID)).status).toBe(200);
  });

  // ── Expiry ────────────────────────────────────────────────────────────────

  it("admits a passport whose expiry is in the future", async () => {
    h.rows = [agentRow({ expires_at: iso(60 * MINUTE) })];
    expect((await call(CURRENT_SEED, CURRENT_ID)).status).toBe(200);
  });

  /**
   * null means never expires, which is what EVERY row holds the moment 0021
   * applies. Rotation and expiry are opt-in for the same reason fallbacks and
   * policy were: a migration must not change what an existing passport can do.
   */
  it("treats a null expiry as never expiring", async () => {
    h.rows = [agentRow({ expires_at: null })];
    expect((await call(CURRENT_SEED, CURRENT_ID)).status).toBe(200);
  });

  it("refuses an expired passport with its own code", async () => {
    h.rows = [agentRow({ expires_at: iso(-MINUTE) })];
    const res = await call(CURRENT_SEED, CURRENT_ID);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("passport_expired");
  });

  /**
   * Not folded into agent_not_active. An operator debugging a fleet needs to
   * tell "someone revoked this" from "this aged out" — different cause,
   * different fix — and these codes are what captureSecurityEvent records.
   */
  it("keeps revocation and expiry as separate codes", async () => {
    h.rows = [agentRow({ status: "revoked", expires_at: iso(-MINUTE) })];
    const res = await call(CURRENT_SEED, CURRENT_ID);
    expect((await res.json()).error).toBe("agent_not_active");
  });

  // ── Rotation ──────────────────────────────────────────────────────────────

  const rotated = (graceMs: number) =>
    agentRow({
      passport_pubkey: CURRENT_ID,
      previous_passport_pubkey: RETIRED_ID,
      previous_valid_until: iso(graceMs),
    });

  it("admits the NEW key immediately after a rotation", async () => {
    h.rows = [rotated(10 * MINUTE)];
    expect((await call(CURRENT_SEED, CURRENT_ID)).status).toBe(200);
  });

  it("admits the OLD key while the grace window is open", async () => {
    h.rows = [rotated(10 * MINUTE)];
    expect((await call(RETIRED_SEED, RETIRED_ID)).status).toBe(200);
  });

  it("refuses the OLD key once the grace window has passed", async () => {
    h.rows = [rotated(-MINUTE)];
    const res = await call(RETIRED_SEED, RETIRED_ID);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("passport_expired");
  });

  it("still admits the new key after the grace window has passed", async () => {
    h.rows = [rotated(-MINUTE)];
    expect((await call(CURRENT_SEED, CURRENT_ID)).status).toBe(200);
  });

  /**
   * A retired key with no deadline is a key that never dies. Rotation always
   * stamps one, so this is unreachable through the product — which is exactly
   * why it must fail closed rather than be left to a future writer.
   */
  it("refuses the old key when no grace deadline was recorded", async () => {
    h.rows = [
      agentRow({ previous_passport_pubkey: RETIRED_ID, previous_valid_until: null }),
    ];
    const res = await call(RETIRED_SEED, RETIRED_ID);
    expect(res.status).toBe(403);
  });

  it("refuses a passport it has never seen", async () => {
    const strangerSeed = ed25519.utils.randomPrivateKey();
    const strangerId = bytesToBase64url(ed25519.getPublicKey(strangerSeed));
    const res = await call(strangerSeed, strangerId);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unknown_passport");
  });

  it("refuses a valid old key carrying a signature it did not make", async () => {
    h.rows = [rotated(10 * MINUTE)];
    // Signs with the CURRENT seed while presenting the RETIRED id.
    const res = await call(CURRENT_SEED, RETIRED_ID);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");
  });

  // ── The invariant that makes rotation safe ────────────────────────────────

  /**
   * The signature is verified against the key the CALLER PRESENTED, which is
   * the key the lookup matched on — never against a field of the row.
   *
   * Pinned with a row whose stored passport_pubkey is a third, unrelated key.
   * A route that derived from the row would reject this; a route that derives
   * from the presented id admits it. Rotation is the feature that makes the
   * distinction observable, because it is the first time a row can legitimately
   * match on a column other than passport_pubkey.
   */
  it("verifies against the presented key, never against the stored row", async () => {
    const unrelated = bytesToBase64url(
      ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
    );
    h.rows = [
      agentRow({
        passport_pubkey: unrelated,
        previous_passport_pubkey: RETIRED_ID,
        previous_valid_until: iso(10 * MINUTE),
      }),
    ];
    expect((await call(RETIRED_SEED, RETIRED_ID)).status).toBe(200);
  });

  /**
   * A COLLISION ACROSS ROWS IS REFUSED, ON BOTH DOORS.
   *
   * A passport id is a PUBLIC key. /verify prints them, receipts carry them,
   * and `passport_pubkey` / `previous_passport_pubkey` are unique only WITHIN
   * their own column — so nothing in the schema stops tenant A registering, as
   * A's own current key, the key tenant V has just retired.
   *
   * Preferring the current-key match resolves that collision to A's row. Both
   * doors then verify V's real, otherwise-valid signature against it, and mint
   * A's uid, A's agid, A's scopes and A's budget. The question this row can no
   * longer answer is not "is there one row, or a 500?" — it is WHOSE IDENTITY
   * GETS MINTED, and the lookup is not entitled to pick.
   *
   * So it refuses, for both tenants, in whichever direction the key is
   * presented — this one request is both cases, because both tenants present
   * the same key. A tenant who copies a published key can therefore deny that
   * key's owner a mint; that is the accepted price of never attributing a valid
   * signature to the wrong tenant, and lib/auth/passport.ts records what a
   * migration would have to do to make the collision impossible to create in
   * the first place.
   */
  it("refuses a key that is one row's current key and another row's retired key", async () => {
    h.rows = [
      // Another tenant's agent, registered with this tenant's retired key.
      agentRow({ id: "other", user_id: "other", passport_pubkey: RETIRED_ID }),
      rotated(10 * MINUTE),
    ];
    const res = await call(RETIRED_SEED, RETIRED_ID);
    expect(res.status).toBe(403);
    // Asserted on the CODE, not just the status: a bare 403 would also be
    // satisfied by an unrelated gate refusing for an unrelated reason, and the
    // whole point of this test is which decision was made.
    expect((await res.json()).error).toBe("passport_ambiguous");
  });
});

// ── Structural guarantees, asserted on the source ───────────────────────────
describe("how the lookup is built", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const routes = [
    "app/api/auth/challenge/route.ts",
    "app/api/auth/agent-token/route.ts",
  ];

  /**
   * `.or()` takes a RAW PostgREST filter string, and passport_id is
   * attacker-controlled on an unauthenticated endpoint — commas and dots are
   * filter syntax. The only thing that rejects a non-base64url passport id is
   * passportIdToPublicKey, which runs AFTER the lookup. Relying on a later
   * check to protect an earlier one is the ordering this codebase refuses
   * everywhere else, so the two-column match is two sequential .eq() lookups.
   */
  it.each(routes)("%s never interpolates the passport id into a filter string", (path) => {
    expect(read(path)).not.toMatch(/\.or\(/);
  });

  it.each(routes)("%s goes through the shared lookup rather than its own", (path) => {
    expect(read(path)).toMatch(/from "@\/lib\/auth\/passport"/);
    expect(read(path)).not.toMatch(/\.eq\("passport_pubkey"/);
  });

  /**
   * The structural half of the presented-key invariant: the helper cannot
   * return passport_pubkey, so no caller can derive a key from the row even by
   * accident. Cheaper to keep true than a rule someone has to remember.
   */
  it("never selects passport_pubkey into the auth path", () => {
    const lookup = read("lib/auth/passport.ts");
    // The constant's VALUE, not the prose around it. A file-wide ban would fail
    // on the comment that explains why the column is absent — a test that
    // punishes the explanation is a test that gets the explanation deleted.
    const declared = /const LOOKUP_COLUMNS = "([^"]*)"/.exec(lookup);
    expect(declared, "LOOKUP_COLUMNS is missing").not.toBeNull();
    expect(declared?.[1]).not.toMatch(/passport_pubkey/);
  });

  /**
   * The sweep clears retired keys so the unique constraint does not hold one
   * hostage. It is NOT what enforces expiry — a cron that has not run must
   * never be the reason an expired passport still works.
   */
  it.each(routes)("%s enforces expiry itself, with no help from the cron", (path) => {
    // Asserted as "imports nothing from the reconcile module", not as "the word
    // reconcile does not appear": the challenge route legitimately mentions the
    // cron in a comment about coalesced last-seen writes, which has nothing to
    // do with expiry.
    expect(read(path)).not.toMatch(/from "@\/lib\/reconcile"/);
    expect(read(path)).toMatch(/findAuthenticatablePassport/);
  });
});

describe("migration 0021", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "db/migrations/0021_passport_expiry_rotation.sql"),
    "utf8"
  ).replace(/--[^\n]*/g, "");

  it.each(["expires_at", "previous_passport_pubkey", "previous_valid_until"])(
    "adds %s",
    (column) => {
      expect(sql).toMatch(new RegExp(`add column ${column}`, "i"));
    }
  );

  /**
   * Every existing passport must keep exactly the behaviour it has today, the
   * same opt-in property 0014, 0018 and 0020 have. Asserted against the `add
   * column` statements alone — the partial index legitimately carries an
   * `is not null` predicate, and banning the phrase file-wide would forbid it.
   */
  it("adds every column as nullable with no default, so no row changes meaning", () => {
    const added = [...sql.matchAll(/add column\s+(\w+)\s+([^,;]*)/gi)];
    expect(added).toHaveLength(3);
    for (const [, column, definition] of added) {
      expect(definition, column).not.toMatch(/not null/i);
      expect(definition, column).not.toMatch(/default/i);
    }
  });

  /**
   * Same decision migrations 0011 and 0020 record: these are server-action
   * writes, so `authenticated` needs no UPDATE. RLS confines a tenant to their
   * own row but does not stop them PATCHing any column they hold a grant on —
   * and previous_valid_until is the deadline that ends a retired key's life.
   */
  it("grants the client no write on any of them", () => {
    expect(sql).not.toMatch(/grant\s+update/i);
  });

  it("keeps a retired key globally unique", () => {
    expect(sql).toMatch(/unique/i);
  });
});
