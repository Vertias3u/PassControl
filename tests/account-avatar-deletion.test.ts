// Deleting an account must not orphan the avatar.
//
// The whole test is about ORDER, and the order is not obvious from reading the
// function. `delete_account_data` (0024) cascades foreign keys, and
// `public.users` is one of the rows it deletes — so the storage key lives in a
// row the RPC destroys. Read it afterwards and there is nothing to read: the
// image stays in the bucket with nothing anywhere naming it, no sweep to find
// it, and no way to attribute it to a person who has just asked to be erased.
//
// A source-text test rather than a behavioural one, because `deleteAccount` is
// a server action bound to cookies, MFA, Redis and Supabase Auth. What can be
// pinned cheaply and exactly is the thing that actually matters: which
// statement comes first in the file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(process.cwd(), "app/dashboard/settings/account-actions.ts"),
  "utf8"
);

/** Source with `//` comments removed, so prose about a rule cannot satisfy it. */
const CODE = SOURCE.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("avatar cleanup on account deletion", () => {
  it("reads avatar_path BEFORE the RPC that deletes the row holding it", () => {
    const read = CODE.indexOf('.select("avatar_path")');
    const rpc = CODE.indexOf('rpc("delete_account_data"');
    expect(read, "the deletion no longer reads avatar_path at all").toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(-1);
    expect(read).toBeLessThan(rpc);
  });

  it("removes the stored object, which the RPC cannot reach", () => {
    expect(CODE).toMatch(/storage\s*\.\s*from\(\s*["']avatars["']\s*\)\s*\.\s*remove\(/);
  });

  // The file already refuses to report plain success when a cleanup step fails,
  // and an image left behind after an erasure request belongs in that report.
  it("reports an orphaned avatar rather than swallowing it", () => {
    expect(CODE).toMatch(/avatarOrphaned/);
    expect(CODE).toMatch(/cleanupPending:\s*avatarOrphaned/);
  });
});

describe("the account export", () => {
  const LIFECYCLE = readFileSync(join(process.cwd(), "lib/account-lifecycle.ts"), "utf8");

  it("includes the profile the operator filled in", () => {
    for (const field of ["handle", "displayName", "bio", "websiteUrl", "company", "isPublic"]) {
      expect(LIFECYCLE).toContain(`${field}:`);
    }
  });

  // avatar_key addresses a live, unauthenticated URL. An export is a file people
  // email to themselves and attach to tickets, and a working capability token
  // inside one is a credential in a document nobody treats as one.
  it("never exports the avatar capability token", () => {
    const profileBlock = LIFECYCLE.slice(
      LIFECYCLE.indexOf("    profile: {"),
      LIFECYCLE.indexOf("    exclusions: [")
    );
    expect(profileBlock).not.toContain("avatar_key");
    expect(profileBlock).not.toContain("avatarKey");
    // The useful fact is whether one exists at all.
    expect(profileBlock).toMatch(/avatar:\s*profile\?\.avatar_path\s*\?/);
  });

  it("says so in the exclusions the export prints about itself", () => {
    expect(LIFECYCLE).toMatch(/Avatar image bytes and the avatar capability token/);
  });

  // A consumer that parsed the previous version has no idea `profile` exists.
  // The number is what lets it tell.
  it("bumped the schema version for the new section", () => {
    const version = LIFECYCLE.match(/ACCOUNT_EXPORT_SCHEMA_VERSION = (\d+)/)?.[1];
    expect(Number(version)).toBeGreaterThanOrEqual(3);
  });
});
