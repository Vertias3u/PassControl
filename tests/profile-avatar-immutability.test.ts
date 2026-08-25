// An avatar key names one set of bytes, forever.
//
// `app/avatars/[key]/route.ts` serves with `max-age=31536000, immutable`, and
// justifies it in its own header: "a given key can only ever name one set of
// bytes. A new upload mints a new key." That sentence is only true if the
// STORAGE OBJECT is per-key too.
//
// It was not. uploadAvatar wrote every upload to the fixed path
// `<userId>/avatar` with `upsert: true`, and only then minted the new key. So
// between those two statements the still-live previous key resolved, through
// avatar_object_path(), to the replacement bytes — and if the row update then
// failed, it stayed that way permanently while the operator was told the image
// could not be stored. Every cache holding the old URL for a year is serving a
// picture the operator believes they replaced.
//
// Deriving the object path from the newly minted key removes the dilemma
// instead of trading one horn for the other: old and new never name the same
// object, so neither ordering can cross them.
//
// Source-text assertions for the action, following
// tests/account-avatar-deletion.test.ts — uploadAvatar is bound to cookies,
// MFA, rate limiting and Storage, and what matters here is which value the
// upload path is built from. Comments are stripped so prose about the rule
// cannot satisfy the rule.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { avatarObjectPath, setAvatar } from "@/lib/profile/manage";

const SOURCE = readFileSync(
  join(process.cwd(), "app/dashboard/settings/profile-actions.ts"),
  "utf8"
);
const CODE = SOURCE.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const USER_ID = "11111111-1111-1111-1111-111111111111";

describe("the avatar object path", () => {
  it("is never the fixed per-user path that overwrites in place", () => {
    expect(CODE).not.toMatch(/\$\{\s*acting\.userId\s*\}\/avatar["'`]/);
  });

  it("is derived from the key that is about to become live", () => {
    expect(CODE).toMatch(/avatarObjectPath\s*\(/);
    const minted = CODE.indexOf("newAvatarKey()");
    const derived = CODE.indexOf("avatarObjectPath(");
    const uploaded = CODE.indexOf(".upload(");
    expect(minted, "the action no longer mints the key itself").toBeGreaterThan(-1);
    expect(derived).toBeGreaterThan(minted);
    expect(uploaded).toBeGreaterThan(derived);
  });

  it("does not overwrite an existing object", () => {
    // A fresh 128-bit path per upload means upsert can only ever mask a bug.
    expect(CODE).not.toMatch(/upsert:\s*true/);
  });

  it("hands setAvatar the same key the path was built from", () => {
    expect(CODE).toMatch(/setAvatar\s*\(\s*admin\s*,\s*acting\.userId\s*,\s*objectPath\s*,\s*avatarKey\s*\)/);
  });

  it("removes the just-uploaded object when the row update fails", () => {
    // Otherwise the bytes sit in the bucket with no key naming them and no
    // sweep to find them — the same orphan account deletion already guards.
    // Anchored to the upload, because saveProfile has its own `!result.ok`.
    const uploaded = CODE.indexOf(".upload(");
    expect(uploaded).toBeGreaterThan(-1);
    const failure = CODE.indexOf("if (!result.ok)", uploaded);
    expect(failure, "uploadAvatar no longer checks the row update").toBeGreaterThan(-1);
    const branch = CODE.slice(failure, failure + 400);
    expect(branch).toMatch(/remove\(\s*\[\s*objectPath\s*\]\s*\)/);
  });
});

describe("avatarObjectPath", () => {
  it("puts the key in the path, so two keys cannot share an object", () => {
    const a = avatarObjectPath(USER_ID, "keyAAAAAAAAAAAAAAAAAAA");
    const b = avatarObjectPath(USER_ID, "keyBBBBBBBBBBBBBBBBBBB");
    expect(a).not.toBe(b);
    expect(a).toContain("keyAAAAAAAAAAAAAAAAAAA");
  });

  it("keeps every object under the owner's own prefix", () => {
    expect(avatarObjectPath(USER_ID, "k".repeat(22)).startsWith(`${USER_ID}/`)).toBe(true);
  });
});

describe("setAvatar", () => {
  function admin() {
    const patch = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    });
    return {
      calls: patch,
      client: { from: () => ({ update: patch }) } as never,
    };
  }

  it("writes the key it was given rather than minting a second one", async () => {
    const { calls, client } = admin();
    const key = "suppliedKeyAAAAAAAAAA";
    await setAvatar(client, USER_ID, avatarObjectPath(USER_ID, key), key);
    expect(calls).toHaveBeenCalledWith(expect.objectContaining({ avatar_key: key }));
  });

  it("refuses a blank key, which would leave the row unreachable", async () => {
    const { client } = admin();
    const result = await setAvatar(client, USER_ID, `${USER_ID}/whatever`, "  ");
    expect(result.ok).toBe(false);
  });
});
