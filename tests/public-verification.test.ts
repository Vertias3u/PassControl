// PAVP — the public agent verification page.
//
// This is the first unauthenticated route in the app that reads the agents
// table, so the test that earns its keep is the one asserting the response
// shape is EXACTLY the public field set. A future edit that widens the view
// fails here rather than shipping a customer list to a public URL.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...a: unknown[]) => h.rateLimitMock(...a),
}));

import {
  PUBLIC_PASSPORT_FIELDS,
  PUBLIC_COMPANY_FIELDS,
  PUBLIC_OWNER_FIELDS,
  PUBLIC_VERIFY_LIMIT,
  PUBLIC_VERIFY_WINDOW_SECONDS,
  buildPublicPassportView,
  isPassportIdShape,
  lookupPublicPassport,
} from "@/lib/verify/passport";

const PASSPORT_ID = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyc28";
const AGENT_UUID = "11111111-1111-1111-1111-111111111111";
const IP = "203.0.113.7";

/** A row exactly as the verify_passport function returns it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    passport_pubkey: PASSPORT_ID,
    status: "active",
    created_at: "2026-07-01T09:30:00.000Z",
    ...overrides,
  };
}

function db(result: { data: unknown; error: unknown }) {
  h.rpcMock.mockResolvedValue(result);
  return { rpc: h.rpcMock, from: h.fromMock } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  h.fromMock.mockImplementation(() => {
    throw new Error("public verification must not select the agents table directly");
  });
});

describe("the public field set", () => {
  it("exposes exactly the advertised fields and nothing else", () => {
    const view = buildPublicPassportView(row());
    expect(view).not.toBeNull();
    expect(Object.keys(view!).sort()).toEqual([...PUBLIC_PASSPORT_FIELDS].sort());
  });

  // The assertion above pins the BUILDER against the CONSTANT, so it catches
  // drift between them — but widening the surface means editing both in one
  // move, and it stays green. It did exactly that when `owner` was added.
  //
  // This list is the change detector: it is duplicated on purpose, so putting a
  // new field on the internet takes a second, deliberate edit in a file whose
  // whole subject is what strangers can read.
  it("publishes this exact surface, and widening it is a deliberate act", () => {
    expect([...PUBLIC_PASSPORT_FIELDS].sort()).toEqual([
      "displayId",
      "expiresAt",
      "issuedAt",
      "owner",
      "passportId",
      "retired",
      "status",
    ]);
    expect([...PUBLIC_OWNER_FIELDS].sort()).toEqual([
      "company",
      "kind",
      "subject",
      "tier",
      "verifiedAt",
    ]);
    // The company line is its own object rather than four more owner fields, so
    // a template rendering the proof cannot pick up an asserted legal name as
    // though it were part of it. Widening it is the same deliberate act.
    expect([...PUBLIC_COMPANY_FIELDS].sort()).toEqual([
      "active",
      "checkedAt",
      "id",
      "name",
      "source",
    ]);
  });

  it("exposes exactly the advertised owner fields", () => {
    const view = buildPublicPassportView(
      row({ owner_subject: "acme.com", owner_kind: "domain", owner_tier: "domain" })
    );
    expect(Object.keys(view!.owner!).sort()).toEqual([...PUBLIC_OWNER_FIELDS].sort());
  });

  it("drops private columns even when the row carries them", () => {
    // If someone widens the SQL function, the view must still refuse to render
    // the extra columns. Belt and braces: the migration is the primary control.
    const view = buildPublicPassportView(
      row({
        name: "acme-prod-billing",
        user_id: "9f1d0c7a-0000-0000-0000-000000000000",
        allowed_scopes: [{ provider: "openai", models: ["*"] }],
        spent_tokens: 918_233,
        budget_cents: 5000,
        spent_microcents: 4_120_000,
        policy: { deny: [{ provider: "openai", models: ["gpt-4*"] }] },
      })
    );

    const serialized = JSON.stringify(view);
    for (const secret of [
      "acme-prod-billing",
      "9f1d0c7a",
      "openai",
      "918233",
      "5000",
      "4120000",
      "deny",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps the passport id and a shortened display form", () => {
    const view = buildPublicPassportView(row())!;
    expect(view.passportId).toBe(PASSPORT_ID);
    expect(view.displayId.length).toBeLessThan(PASSPORT_ID.length);
  });

  it("reports the three lifecycle states honestly", () => {
    expect(buildPublicPassportView(row({ status: "active" }))!.status).toBe("active");
    expect(buildPublicPassportView(row({ status: "suspended" }))!.status).toBe("suspended");
    expect(buildPublicPassportView(row({ status: "revoked" }))!.status).toBe("revoked");
  });

  it("treats an unrecognised status as not valid rather than guessing active", () => {
    const view = buildPublicPassportView(row({ status: "sOmEtHiNg-new" }))!;
    expect(view.status).toBe("unknown");
  });

  it("returns null for a row with no passport id", () => {
    expect(buildPublicPassportView(row({ passport_pubkey: "" }))).toBeNull();
    expect(buildPublicPassportView(null)).toBeNull();
  });

  it("nulls an unparseable issue date instead of rendering it", () => {
    expect(buildPublicPassportView(row({ created_at: "not-a-date" }))!.issuedAt).toBeNull();
  });
});

describe("accepted passport id shapes", () => {
  it("accepts a base64url passport id", () => {
    expect(isPassportIdShape(PASSPORT_ID)).toBe(true);
  });

  it("rejects the internal agent uuid so dashboard URLs cannot be correlated", () => {
    expect(isPassportIdShape(AGENT_UUID)).toBe(false);
  });

  it("rejects empty, oversized, and non-base64url input", () => {
    expect(isPassportIdShape("")).toBe(false);
    expect(isPassportIdShape("a".repeat(512))).toBe(false);
    expect(isPassportIdShape("has spaces")).toBe(false);
    expect(isPassportIdShape("slash/and+plus")).toBe(false);
  });
});

describe("the public lookup", () => {
  it("reads through the verify_passport function, never a table select", async () => {
    const result = await lookupPublicPassport(db({ data: [row()], error: null }), PASSPORT_ID, IP);

    expect(result.ok).toBe(true);
    expect(h.rpcMock).toHaveBeenCalledWith("verify_passport", { p_passport_id: PASSPORT_ID });
    expect(h.fromMock).not.toHaveBeenCalled();
  });

  it("rate limits by client ip in its own namespace", async () => {
    await lookupPublicPassport(db({ data: [row()], error: null }), PASSPORT_ID, IP);
    expect(h.rateLimitMock).toHaveBeenCalledWith(
      `verify:${IP}`,
      PUBLIC_VERIFY_LIMIT,
      PUBLIC_VERIFY_WINDOW_SECONDS
    );
  });

  it("refuses to touch the database once throttled", async () => {
    h.rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    const result = await lookupPublicPassport(db({ data: [row()], error: null }), PASSPORT_ID, IP);

    expect(result).toEqual({ ok: false, reason: "throttled" });
    expect(h.rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed id before spending a database call", async () => {
    const result = await lookupPublicPassport(db({ data: [row()], error: null }), AGENT_UUID, IP);

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(h.rpcMock).not.toHaveBeenCalled();
  });

  it("reports an unknown passport as not found", async () => {
    const result = await lookupPublicPassport(db({ data: [], error: null }), PASSPORT_ID, IP);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports a revoked passport as found and revoked — that is the feature working", async () => {
    const result = await lookupPublicPassport(
      db({ data: [row({ status: "revoked" })], error: null }),
      PASSPORT_ID,
      IP
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.passport.status).toBe("revoked");
  });

  it("separates a database failure from a missing passport", async () => {
    // Rendering "no such passport" during an outage would be a false negative
    // about someone's identity, which is worse than admitting the outage.
    const result = await lookupPublicPassport(
      db({ data: null, error: { message: "boom" } }),
      PASSPORT_ID,
      IP
    );

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("survives the function being absent on an un-migrated database", async () => {
    const result = await lookupPublicPassport(
      db({ data: null, error: { code: "PGRST202", message: "not found" } }),
      PASSPORT_ID,
      IP
    );

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the owner assertion", () => {
  it("is absent when no owner is bound", () => {
    expect(buildPublicPassportView(row())!.owner).toBeNull();
  });

  // The SQL function LEFT JOINs `and o.published`, so an unpublished owner comes
  // back as NULL columns. Publication is opt-in and defaults to false: binding an
  // owner privately must never put a name on a public URL.
  it("is absent when the owner has not published", () => {
    const view = buildPublicPassportView(
      row({ owner_subject: null, owner_kind: null, owner_tier: null, owner_verified_at: null })
    );
    expect(view!.owner).toBeNull();
  });

  it("renders a domain-verified owner with its tier and date", () => {
    const view = buildPublicPassportView(
      row({
        owner_subject: "acme.com",
        owner_kind: "domain",
        owner_tier: "domain",
        owner_verified_at: "2026-08-01T00:00:00.000Z",
      })
    );

    expect(view!.owner).toEqual({
      kind: "domain",
      subject: "acme.com",
      tier: "domain",
      verifiedAt: "2026-08-01T00:00:00.000Z",
      // 0048's asserted register line, absent here. It is a peer of the proof
      // rather than part of it, so an owner who has asserted nothing carries an
      // explicit null instead of the key being missing.
      company: null,
    });
  });

  // The load-bearing one. `kind` records the method attempted; `tier` records
  // what was proven. A self-attested owner is a name someone typed — if the page
  // could word that as verified, the whole ladder would be theatre.
  it("never labels a self-attested owner as verified", () => {
    const view = buildPublicPassportView(
      row({
        owner_subject: "Definitely Real Bank",
        owner_kind: "self_attested",
        owner_tier: "unverified",
        owner_verified_at: "2026-08-01T00:00:00.000Z",
      })
    );

    expect(view!.owner!.tier).toBe("unverified");
    // No date either: a verification date on an unverified claim reads as proof.
    expect(view!.owner!.verifiedAt).toBeNull();
  });

  it("resolves an unrecognised tier downward, never upward", () => {
    const view = buildPublicPassportView(
      row({ owner_subject: "acme.com", owner_kind: "domain", owner_tier: "platinum" })
    );
    expect(view!.owner!.tier).toBe("unverified");
  });

  it("never lets a forged tier column promote a self-attested claim", () => {
    const view = buildPublicPassportView(
      row({ owner_subject: "acme.com", owner_kind: "idv", owner_tier: "" })
    );
    expect(view!.owner!.tier).toBe("unverified");
  });

  it("still never leaks the tenant id alongside an owner", () => {
    const view = buildPublicPassportView(
      row({
        owner_subject: "acme.com",
        owner_kind: "domain",
        owner_tier: "domain",
        user_id: "9f1d0c7a-0000-0000-0000-000000000000",
      })
    );
    expect(JSON.stringify(view)).not.toContain("9f1d0c7a");
  });
});


// ── Expiry and rotation on the public surface ───────────────────────────────
//
// Two false statements this page used to make, both because verify_passport
// returned neither deadline (fixed in 0052):
//
//   an EXPIRED passport rendered as "Valid" — the gateway refuses it
//   a key inside its ROTATION GRACE WINDOW returned 404 — the gateway accepts it
//
// The second is the one that reads backwards: "no such passport" about a
// credential that is minting visas right now.
describe("what the page says about a deadline", () => {
  const FUTURE = "2099-01-01T00:00:00.000Z";
  const PAST = "2020-01-01T00:00:00.000Z";
  const current = (o: Record<string, unknown> = {}) => row({ matched_current: true, agent_id: AGENT_UUID, ...o });

  it("publishes the expiry deadline so a reader can check it themselves", () => {
    const view = buildPublicPassportView(current({ expires_at: FUTURE }));
    expect(view?.expiresAt).toBe(FUTURE);
    expect(view?.status).toBe("active");
  });

  it("says a passport past its expiry is expired, not valid", () => {
    expect(buildPublicPassportView(current({ expires_at: PAST }))?.status).toBe("expired");
  });

  it("keeps never-expires as never-expires", () => {
    const view = buildPublicPassportView(current({ expires_at: null }));
    expect(view?.expiresAt).toBeNull();
    expect(view?.status).toBe("active");
  });

  // A revoked passport that also aged out is revoked. Same order the gateway
  // uses, and for its stated reason.
  it("keeps lifecycle status ahead of expiry", () => {
    expect(buildPublicPassportView(current({ status: "revoked", expires_at: PAST }))?.status).toBe("revoked");
  });

  it("marks a retired key as retired, and vouches for it while its grace window is open", () => {
    const view = buildPublicPassportView(
      row({ matched_current: false, agent_id: AGENT_UUID, previous_valid_until: FUTURE })
    );
    expect(view?.retired).toEqual({ notValidAfter: FUTURE });
    expect(view?.status).toBe("active");
  });

  it("expires a retired key once its grace window has closed", () => {
    const view = buildPublicPassportView(
      row({ matched_current: false, agent_id: AGENT_UUID, previous_valid_until: PAST })
    );
    expect(view?.status).toBe("expired");
  });

  it("says nothing about rotation when the current key was presented", () => {
    expect(buildPublicPassportView(current({ previous_valid_until: PAST }))?.retired).toBeNull();
  });
});

// Found by reading live output, not by a unit test: asked about a key retired
// by rotation, the page answered about the agent's CURRENT key — different
// passportId, different displayId. A counterparty checking a receipt signed by
// the retired key would have seen a document about a key that did not sign it.
// It also disclosed the successor key to anyone who asked about the old one,
// which nobody needs to know.
describe("the answer is about the key that was asked about", () => {
  const RETIRED_ID = "cmV0aXJlZHJldGlyZWRyZXRpcmVkcmV0aXJlZHJldGlyZWQ";

  it("echoes the presented retired key, never the successor", () => {
    const view = buildPublicPassportView(
      row({ matched_current: false, previous_valid_until: "2099-01-01T00:00:00.000Z" }),
      RETIRED_ID
    );
    expect(view?.passportId).toBe(RETIRED_ID);
    expect(view?.displayId).toContain("cmV0aXJl");
    expect(JSON.stringify(view)).not.toContain(PASSPORT_ID);
  });

  it("still reports the current key when that is what was asked about", () => {
    const view = buildPublicPassportView(row({ matched_current: true }), PASSPORT_ID);
    expect(view?.passportId).toBe(PASSPORT_ID);
  });

  // The row's own key remains the fallback, so a caller that does not thread
  // the presented id through still describes a real passport rather than none.
  it("falls back to the row's key when no presented id is given", () => {
    expect(buildPublicPassportView(row({ matched_current: true }))?.passportId).toBe(PASSPORT_ID);
  });
});

describe("a key that answers to two different agents", () => {
  // findAuthenticatablePassport refuses this rather than guess an identity: the
  // two columns are unique only within themselves, so one id can be tenant A's
  // current key and tenant V's retired one. Resolving it here would publish an
  // identity claim the gateway itself declines to make.
  it("refuses rather than describing either of them", async () => {
    const result = await lookupPublicPassport(
      db({ data: [row({ matched_current: true, matched_rows: 2 })], error: null }),
      PASSPORT_ID,
      IP
    );
    expect(result).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("proceeds when exactly one agent answers", async () => {
    const result = await lookupPublicPassport(
      db({ data: [row({ matched_current: true, matched_rows: 1 })], error: null }),
      PASSPORT_ID,
      IP
    );
    expect(result.ok).toBe(true);
  });

  // An instance that has not applied 0052 returns no count at all. Refusing
  // every passport on that basis would take the page down to protect against a
  // collision 0035 already makes unreachable for new rows.
  it("treats a missing count as no collision rather than refusing everything", async () => {
    for (const matched_rows of [undefined, null, "many"]) {
      const result = await lookupPublicPassport(
        db({ data: [row({ matched_current: true, matched_rows })], error: null }),
        PASSPORT_ID,
        IP
      );
      expect(result.ok, String(matched_rows)).toBe(true);
    }
  });

  // The count is how a collision is reported; the identities never are. This is
  // an unauthenticated endpoint, and knowing WHICH other tenant holds the key
  // buys the caller nothing it is entitled to.
  it("never returns the colliding identity", async () => {
    const result = await lookupPublicPassport(
      db({ data: [row({ matched_current: true, matched_rows: 2 })], error: null }),
      PASSPORT_ID,
      IP
    );
    expect(JSON.stringify(result)).not.toMatch(/agent|uuid|[0-9a-f]{8}-/i);
  });
});
