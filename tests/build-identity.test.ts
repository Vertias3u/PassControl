import { describe, expect, it } from "vitest";
import { parseMigrationManifest, releaseChannel, releaseCommit } from "@/lib/system-health/build-identity-values";

const digest = "a".repeat(64);

describe("build identity", () => {
  it("uses only full commit digests in documented precedence order", () => {
    expect(releaseCommit({
      PASSCONTROL_BUILD_SHA: "short",
      VERCEL_GIT_COMMIT_SHA: "B".repeat(40),
      CF_PAGES_COMMIT_SHA: "c".repeat(64),
    })).toBe("b".repeat(40));
    expect(releaseCommit({ PASSCONTROL_BUILD_SHA: "a".repeat(64) })).toBe("a".repeat(64));
    expect(releaseCommit({ PASSCONTROL_BUILD_SHA: "abc" })).toBeNull();
  });

  it("makes production channel uncertainty explicit", () => {
    expect(releaseChannel({ NODE_ENV: "production" })).toBe("unknown");
    expect(releaseChannel({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe("development");
    expect(releaseChannel({ NODE_ENV: "production", PASSCONTROL_RELEASE_CHANNEL: "beta" })).toBe("beta");
    expect(releaseChannel({ NODE_ENV: "production", PASSCONTROL_RELEASE_CHANNEL: "canary" })).toBe("unknown");
    expect(releaseChannel({ NODE_ENV: "production", CF_PAGES_BRANCH: "main" })).toBe("unknown");
  });

  it("accepts only an ordered exact-byte migration manifest", () => {
    const entries = [{ version: "0001_init.sql", checksum: digest }];
    const manifest = { entries, head: "0001_init.sql", fingerprint: digest };
    expect(parseMigrationManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(parseMigrationManifest(JSON.stringify({ ...manifest, entries: [...entries, { version: "0001_init.sql", checksum: digest }] })).entries).toEqual([]);
    expect(parseMigrationManifest(JSON.stringify({ ...manifest, head: "0002_other.sql" })).entries).toEqual([]);
    expect(parseMigrationManifest("not json").entries).toEqual([]);
  });
});
