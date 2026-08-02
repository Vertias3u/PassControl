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
