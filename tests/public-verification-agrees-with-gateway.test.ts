// The public answer and the gateway's decision must be the same answer.
//
// /verify tells a stranger whether a passport is good. The gateway decides
// whether it actually mints a visa. Those are two implementations of one rule,
// and before lib/passport-validity.ts existed they had already drifted: the
// gateway refused an expired passport with `passport_expired` while the page
// rendered a green "Valid", and the gateway ACCEPTED a key inside its rotation
// grace window while the page returned 404.
//
// So this file does not test either one in isolation. It drives the same row
// through both and asserts the verdicts correspond, which is the only assertion
// that catches them diverging again.
//
// The gateway side is exercised through its real lookup with a mocked database
// rather than by extracting a shared gate function. Factoring the gate order
// out of findAuthenticatablePassport is the better long-term fix, but it would
// put a public-surface change into the mint path — see the note in
// lib/passport-validity.ts.
import { describe, expect, it, vi } from "vitest";

import { findAuthenticatablePassport } from "@/lib/auth/passport";
import { buildPublicPassportView } from "@/lib/verify/passport";

const PASSPORT_ID = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyc28";
const AGENT_UUID = "11111111-1111-1111-1111-111111111111";
const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const PAST = "2026-09-01T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";

interface Scenario {
  name: string;
  status: string;
  expiresAt: string | null;
  previousValidUntil?: string | null;
  /** Whether the id being asked about is the RETIRED key. */
  retiredKey?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: "live passport, no expiry", status: "active", expiresAt: null },
  { name: "live passport, future expiry", status: "active", expiresAt: FUTURE },
  { name: "aged-out passport", status: "active", expiresAt: PAST },
  { name: "suspended", status: "suspended", expiresAt: null },
  { name: "revoked", status: "revoked", expiresAt: null },
  { name: "revoked AND aged out", status: "revoked", expiresAt: PAST },
  { name: "suspended AND aged out", status: "suspended", expiresAt: PAST },
  {
    name: "retired key inside its grace window",
    status: "active",
    expiresAt: null,
    previousValidUntil: FUTURE,
    retiredKey: true,
  },
  {
    name: "retired key past its grace window",
    status: "active",
    expiresAt: null,
    previousValidUntil: PAST,
    retiredKey: true,
  },
  {
    name: "current key while a retired one is still in grace",
    status: "active",
    expiresAt: null,
    previousValidUntil: FUTURE,
    retiredKey: false,
  },
  {
    name: "retired key on a passport that also aged out",
    status: "active",
    expiresAt: PAST,
    previousValidUntil: FUTURE,
    retiredKey: true,
  },
];

/**
 * The gateway's lookup, against a database holding exactly one agent. The
 * presented id matches the current-key column, the retired-key column, or
 * neither — matching how findBy issues two separate `.eq()` reads.
 */
function gatewayDb(scenario: Scenario) {
  const row = {
    id: AGENT_UUID,
    status: scenario.status,
    expires_at: scenario.expiresAt,
    previous_valid_until: scenario.previousValidUntil ?? null,
  };
  return {
    from: () => ({
      select: () => ({
        eq: (column: string) => ({
          maybeSingle: async () => ({
            data:
              column === (scenario.retiredKey ? "previous_passport_pubkey" : "passport_pubkey")
                ? row
                : null,
            error: null,
          }),
        }),
      }),
    }),
  } as never;
}

/** The same agent as verify_passport returns it. */
const publicRow = (scenario: Scenario) => ({
  passport_pubkey: PASSPORT_ID,
  status: scenario.status,
  created_at: "2026-07-01T09:30:00.000Z",
  expires_at: scenario.expiresAt,
  previous_valid_until: scenario.previousValidUntil ?? null,
  matched_current: !scenario.retiredKey,
  matched_rows: 1,
});

/** What the gateway's verdict means in the public vocabulary. */
function expectedPublicStatus(lookup: Awaited<ReturnType<typeof findAuthenticatablePassport>>) {
  if (lookup.ok) return "active";
  if (lookup.code === "passport_expired") return "expired";
  if (lookup.code === "agent_not_active") return "not_active";
  return "other";
}

describe("what /verify says matches what the gateway does", () => {
  it.each(SCENARIOS)("agrees about: $name", async (scenario) => {
    vi.setSystemTime(NOW);
    const lookup = await findAuthenticatablePassport(gatewayDb(scenario), PASSPORT_ID, "id", NOW);
    const view = buildPublicPassportView(publicRow(scenario));
    expect(view).not.toBeNull();

    const expected = expectedPublicStatus(lookup);
    if (expected === "not_active") {
      // The gateway collapses suspended and revoked into one refusal code; the
      // page keeps them apart, which is the whole reason its own gate order
      // puts status first. Either is a correct non-active answer.
      expect(["suspended", "revoked"]).toContain(view!.status);
      expect(view!.status).toBe(scenario.status);
      return;
    }
    expect(view!.status).toBe(expected);
    vi.useRealTimers();
  });

  // Stated as its own assertion because it is the pair of bugs this file was
  // written for, and a table can drift without anyone noticing a case vanished.
  it("no longer calls an expired passport valid, nor a working retired key missing", async () => {
    vi.setSystemTime(NOW);
    const expired = { name: "x", status: "active", expiresAt: PAST } satisfies Scenario;
    expect((await findAuthenticatablePassport(gatewayDb(expired), PASSPORT_ID, "id", NOW)).ok).toBe(false);
    expect(buildPublicPassportView(publicRow(expired))!.status).toBe("expired");

    const inGrace = {
      name: "y",
      status: "active",
      expiresAt: null,
      previousValidUntil: FUTURE,
      retiredKey: true,
    } satisfies Scenario;
    expect((await findAuthenticatablePassport(gatewayDb(inGrace), PASSPORT_ID, "id", NOW)).ok).toBe(true);
    const view = buildPublicPassportView(publicRow(inGrace));
    expect(view!.status).toBe("active");
    expect(view!.retired).toEqual({ notValidAfter: FUTURE });
    vi.useRealTimers();
  });
});
