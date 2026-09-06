// One rule about whether a passport is good right now, in one place.
//
// It already exists once, as the gate order inside findAuthenticatablePassport
// (lib/auth/passport.ts): status, then passport expiry, then the retired-key
// deadline. That order is policy, not preference — its own header says so — and
// the public surfaces have to give the SAME answer the gateway would, or the
// product states one fact two ways.
//
// Before this module there were two public surfaces and neither knew about
// expiry at all: /verify reported an expired passport as "Valid", and the
// operator profile listing at /u/<handle> did the same.
import { describe, expect, it } from "vitest";

import { effectivePassportStatus } from "@/lib/passport-validity";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const PAST = "2026-09-01T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";

describe("the order of the gates", () => {
  it("reports a live passport as active", () => {
    expect(effectivePassportStatus({ status: "active", expiresAt: FUTURE }, NOW)).toBe("active");
    expect(effectivePassportStatus({ status: "active", expiresAt: null }, NOW)).toBe("active");
  });

  it("reports a passport past its expiry as expired, not active", () => {
    expect(effectivePassportStatus({ status: "active", expiresAt: PAST }, NOW)).toBe("expired");
  });

  // Status comes FIRST, exactly as the gateway orders it: an operator debugging
  // a fleet has to be able to tell "someone revoked this" from "this aged out",
  // and a revoked passport that also expired is still revoked.
  it("keeps status ahead of expiry, in both directions", () => {
    expect(effectivePassportStatus({ status: "revoked", expiresAt: PAST }, NOW)).toBe("revoked");
    expect(effectivePassportStatus({ status: "suspended", expiresAt: PAST }, NOW)).toBe("suspended");
    expect(effectivePassportStatus({ status: "revoked", expiresAt: FUTURE }, NOW)).toBe("revoked");
  });

  // A key inside its rotation grace window still mints visas, so the public
  // answer is `active` — anything else would say a working key is dead.
  it("accepts a retired key while its grace window is open", () => {
    expect(
      effectivePassportStatus(
        { status: "active", expiresAt: null, usedRetiredKey: true, retiredValidUntil: FUTURE },
        NOW
      )
    ).toBe("active");
  });

  it("expires a retired key once its grace window closes", () => {
    expect(
      effectivePassportStatus(
        { status: "active", expiresAt: null, usedRetiredKey: true, retiredValidUntil: PAST },
        NOW
      )
    ).toBe("expired");
  });

  // Rotation always stamps a deadline, so this is unreachable through the
  // product — which is exactly why it must fail closed rather than be left to
  // whoever next writes that column by hand. Mirrors the gateway's isPast(),
  // which returns true for a null or unparseable value for the same reason.
  it("refuses a retired key with no readable deadline", () => {
    for (const deadline of [null, "", "whenever"]) {
      expect(
        effectivePassportStatus(
          { status: "active", expiresAt: null, usedRetiredKey: true, retiredValidUntil: deadline },
          NOW
        )
      ).toBe("expired");
    }
  });

  // The deadline on a retired key does not bind the CURRENT key. A row mid-way
  // through a rotation would otherwise report its live key as dead.
  it("ignores the retired deadline when the current key was presented", () => {
    expect(
      effectivePassportStatus(
        { status: "active", expiresAt: null, usedRetiredKey: false, retiredValidUntil: PAST },
        NOW
      )
    ).toBe("active");
  });

  // Same discipline as the normalisers next door: drift resolves DOWN, never to
  // "active". A page that guesses "valid" about a state it does not understand
  // is worse than one that admits it does not know.
  it("resolves an unrecognised lifecycle state to unknown", () => {
    expect(effectivePassportStatus({ status: "archived", expiresAt: null }, NOW)).toBe("unknown");
    expect(effectivePassportStatus({ status: null, expiresAt: null }, NOW)).toBe("unknown");
  });

  // An unparseable expiry is not permission to say "valid".
  it("treats an unreadable expiry as expired rather than ignoring it", () => {
    expect(effectivePassportStatus({ status: "active", expiresAt: "soon" }, NOW)).toBe("expired");
  });
});
