import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

// The marker tokens are assembled from fragments, never written whole. This test
// ships, and scripts/curate-public.sh finds its markers by grepping the tree for
// exactly these strings — so spelling them out here made the script strip this
// file's own transform on the way out and publish a syntax error. The mirror's
// suite was red at collection while the private one stayed green; found by
// running the curated suite by hand on 2026-08-30, and now guarded by
// scripts/__tests__/curate-markers-are-comments.test.mjs.
const MARK = "curate:";
const PRIVATE_START = `${MARK}private-start`;
const PRIVATE_END = `${MARK}private-end`;
const PUBLIC_ONLY_START = `${MARK}public-only-start`;
const PUBLIC_ONLY_END = `${MARK}public-only-end`;

function curateMarkedSource(input: string): string {
  const withoutPrivate = input.replace(
    new RegExp(`^[^\\n]*${PRIVATE_START}.*?${PRIVATE_END}[^\\n]*\\n`, "gms"),
    ""
  );
  const output: string[] = [];
  let insidePublicOnly = false;
  for (const line of withoutPrivate.split("\n")) {
    if (line.includes(PUBLIC_ONLY_START)) {
      insidePublicOnly = true;
      continue;
    }
    if (line.includes(PUBLIC_ONLY_END)) {
      insidePublicOnly = false;
      continue;
    }
    output.push(insidePublicOnly ? line.replace(/^(\s*)\/\/ ?/u, "$1") : line);
  }
  return output.join("\n");
}

describe("Core signup curation boundary", () => {
  it("keeps generic signup policy and removes the hosted database invitation operation", () => {
    const auth = curateMarkedSource(source("app/actions/auth.ts"));

    expect(auth).toContain("validateSignupAccess(mode, inviteCode, process.env.INVITE_CODE ?? \"\")");
    expect(auth).toContain("supabase.auth.signUp({");
    expect(auth).toContain("rateLimit(`signup:ip:${ip}`");
    expect(auth).toContain("validatePassword(password)");
    expect(auth).not.toMatch(
      /claim_beta_invite|redeem_beta_invite|hashBetaInviteToken|claimedInviteId|inviteToken/
    );
    expect(auth).not.toContain("serviceClient()");
  });

  it("keeps the shared invite-code form and removes personal invitation fields and copy", () => {
    const form = curateMarkedSource(source("components/auth/SignupForm.tsx"));

    expect(form).toContain('name="invite_code"');
    expect(form).toContain('mode === "invite" && inviteSource === "shared"');
    expect(form).toContain("<SubmitButton />");
    expect(form).not.toMatch(/invite_token|inviteToken|Personal invitation|invitation email/);
  });

  it("forces the self-host signup page onto the shared-code source", () => {
    const page = curateMarkedSource(source("app/signup/page.tsx"));

    expect(page).toContain('const source = "shared" as const');
    expect(page).not.toContain("inviteSource()");
  });
});
