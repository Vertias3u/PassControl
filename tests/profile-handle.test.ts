// Operator handles — the string that becomes /@handle.
//
// A handle is an identity claim on an identity product, so the two tests that
// earn their keep here are the ones that are easy to get subtly wrong:
//
//   1. PARITY WITH THE DATABASE. 0033 puts a CHECK constraint on the same
//      string. If the TypeScript pattern is looser by even one character, a
//      handle passes validation and then raises 23514 at the write — a code
//      nothing maps, surfacing as a generic failure. The plan file that
//      preceded 0033 did in fact carry a looser pattern (hyphens allowed, 32
//      characters, trailing underscore permitted), which is exactly how this
//      drift happens.
//   2. RESERVED WORDS ARE TS-ONLY. There is no database constraint for them, so
//      the check has to live where it cannot be skipped, and the list has to
//      keep up with the routes. The sweep over app/ below fails when someone
//      adds a top-level route without reserving its name.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  HANDLE_PATTERN,
  RESERVED_HANDLES,
  normalizeHandle,
  validateHandle,
} from "@/lib/profile/handle";

describe("the handle pattern", () => {
  // The one assertion that keeps TypeScript and Postgres describing the same
  // set of strings. Extracted from the constraint rather than restated, so
  // editing the migration alone turns this red.
  it("is character-for-character the constraint in 0033", () => {
    const migration = readFileSync(
      join(process.cwd(), "db/migrations/0033_operator_profile.sql"),
      "utf8"
    );
    const constraint = migration.match(
      /add constraint users_username_shape\s*\n?\s*check \(username is null or username ~ '([^']+)'\)/i
    );
    expect(constraint, "0033 no longer declares users_username_shape as expected").toBeTruthy();
    expect(HANDLE_PATTERN.source).toBe(constraint![1]);
  });

  it("accepts the shapes the product promises", () => {
    for (const handle of ["abc", "a1b", "vertias_ops", "a".repeat(HANDLE_MAX_LENGTH), "0mega"]) {
      expect(HANDLE_PATTERN.test(handle), handle).toBe(true);
    }
  });

  it("refuses the shapes the constraint refuses", () => {
    for (const handle of [
      "ab", // shorter than the minimum
      "a".repeat(HANDLE_MAX_LENGTH + 1),
      "_lead", // must start alphanumeric
      "trail_", // and end alphanumeric
      "has-hyphen", // reserved for a future namespace separator
      "has space",
      "Upper", // uppercase is unstorable, which is what makes the index case-insensitive
      "emoji🙂",
      "dot.ted",
    ]) {
      expect(HANDLE_PATTERN.test(handle), handle).toBe(false);
    }
  });

  it("agrees with its own advertised bounds", () => {
    expect(HANDLE_PATTERN.test("a".repeat(HANDLE_MIN_LENGTH))).toBe(true);
    expect(HANDLE_PATTERN.test("a".repeat(HANDLE_MIN_LENGTH - 1))).toBe(false);
    expect(HANDLE_PATTERN.test("a".repeat(HANDLE_MAX_LENGTH))).toBe(true);
    expect(HANDLE_PATTERN.test("a".repeat(HANDLE_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("normalising a handle", () => {
  // The database lowercases in public_operator_profile() too. Doing it here as
  // well is 0015's "a mistake has to be made twice" rule, not redundancy.
  it("lowercases, trims, and tolerates the @ people type", () => {
    expect(normalizeHandle("  @VertiasOps ")).toBe("vertiasops");
    expect(normalizeHandle("ALICE")).toBe("alice");
  });

  it("returns empty for anything that is not a string", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(normalizeHandle(value)).toBe("");
    }
  });

  // Only ONE leading @, so `@@admin` does not normalise into `admin` and slip
  // past the reserved list.
  it("strips exactly one leading @", () => {
    expect(validateHandle("@@admin").ok).toBe(false);
  });
});

describe("validating a handle", () => {
  it("returns the normalised form on success", () => {
    const result = validateHandle("  @VertiasOps  ");
    expect(result).toEqual({ ok: true, handle: "vertiasops" });
  });

  it("rejects a bad shape as invalid_handle", () => {
    expect(validateHandle("no")).toEqual({ ok: false, reason: "invalid_handle" });
    expect(validateHandle("has-hyphen")).toEqual({ ok: false, reason: "invalid_handle" });
  });

  it("rejects a reserved word even though its shape is fine", () => {
    expect(HANDLE_PATTERN.test("dashboard")).toBe(true);
    expect(validateHandle("dashboard")).toEqual({ ok: false, reason: "reserved_handle" });
  });

  // Reserved matching happens after normalisation or it does not happen at all.
  it("reserves case-insensitively", () => {
    expect(validateHandle("DashBoard")).toEqual({ ok: false, reason: "reserved_handle" });
  });
});

describe("the reserved list", () => {
  // Self-maintaining: adding app/settings/ without reserving "settings" would
  // let an operator claim /@settings, and the middleware rewrite would then
  // hand /@settings to a profile page while /settings serves the real route —
  // two different pages one keystroke apart on an identity product.
  it("covers every top-level route directory in app/", () => {
    const routes = readdirSync(join(process.cwd(), "app"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Dynamic and grouped segments are not claimable names.
      .filter((name) => HANDLE_PATTERN.test(name));

    expect(routes.length).toBeGreaterThan(3);
    for (const route of routes) {
      expect(RESERVED_HANDLES.has(route), `app/${route}/ is not a reserved handle`).toBe(true);
    }
  });

  it("reserves the names that would impersonate the product itself", () => {
    for (const word of ["passcontrol", "vertias", "admin", "support", "security", "official"]) {
      expect(RESERVED_HANDLES.has(word), word).toBe(true);
    }
  });

  // A reserved word that cannot be typed as a handle anyway is dead weight, and
  // more importantly it hides a typo in the list.
  it("contains only strings that are otherwise valid handles", () => {
    for (const word of RESERVED_HANDLES) {
      expect(HANDLE_PATTERN.test(word), `"${word}" could never be claimed anyway`).toBe(true);
    }
  });
});
