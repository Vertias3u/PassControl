// The dashboard write path for owner binding.
//
// Owner binding is the one feature whose entire purpose is public
// accountability: `published` puts a name on the public /verify page AND into
// the `own` claim of every signed receipt handed to a third party. Until now it
// was reachable only with an API key, which is the wrong audience for it.
//
// What these tests exist to catch, in order of how much they would cost:
//
//  1. A tier the operator set themselves. Migration 0017 grants the client
//     SELECT and nothing else precisely so the verification ladder cannot be
//     skipped; a server action that wrote `tier` directly would make the tier —
//     the whole point of the feature — meaningless.
//  2. The verification token in an audit row. It is the secret that proves
//     domain control; admin_audit is readable by the tenant and dumped by the
//     control API.
//  3. Copy that lets a self-attested claim look checked. The public page
//     resolves an unknown tier downward on purpose; the operator's own screen
//     must not be more generous than the page a stranger reads.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AUDIT_ACTIONS, buildAuditRecord } from "@/lib/audit";
import { OWNER_WELL_KNOWN_PATH } from "@/lib/owner/domain";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("the audit actions this feature needs already exist", () => {
  it.each(["owner.set", "owner.publish", "owner.verify"])("allowlists %s", (action) => {
    expect(AUDIT_ACTIONS).toContain(action);
    expect(() => buildAuditRecord({ userId: "u1", action: action as never })).not.toThrow();
  });
});

describe("the server actions", () => {
  const actions = read("app/dashboard/owner-actions.ts");
  const fn = (name: string) => {
    const at = actions.indexOf(`export async function ${name}`);
    expect(at, `${name} is missing`).toBeGreaterThan(-1);
    const rest = actions.slice(at);
    const next = rest.indexOf("\nexport async function ", 1);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it("runs on the server", () => {
    expect(actions.startsWith('"use server"')).toBe(true);
  });

  it.each(["declareOwner", "publishOwner", "checkOwnerDomain"])("exports %s", (name) => {
    expect(actions).toMatch(new RegExp(`export async function ${name}`));
  });

  // The tenant boundary. An action taking a userId would let the caller choose
  // whose owner record to rewrite — and this record is what gets published.
  //
  // The session read and the MFA gate are factored into one actingUser() helper,
  // so these assert the factoring rather than forbidding it: every action must
  // go through the helper, and the helper must do both checks. Grepping each
  // body for `auth.getUser()` would fail on correct code and pass on a copy of
  // the check that had quietly dropped the step-up half.
  it.each(["declareOwner", "publishOwner", "checkOwnerDomain"])(
    "%s derives the acting user from the session, never from an argument",
    (name) => {
      const body = fn(name);
      const signature = body.slice(0, body.indexOf(")"));
      expect(signature).not.toMatch(/userId/);
      expect(body).toMatch(/await actingUser\(\)/);
      // A helper that resolved to an error must stop the action, not fall
      // through to the write with an undefined tenant.
      expect(body).toMatch(/"error" in acting/);
    }
  );

  // Same gate the settings page itself applies. Naming the party a passport
  // belongs to is at least as consequential as reading a provider key's label.
  it("gates the shared session helper on MFA step-up", () => {
    const helper = actions.slice(actions.indexOf("async function actingUser"));
    const body = helper.slice(0, helper.indexOf("\n}\n"));
    expect(body).toMatch(/mfaAuthorizedUser/);
    expect(body).not.toMatch(/needsMfaStepUp/);
  });

  // checkOwnerDomain makes an outbound HTTPS request to a hostname the caller
  // chose. Unthrottled, that is a request amplifier pointed at anything the
  // gateway can reach.
  it("rate-limits the outbound domain check", () => {
    expect(fn("checkOwnerDomain")).toMatch(/rateLimit\(/);
  });

  // The rule that makes the tier worth anything, restated at the new surface.
  // lib/owner/manage.ts decides tier and verified_at from evidence it gathered;
  // an action that passed either through would hand the caller the label.
  it("never writes tier or verified_at itself", () => {
    for (const name of ["declareOwner", "publishOwner", "checkOwnerDomain"]) {
      const body = fn(name);
      expect(body, name).not.toMatch(/tier\s*[:=]/);
      expect(body, name).not.toMatch(/verified_at/);
    }
  });

  it("goes through lib/owner/manage.ts rather than touching the table", () => {
    expect(actions).toMatch(/from "@\/lib\/owner\/manage"/);
    // agent_owners has no client insert/update policy at all (0017), so a
    // direct write here would not merely bypass the ladder — it would fail.
    expect(actions).not.toMatch(/from\("agent_owners"\)/);
  });

  it("records an audit row for each mutation", () => {
    expect(fn("declareOwner")).toMatch(/owner\.set/);
    expect(fn("publishOwner")).toMatch(/owner\.publish/);
    expect(fn("checkOwnerDomain")).toMatch(/owner\.verify/);
  });

  // The token is the secret that proves domain control. admin_audit is readable
  // by the tenant and served by GET /api/control/v1/audit.
  //
  // Asserted against the metadata objects specifically, not the whole file: the
  // string `no_verification_token` is a legitimate error code from manage.ts,
  // and a file-wide ban would fail on correct code — the kind of test that gets
  // deleted rather than fixed.
  it("never puts the verification token in an audit row", () => {
    const metadata = [...actions.matchAll(/metadata:\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(metadata.length).toBe(3);
    for (const block of metadata) {
      expect(block).not.toMatch(/token/i);
      expect(block).not.toMatch(/subject/);
    }
  });

  it("revalidates the page the operator is looking at", () => {
    for (const name of ["declareOwner", "publishOwner", "checkOwnerDomain"]) {
      expect(fn(name), name).toMatch(/revalidatePath\("\/dashboard\/settings"\)/);
    }
  });
});

describe("the editor UI", () => {
  const ui = read("components/OwnerBinding.tsx");

  it("is on the settings page", () => {
    expect(read("app/dashboard/settings/page.tsx")).toMatch(/<OwnerBinding/);
  });

  // Never derive a verified label from `kind` — kind records the method
  // attempted, tier records what was actually proven. Same rule describeOwner
  // and the passport page follow.
  it("keys its wording off tier, not kind", () => {
    expect(ui).toMatch(/tier/);
    expect(ui).toMatch(/data-state="unverified"/);
    expect(ui).toMatch(/data-state="verified"/);
  });

  it("tells an operator their self-attested claim proves nothing", () => {
    expect(ui).toMatch(/proves nothing|not verified|self-attested/i);
  });

  it("shows the exact place to publish the token, derived and never typed", () => {
    expect(ui).toMatch(/OWNER_WELL_KNOWN_PATH/);
    // Typing the path here would let it drift from the one verifyDomainControl
    // actually fetches, and the operator would follow instructions to a URL we
    // never look at.
    expect(ui).not.toContain(OWNER_WELL_KNOWN_PATH);
  });

  // `published` is ONE switch with TWO effects, and the second is the one an
  // operator will not guess: every receipt handed to a third party starts
  // carrying the name.
  it("says publishing affects receipts, not only the public page", () => {
    expect(ui).toMatch(/receipt/i);
    expect(ui).toMatch(/\/verify|public page/i);
  });

  // verified_at is deliberately NOT cleared on demotion, so the page can say
  // when the binding was last genuinely confirmed. That is more useful than
  // silence, and only if the UI actually renders it.
  it("distinguishes a demoted binding from one that was never verified", () => {
    expect(ui).toMatch(/data-state="demoted"/);
    expect(ui).toMatch(/OWNER_FAILURE_LIMIT|failure_count|failureCount/);
  });
});
