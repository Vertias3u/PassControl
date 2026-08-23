// Writes to the operator profile.
//
// Three properties here are worth more than the rest, because each one looks
// completely correct when it is wrong:
//
//   1. updateProfile() must not write `username` or `profile_public`. Both
//      carry a side effect that lives in another function, and a generic
//      field-mapping loop that accepted them would skip it silently.
//   2. setHandle() must insert the retirement row BEFORE freeing the handle.
//      There is no transaction. Update-first fails open — the old handle is
//      released and claimable by a stranger, the exact impersonation
//      retired_usernames exists to stop.
//   3. setProfilePublic(false) must rotate avatar_key. 0033's
//      avatar_object_path() is keyed on avatar_key alone and does not check
//      profile_public, so rotation is the ONLY revocation an already-shared
//      avatar URL ever gets.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROFILE_EDITABLE_FIELDS,
  PROFILE_SIDE_EFFECT_FIELDS,
  clearAvatar,
  newAvatarKey,
  readProfile,
  setAvatar,
  setHandle,
  setProfilePublic,
  updateProfile,
} from "@/lib/profile/manage";

const USER_ID = "11111111-1111-1111-1111-111111111111";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    username: "vertiasops",
    display_name: "Vertias Ops",
    bio: null,
    website_url: null,
    company: null,
    timezone: null,
    profile_public: false,
    avatar_path: null,
    avatar_key: null,
    handle_locked_at: null,
    created_at: "2026-01-04T10:00:00.000Z",
    ...overrides,
  };
}

/** Records the order operations reach the database, which is the point of (2). */
let calls: { table: string; op: string; payload: unknown }[] = [];
let updateResult: { data: unknown; error: unknown };
let selectResult: { data: unknown; error: unknown };
let retireResult: { error: unknown };
let rpcResult: { data: unknown; error: unknown };

function admin() {
  const table = (name: string) => {
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      eq: () => builder,
      update: (patch: unknown) => {
        calls.push({ table: name, op: "update", payload: patch });
        return builder;
      },
      upsert: (row: unknown) => {
        calls.push({ table: name, op: "upsert", payload: row });
        return name === "retired_usernames"
          ? Promise.resolve(retireResult)
          : (builder as unknown as Promise<unknown>);
      },
      maybeSingle: async () => {
        const last = calls[calls.length - 1];
        return last?.op === "update" ? updateResult : selectResult;
      },
    });
    return builder;
  };
  return {
    from: (name: string) => table(name),
    rpc: async (fn: string, args: unknown) => {
      calls.push({ table: `rpc:${fn}`, op: "rpc", payload: args });
      return rpcResult;
    },
  } as never;
}

function patches(table = "users"): Record<string, unknown>[] {
  return calls
    .filter((c) => c.table === table && c.op === "update")
    .map((c) => c.payload as Record<string, unknown>);
}

beforeEach(() => {
  calls = [];
  selectResult = { data: baseRow(), error: null };
  updateResult = { data: baseRow(), error: null };
  retireResult = { error: null };
  rpcResult = { data: [{ status: "ok", username: "newhandle", handle_locked_at: null }], error: null };
  vi.restoreAllMocks();
});

describe("the editable field list", () => {
  // The rule stated as an assertion rather than only as a comment.
  it("excludes the two fields that have side effects elsewhere", () => {
    for (const field of PROFILE_SIDE_EFFECT_FIELDS) {
      expect(PROFILE_EDITABLE_FIELDS as readonly string[]).not.toContain(field);
    }
  });
});

describe("updateProfile", () => {
  it("writes the plain fields it is given", async () => {
    await updateProfile(admin(), USER_ID, { display_name: "  Vertias Ops  ", company: "Vertias" });
    expect(patches()[0]).toMatchObject({ display_name: "Vertias Ops", company: "Vertias" });
  });

  // (1). Accepting either of these would look like a working edit and quietly
  // skip handle retirement or avatar-key rotation.
  it("refuses to write username or profile_public, however they are passed", async () => {
    await updateProfile(admin(), USER_ID, {
      display_name: "Ops",
      username: "someoneelse",
      profile_public: true,
      plan: "enterprise",
      email: "attacker@example.test",
      id: "22222222-2222-2222-2222-222222222222",
    });
    const patch = patches()[0]!;
    expect(patch).not.toHaveProperty("username");
    expect(patch).not.toHaveProperty("profile_public");
    expect(patch).not.toHaveProperty("plan");
    expect(patch).not.toHaveProperty("email");
    expect(patch).not.toHaveProperty("id");
  });

  // A submission of nothing but the two dropped fields would otherwise report a
  // saved edit that never happened.
  it("reports no_changes rather than succeeding at writing nothing", async () => {
    const result = await updateProfile(admin(), USER_ID, { username: "x", profile_public: true });
    expect(result).toEqual({ ok: false, status: 400, code: "no_changes" });
    expect(patches()).toHaveLength(0);
  });

  it("clears a field set to blank rather than storing an empty string", async () => {
    await updateProfile(admin(), USER_ID, { bio: "   " });
    expect(patches()[0]).toMatchObject({ bio: null });
  });

  it("stamps updated_at on every write", async () => {
    await updateProfile(admin(), USER_ID, { bio: "hi" });
    expect(typeof patches()[0]!.updated_at).toBe("string");
  });

  // Validating here rather than only in the server action means a second caller
  // added later cannot skip a check it does not have to remember.
  it("refuses a hostile website before it reaches the database", async () => {
    const result = await updateProfile(admin(), USER_ID, { website_url: "javascript:alert(1)" });
    expect(result).toEqual({ ok: false, status: 400, code: "invalid_website" });
    expect(patches()).toHaveLength(0);
  });

  it("normalises an accepted website", async () => {
    await updateProfile(admin(), USER_ID, { website_url: "vertias.eu" });
    expect(patches()[0]).toMatchObject({ website_url: "https://vertias.eu/" });
  });

  it("refuses over-long text rather than letting the CHECK constraint do it", async () => {
    const result = await updateProfile(admin(), USER_ID, { bio: "a".repeat(281) });
    expect(result).toEqual({ ok: false, status: 400, code: "bio_too_long" });
    expect(patches()).toHaveLength(0);
  });

  it("refuses a timezone the runtime cannot format with", async () => {
    expect(await updateProfile(admin(), USER_ID, { timezone: "Mars/Olympus" })).toEqual({
      ok: false,
      status: 400,
      code: "invalid_timezone",
    });
    const good = await updateProfile(admin(), USER_ID, { timezone: "Europe/Prague" });
    expect(good.ok).toBe(true);
  });

  it("reports no_profile rather than a successful write of nothing", async () => {
    updateResult = { data: null, error: null };
    expect(await updateProfile(admin(), USER_ID, { bio: "hi" })).toEqual({
      ok: false,
      status: 409,
      code: "no_profile",
    });
  });
});

describe("setHandle", () => {
  const rpcCalls = () => calls.filter((c) => c.table === "rpc:change_handle");

  it("rejects a bad shape and a reserved word without touching the database", async () => {
    expect(await setHandle(admin(), USER_ID, "no")).toEqual({
      ok: false,
      status: 400,
      code: "invalid_handle",
    });
    expect(await setHandle(admin(), USER_ID, "dashboard")).toEqual({
      ok: false,
      status: 400,
      code: "reserved_handle",
    });
    // The reserved list lives here and nowhere else — the database has no
    // notion of which strings are route names.
    expect(calls).toHaveLength(0);
  });

  it("sends the normalised handle to the atomic function", async () => {
    await setHandle(admin(), USER_ID, "  @NewHandle ");
    expect(rpcCalls()[0]!.payload).toEqual({ p_user_id: USER_ID, p_new_username: "newhandle" });
  });

  // ONE call. The retirement and the rename are one transaction inside 0034's
  // change_handle(), which is what removed the two-statement ordering hazard —
  // and, with it, the old behaviour where a REFUSED change still retired the
  // handle the operator kept.
  it("does the whole change in a single database call", async () => {
    await setHandle(admin(), USER_ID, "newhandle");
    expect(rpcCalls()).toHaveLength(1);
    // Nothing writes retired_usernames or users from TypeScript any more.
    expect(calls.filter((c) => c.table === "retired_usernames")).toHaveLength(0);
    expect(patches()).toHaveLength(0);
  });

  // 0033 raises unique_violation for a retired handle as well as a held one, so
  // that the two are indistinguishable. One status, one message, no oracle.
  it("reports a taken handle without revealing that it was once used", async () => {
    rpcResult = { data: [{ status: "taken", username: "vertiasops", handle_locked_at: null }], error: null };
    expect(await setHandle(admin(), USER_ID, "newhandle")).toEqual({
      ok: false,
      status: 409,
      code: "handle_taken",
    });
  });

  it("reports a locked handle distinctly, because that message is actionable", async () => {
    rpcResult = { data: [{ status: "locked", username: "vertiasops", handle_locked_at: "2026-02-01T00:00:00.000Z" }], error: null };
    expect(await setHandle(admin(), USER_ID, "newhandle")).toEqual({
      ok: false,
      status: 409,
      code: "handle_locked",
    });
  });

  it("reports a missing profile row", async () => {
    rpcResult = { data: [{ status: "no_profile", username: null, handle_locked_at: null }], error: null };
    expect(await setHandle(admin(), USER_ID, "newhandle")).toEqual({
      ok: false,
      status: 409,
      code: "no_profile",
    });
  });

  // An unrecognised status is schema drift. It must not read as success — this
  // is the one write in the module that consumes a name out of a global,
  // permanent namespace.
  it("never treats an unknown status as success", async () => {
    for (const status of ["surprise", null, undefined, 7]) {
      rpcResult = { data: [{ status }], error: null };
      const result = await setHandle(admin(), USER_ID, "newhandle");
      expect(result.ok, String(status)).toBe(false);
    }
    rpcResult = { data: null, error: { message: "down" } };
    expect((await setHandle(admin(), USER_ID, "newhandle")).ok).toBe(false);
  });
});

describe("locking the handle at first publish", () => {
  // The rule: free to change while private, permanent once published. Locking
  // at first SAVE would make a typo in the very first form a new operator
  // touches unfixable; locking at first PUBLISH means nothing outside the
  // account can depend on it until the operator deliberately says so.
  it("stamps the lock when the profile is first published", async () => {
    await setProfilePublic(admin(), USER_ID, true);
    expect(typeof patches()[0]!.handle_locked_at).toBe("string");
  });

  it("does not re-stamp a handle that is already locked", async () => {
    selectResult = { data: baseRow({ handle_locked_at: "2026-02-01T00:00:00.000Z" }), error: null };
    await setProfilePublic(admin(), USER_ID, true);
    expect(patches()[0]).not.toHaveProperty("handle_locked_at");
  });

  // The lock is ONE-WAY. Un-publishing must not release it, or the whole rule
  // reduces to "change it whenever you like, via two extra clicks".
  it("does not release the lock when the profile goes private again", async () => {
    selectResult = {
      data: baseRow({ profile_public: true, handle_locked_at: "2026-02-01T00:00:00.000Z" }),
      error: null,
    };
    await setProfilePublic(admin(), USER_ID, false);
    expect(patches()[0]).not.toHaveProperty("handle_locked_at");
  });

  // The refusal itself lives in 0034's change_handle(), together with the
  // no-op-resubmit exemption — db/tests/public_profile_invariants.sql drives
  // both against a real database. What this pins is that the status is not
  // flattened into a generic failure on the way back.
  it("surfaces the lock as its own code, not as a generic write failure", async () => {
    rpcResult = { data: [{ status: "locked", username: "vertiasops", handle_locked_at: "2026-02-01T00:00:00.000Z" }], error: null };
    expect(await setHandle(admin(), USER_ID, "somethingelse")).toEqual({
      ok: false,
      status: 409,
      code: "handle_locked",
    });
  });

  it("still allows a change while the profile has never been published", async () => {
    const result = await setHandle(admin(), USER_ID, "newhandle");
    expect(result.ok).toBe(true);
  });
});

describe("setProfilePublic", () => {
  // (3). Without this the operator goes private and every avatar URL a stranger
  // already has keeps working, because avatar_object_path() never checks
  // profile_public.
  it("rotates avatar_key when the profile goes private", async () => {
    selectResult = { data: baseRow({ profile_public: true, avatar_key: "oldkey", avatar_path: "u/a" }), error: null };
    await setProfilePublic(admin(), USER_ID, false);
    const patch = patches()[0]!;
    expect(patch.profile_public).toBe(false);
    expect(typeof patch.avatar_key).toBe("string");
    expect(patch.avatar_key).not.toBe("oldkey");
  });

  // A key with no object behind it is a guaranteed 404, and the public page has
  // no way to know that — avatar_path is private. Publishing then rendered a
  // broken image to strangers.
  it("does not mint a key for an operator who has no avatar to revoke", async () => {
    selectResult = { data: baseRow({ profile_public: true, avatar_path: null }), error: null };
    await setProfilePublic(admin(), USER_ID, false);
    expect(patches()[0]).not.toHaveProperty("avatar_key");
  });

  // Going public must not rotate: the operator's own sidebar chip is already
  // showing that URL, and there is nothing to revoke on the way in.
  it("leaves the key alone when the profile goes public", async () => {
    await setProfilePublic(admin(), USER_ID, true);
    expect(patches()[0]).not.toHaveProperty("avatar_key");
  });

  it("refuses to publish a profile that has no handle to be public at", async () => {
    selectResult = { data: baseRow({ username: null }), error: null };
    expect(await setProfilePublic(admin(), USER_ID, true)).toEqual({
      ok: false,
      status: 400,
      code: "no_handle",
    });
    expect(patches()).toHaveLength(0);
  });

  it("still allows a handle-less profile to be made private", async () => {
    selectResult = { data: baseRow({ username: null, profile_public: true }), error: null };
    expect((await setProfilePublic(admin(), USER_ID, false)).ok).toBe(true);
  });
});

describe("avatars", () => {
  it("issues a fresh key on every upload, so an old URL stops resolving", async () => {
    await setAvatar(admin(), USER_ID, `${USER_ID}/avatar`);
    const patch = patches()[0]!;
    expect(patch.avatar_path).toBe(`${USER_ID}/avatar`);
    expect(typeof patch.avatar_key).toBe("string");
  });

  it("clears the key as well as the path, leaving no live URL behind", async () => {
    await clearAvatar(admin(), USER_ID);
    expect(patches()[0]).toMatchObject({ avatar_path: null, avatar_key: null });
  });

  it("mints unguessable, distinct keys", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newAvatarKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      // 16 random bytes as base64url. Long enough that the /avatars/<key> route
      // is not enumerable, which is what lets it skip an auth check entirely.
      expect(key).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    }
  });
});

describe("readProfile", () => {
  // A freshly signed-up operator has no row — see ensureProfileRow's note. A
  // reader that treated that as an error would break the dashboard for every
  // new account.
  it("returns null for an operator with no row, not an error", async () => {
    selectResult = { data: null, error: null };
    expect(await readProfile(admin(), USER_ID)).toEqual({ ok: true, data: null });
  });

  it("reports a real query failure", async () => {
    selectResult = { data: null, error: { message: "down" } };
    expect(await readProfile(admin(), USER_ID)).toEqual({
      ok: false,
      status: 500,
      code: "query_failed",
    });
  });
});
