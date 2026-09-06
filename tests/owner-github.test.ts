import { describe, it, expect, vi } from "vitest";

import {
  GITHUB_OWNER_FILE,
  GITHUB_OWNER_REPO,
  githubProofUrl,
  isVerifiableGithubLogin,
  verifyGithubControl,
} from "@/lib/owner/github";

const TOKEN = "passcontrol-verify-abcdef0123456789";

function res(body: string, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: new Headers(),
  } as unknown as Response;
}

describe("which GitHub logins may be attempted", () => {
  it("accepts the shapes GitHub actually issues", () => {
    expect(isVerifiableGithubLogin("octocat")).toBe(true);
    expect(isVerifiableGithubLogin("Vertias3u")).toBe(true);
    expect(isVerifiableGithubLogin("a-b-c")).toBe(true);
    expect(isVerifiableGithubLogin("a")).toBe(true);
    expect(isVerifiableGithubLogin("a".repeat(39))).toBe(true);
  });

  // Same reasoning as the domain module: this string is interpolated into a URL
  // we then fetch, so the input shape is the control. A login is a single path
  // segment and nothing else — anything that could add a segment, escape the
  // host, or carry a query is refused before a request is made.
  it.each([
    ["a path separator", "octocat/passcontrol-owner"],
    ["a parent segment", ".."],
    ["a scheme", "https://octocat"],
    ["a query", "octocat?x=1"],
    ["a fragment", "octocat#x"],
    ["an at sign", "@octocat"],
    ["a dot", "octo.cat"],
    ["an underscore", "octo_cat"],
    ["a leading hyphen", "-octocat"],
    ["a trailing hyphen", "octocat-"],
    ["a double hyphen", "octo--cat"],
    ["whitespace", "octo cat"],
    ["an encoded separator", "octocat%2F.."],
    ["over 39 characters", "a".repeat(40)],
    ["empty", ""],
  ])("refuses %s", (_label, value) => {
    expect(isVerifiableGithubLogin(value)).toBe(false);
  });

  it("refuses anything that is not a string", () => {
    expect(isVerifiableGithubLogin(undefined)).toBe(false);
    expect(isVerifiableGithubLogin(null)).toBe(false);
    expect(isVerifiableGithubLogin(12345)).toBe(false);
  });
});

describe("where the proof is expected", () => {
  // The URL is derived from the login alone, exactly like the domain module
  // derives its well-known URL from the hostname. No gist id, no second input,
  // and therefore no way for a caller to point the fetch somewhere of its own
  // choosing.
  it("derives one URL from the login and nothing else", () => {
    expect(githubProofUrl("octocat")).toBe(
      `https://raw.githubusercontent.com/octocat/${GITHUB_OWNER_REPO}/HEAD/${GITHUB_OWNER_FILE}`
    );
  });

  it("normalises the login to lower case", () => {
    expect(githubProofUrl("OctoCat")).toBe(githubProofUrl("octocat"));
  });
});

describe("verifying control of a GitHub account", () => {
  it("accepts a token published on its own line", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(`# proof\n${TOKEN}\n`));
    await expect(verifyGithubControl("octocat", TOKEN, { fetch: fetchImpl })).resolves.toEqual({
      ok: true,
    });
  });

  it("fetches the repo path under the claimed login, and only that", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(TOKEN));
    await verifyGithubControl("OctoCat", TOKEN, { fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(githubProofUrl("octocat"));
    // A rename or a deleted repo answers with a redirect on some GitHub hosts.
    // Following one would let the response come from a path that is no longer
    // bound to the claimed login, which is the entire proof.
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a substring match", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(`not-really-${TOKEN}-nope`));
    await expect(verifyGithubControl("octocat", TOKEN, { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "token_mismatch",
    });
  });

  // The whole binding: raw.githubusercontent.com serves this path only under the
  // account that owns the repository, and answers 404 under any other login.
  // Verified against the live host, not assumed.
  it("reports a 404 as not published", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res("404: Not Found", { status: 404 }));
    await expect(verifyGithubControl("octocat", TOKEN, { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "not_published",
    });
  });

  it("separates a host that would not answer from a proof that was not there", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network"));
    await expect(verifyGithubControl("octocat", TOKEN, { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("refuses an unverifiable login without making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      verifyGithubControl("octocat/../../etc", TOKEN, { fetch: fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "invalid_login" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an empty token without making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(verifyGithubControl("octocat", "", { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "token_mismatch",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // The second control the domain module documents: a failed verification must
  // never become a read primitive. Nothing derived from the body may appear in
  // the result, however the check went.
  it("never returns anything derived from the fetched document", async () => {
    const secret = "ghp_thisWouldBeACredential";
    const fetchImpl = vi.fn().mockResolvedValue(res(secret));
    const result = await verifyGithubControl("octocat", TOKEN, { fetch: fetchImpl });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not buffer an unbounded response", async () => {
    const huge = `${"x".repeat(64 * 1024)}\n${TOKEN}`;
    const fetchImpl = vi.fn().mockResolvedValue(res(huge));
    // The token is past the cap, so it is not found — which is the point. A
    // caller-controlled URL must not be able to make the gateway read forever.
    await expect(verifyGithubControl("octocat", TOKEN, { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "token_mismatch",
    });
  });
});
