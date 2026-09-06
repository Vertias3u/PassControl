// The workspace expectation, and the one thing it must never become.
//
// research/passport-key-protection.md §5 allows the settings tab exactly this:
// "let the operator state an expectation for the workspace — a stated policy
// people can act on, not an enforced one". So this is two unverified things
// being compared: a policy somebody typed, against a claim an agent made about
// itself. Neither was checked, and nothing here may read as a gate.
import { describe, expect, it, vi } from "vitest";

import {
  KEY_CUSTODY_EXPECTATION_COLUMN,
  expectationVerdict,
  parseKeyCustodyExpectation,
  readKeyCustodyExpectation,
  writeKeyCustodyExpectation,
} from "@/lib/key-custody-expectation";
import { toDeclaredKeyStorageView } from "@/lib/passport-key-storage";

const AT = "2026-09-01T10:00:00.000Z";
const declared = (store: string, fallback = false) =>
  toDeclaredKeyStorageView({ store, fallback, declaredAt: AT }, null);
const undeclared = () => toDeclaredKeyStorageView(null, null);

describe("what an operator may state", () => {
  it("reads a stated store and treats every way of saying nothing as nothing", () => {
    expect(parseKeyCustodyExpectation("os")).toBe("os");
    expect(parseKeyCustodyExpectation("none")).toBeNull();
    expect(parseKeyCustodyExpectation("")).toBeNull();
    expect(parseKeyCustodyExpectation("   ")).toBeNull();
    expect(parseKeyCustodyExpectation(null)).toBeNull();
    expect(parseKeyCustodyExpectation(undefined)).toBeNull();
  });

  // Same door, same bound as the agent's own declaration: this string reaches a
  // dashboard, and a settings field is no less client-controlled than a payload.
  it("refuses anything that is not a short lowercase token", () => {
    expect(parseKeyCustodyExpectation("OS")).toBeNull();
    expect(parseKeyCustodyExpectation("<script>")).toBeNull();
    expect(parseKeyCustodyExpectation("os store")).toBeNull();
    expect(parseKeyCustodyExpectation("x".repeat(33))).toBeNull();
    expect(parseKeyCustodyExpectation(7)).toBeNull();
  });
});

describe("comparing a declaration to the expectation", () => {
  it("says nothing at all when no expectation was stated", () => {
    expect(expectationVerdict(declared("file"), null)).toBe("not_stated");
    expect(expectationVerdict(undeclared(), null)).toBe("not_stated");
  });

  it("meets the expectation when the declared tier reaches it", () => {
    expect(expectationVerdict(declared("os"), "os")).toBe("meets");
    expect(expectationVerdict(declared("file"), "file")).toBe("meets");
  });

  it("falls short when the declared tier is below it", () => {
    expect(expectationVerdict(declared("file"), "os")).toBe("short");
  });

  // The whole reason this compares tiers and not strings. An agent on a tier
  // that shipped after this build is not BELOW an expectation of tier 1 — but
  // `declared === expected` would say it is, which is the same forward-
  // compatibility lie the panel's unrecognised state exists to prevent.
  it("never reads a tier it cannot name as a shortfall", () => {
    expect(expectationVerdict(declared("enclave"), "os")).toBe("unknown");
    expect(expectationVerdict(declared("os"), "enclave")).toBe("unknown");
  });

  // Silence has several causes and none of them is "the key is in a file", so
  // it cannot be a violation. It cannot be compliance either.
  it("gives an undeclared agent its own answer rather than a verdict", () => {
    expect(expectationVerdict(undeclared(), "os")).toBe("unknown");
  });

  // The agent MEANT to be on tier 1 and is not. It is running on tier 0, so it
  // falls short of a tier 1 expectation — the intent does not count.
  it("judges a fallback on where the key actually is", () => {
    expect(expectationVerdict(declared("file", true), "os")).toBe("short");
  });
});

function fakeDb(result: { data?: unknown; error?: { code?: string } | null }) {
  const maybeSingle = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from, select, eq };
}

describe("reading the expectation off an instance that may not have the column", () => {
  it("reads a stated expectation", async () => {
    const db = fakeDb({ data: { [KEY_CUSTODY_EXPECTATION_COLUMN]: "os" } });
    expect(await readKeyCustodyExpectation(db as never, "user-1")).toEqual({
      state: "ready",
      expectation: "os",
    });
  });

  it("reads an operator who has stated nothing", async () => {
    const db = fakeDb({ data: { [KEY_CUSTODY_EXPECTATION_COLUMN]: null } });
    expect(await readKeyCustodyExpectation(db as never, "user-1")).toEqual({
      state: "ready",
      expectation: null,
    });
  });

  // A brand-new operator has no users row at all — nothing creates one at
  // signup. That is "stated nothing", not a failure.
  it("treats a missing profile row as nothing stated", async () => {
    const db = fakeDb({ data: null });
    expect(await readKeyCustodyExpectation(db as never, "user-1")).toEqual({
      state: "ready",
      expectation: null,
    });
  });

  // The migration is the owner's to apply, and Cloud and self-hosters will run
  // builds that have this code and not the column. That must degrade to "this
  // instance cannot offer it yet", never to "you have stated no expectation" —
  // which would invite the operator to state one into a control that throws.
  it("distinguishes an unmigrated instance from an operator who stated nothing", async () => {
    const db = fakeDb({ error: { code: "42703" } });
    expect(await readKeyCustodyExpectation(db as never, "user-1")).toEqual({
      state: "unmigrated",
      expectation: null,
    });
  });

  it("reports any other query failure as unavailable rather than as an answer", async () => {
    const db = fakeDb({ error: { code: "57014" } });
    expect(await readKeyCustodyExpectation(db as never, "user-1")).toEqual({
      state: "unavailable",
      expectation: null,
    });
  });

  it("asks only for the one column, never the whole profile", async () => {
    const db = fakeDb({ data: { [KEY_CUSTODY_EXPECTATION_COLUMN]: "os" } });
    await readKeyCustodyExpectation(db as never, "user-1");
    expect(db.select).toHaveBeenCalledWith(KEY_CUSTODY_EXPECTATION_COLUMN);
    expect(db.eq).toHaveBeenCalledWith("id", "user-1");
  });
});

describe("writing the expectation", () => {
  function fakeWriteDb(error: { code?: string } | null = null) {
    const eq = vi.fn(async () => ({ error }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    return { from, update, eq };
  }

  it("writes the stated store against the caller's own row", async () => {
    const db = fakeWriteDb();
    expect(await writeKeyCustodyExpectation(db as never, "user-1", "os")).toEqual({ ok: true });
    expect(db.update).toHaveBeenCalledWith({ [KEY_CUSTODY_EXPECTATION_COLUMN]: "os" });
    expect(db.eq).toHaveBeenCalledWith("id", "user-1");
  });

  it("clears the expectation with null rather than a magic string", async () => {
    const db = fakeWriteDb();
    await writeKeyCustodyExpectation(db as never, "user-1", null);
    expect(db.update).toHaveBeenCalledWith({ [KEY_CUSTODY_EXPECTATION_COLUMN]: null });
  });

  it("refuses a store this build cannot name a tier for", async () => {
    const db = fakeWriteDb();
    expect(await writeKeyCustodyExpectation(db as never, "user-1", "enclave")).toEqual({
      ok: false,
      code: "unknown_store",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("names an unmigrated instance instead of reporting a generic failure", async () => {
    expect(await writeKeyCustodyExpectation(fakeWriteDb({ code: "PGRST204" }) as never, "u", "os")).toEqual({
      ok: false,
      code: "unmigrated",
    });
    expect(await writeKeyCustodyExpectation(fakeWriteDb({ code: "42703" }) as never, "u", "os")).toEqual({
      ok: false,
      code: "unmigrated",
    });
    expect(await writeKeyCustodyExpectation(fakeWriteDb({ code: "23514" }) as never, "u", "os")).toEqual({
      ok: false,
      code: "write_failed",
    });
  });
});
