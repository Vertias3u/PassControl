// The dashboard write path for passport expiry and rotation.
//
// The gates themselves live in lib/auth/passport.ts (enforcement) and
// lib/fleet.ts (what a rotation is allowed to do), both covered elsewhere. What
// is left here is the part only this surface can get wrong:
//
//  1. A PRIVATE KEY REACHING THE SERVER. The gateway has never held a passport
//     private key. That is the product, not an implementation detail, and the
//     convenience of generating one server-side is exactly how it would stop
//     being true.
//  2. A GRACE WINDOW THE UI DOES NOT MENTION. During it, two keys open the door.
//     An operator who does not know that cannot reason about their own fleet.
//  3. A CLOSED WINDOW SHOWN AS OPEN. The sweep clears the columns after the
//     deadline, so between the deadline and the next cron run the row still
//     holds a retired key that no longer works.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MAX_ROTATION_GRACE_S } from "@/lib/passport-limits";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const actions = read("app/dashboard/agents/[id]/passport-actions.ts");
const ui = read("components/PassportLifecycle.tsx");

const fn = (name: string) => {
  const at = actions.indexOf(`export async function ${name}`);
  expect(at, `${name} is missing`).toBeGreaterThan(-1);
  const rest = actions.slice(at);
  const next = rest.indexOf("\nexport async function ", 1);
  return next === -1 ? rest : rest.slice(0, next);
};

const NAMES = ["rotateAgentPassport", "setAgentPassportExpiry"];

describe("the server actions", () => {
  it("runs on the server", () => {
    expect(actions.startsWith('"use server"')).toBe(true);
  });

  it.each(NAMES)("derives the acting user from the session, never from an argument", (name) => {
    const body = fn(name);
    expect(body.slice(0, body.indexOf(")"))).not.toMatch(/userId/);
    expect(body).toMatch(/await actingUser\(\)/);
    expect(body).toMatch(/"error" in acting/);
  });

  /**
   * A server action is addressable over HTTP by its id, so the redirect on the
   * page protects the page and not these. Rotation decides which key can speak
   * for an agent — the most consequential control on the screen.
   */
  it("gates the shared session helper on MFA step-up", () => {
    const helper = actions.slice(actions.indexOf("async function actingUser"));
    const body = helper.slice(0, helper.indexOf("\n}\n"));
    expect(body).toMatch(/mfaAuthorizedUser/);
    expect(body).not.toMatch(/needsMfaStepUp/);
  });

  it.each(NAMES)("%s goes through lib/fleet rather than writing the row itself", (name) => {
    const body = fn(name);
    expect(body).toMatch(/rotatePassport|setPassportExpiry/);
    // fleet owns the refusals — same key, open window, past expiry, grace
    // bounds. A direct write here would be a second, weaker implementation.
    expect(body).not.toMatch(/\.from\("agents"\)/);
  });

  // ── 1. The private key ────────────────────────────────────────────────────

  /**
   * There must be no code path in this file capable of producing a private key.
   * The browser generates the pair and sends only the public half.
   */
  it("cannot generate or receive a private key", () => {
    expect(actions).not.toMatch(/randomPrivateKey/);
    expect(actions).not.toMatch(/@noble\/curves/);
    expect(actions).not.toMatch(/passportSecret|privateKey|PASSPORT_SECRET/);
  });

  it("takes a public key as its argument", () => {
    expect(fn("rotateAgentPassport")).toMatch(/newPassportPubkey/);
  });

  it("does not revalidate while the browser holds the reveal-once replacement key", () => {
    expect(fn("rotateAgentPassport")).not.toMatch(/revalidatePath/);
  });

  it("generates the keypair in the browser, as issuance already does", () => {
    expect(ui).toMatch(/randomPrivateKey/);
    expect(ui).toMatch(/getPublicKey/);
    // Only the public half crosses the boundary.
    expect(ui).toMatch(/rotateAgentPassport\(agentId, pub, grace\)/);
  });

  // ── Audit and alerting ────────────────────────────────────────────────────

  /**
   * A rotation the owner did not perform hands the agent to someone else and
   * locks the owner out when the window closes. Same class of event
   * killswitch.master already pages on.
   */
  it("raises a security alert on rotation", () => {
    const body = fn("rotateAgentPassport");
    expect(body).toMatch(/dispatchSecurityAlert/);
    expect(body).toMatch(/agent\.passport_rotate/);
  });

  it.each(NAMES)("%s records an audit row", (name) => {
    const body = fn(name);
    expect(body).toMatch(/recordAdminAction/);
    expect(body).toMatch(/via: "dashboard"/);
  });

  /**
   * The row must name the key that was STORED, not the one that was submitted.
   * `rotatePassport` normalises before writing, so auditing the request value
   * records a key that cannot authenticate and is not in the row — the same
   * defect the control API had. Asserting the stored value is the whole point;
   * a bare `to:` match would pass on either.
   *
   * `newPassportPubkey` is not banned outright: it is still legitimately the
   * argument passed INTO `rotatePassport`. What is banned is reporting it.
   */
  it("records the key that was stored, not the one that was submitted", () => {
    const body = fn("rotateAgentPassport");
    expect(body).toMatch(/to: result\.value\.passportPubkey/);
    expect(body).not.toMatch(/to: newPassportPubkey/);
  });
});

describe("the panel", () => {
  it("is rendered on the agent page", () => {
    expect(read("app/dashboard/agents/[id]/page.tsx")).toMatch(/<PassportLifecycle/);
  });

  it("refreshes the passport only after the replacement key is acknowledged", () => {
    expect(ui).toMatch(/useRouter/);
    expect(ui).toMatch(/const acknowledgeSecret = \(\) => \{[\s\S]*if \(!secretAck\) return;[\s\S]*router\.refresh\(\);/);
    expect(ui).toMatch(/if \(!open && secretAck\) \{[\s\S]*acknowledgeSecret\(\);/);
    expect(ui).toMatch(/disabled=\{!secretAck\} onClick=\{acknowledgeSecret\}/);
  });

  // ── 2. The window is stated ───────────────────────────────────────────────

  it("says that both keys work during the grace window", () => {
    expect(ui).toMatch(/data-state="grace-open"/);
    expect(ui).toMatch(/Two keys can authenticate as this agent right now/);
    expect(ui).toMatch(/Both keys authenticate until the window closes/);
  });

  it("shows the deadline, not just that a window exists", () => {
    expect(ui).toMatch(/<Countdown until=/);
    expect(ui).toMatch(/when\(previousValidUntil\)/);
  });

  /**
   * Rotating because a key leaked is the case where a window is a liability
   * rather than a convenience, and the operator should be told which option
   * that calls for rather than left to work it out.
   */
  it("tells an operator rotating a leaked key to choose no window", () => {
    expect(ui).toMatch(/leaked/i);
    expect(ui).toMatch(/Immediately/);
  });

  // ── 3. A closed window is not shown as open ───────────────────────────────

  /**
   * The sweep clears the columns after the deadline, so a row can legitimately
   * hold a retired key whose window has already closed. Deciding `windowOpen`
   * from the presence of the column alone would advertise a key that no longer
   * works.
   */
  it("decides an open window from the deadline, not from the column", () => {
    expect(ui).toMatch(/Date\.parse\(previousValidUntil \?\? ""\) > Date\.now\(\)/);
  });

  it("distinguishes never-expires from lapsed", () => {
    // Three distinct states off one ternary, so they are asserted as the
    // branches they are rather than as three separate literal attributes.
    expect(ui).toMatch(/expired \? "lapsed" : expiresAt \? "dated" : "never"/);
    expect(ui).toMatch(/works until it is revoked/);
    expect(ui).toMatch(/can no longer mint a visa/);
  });

  /**
   * Expiry is checked when a visa is minted, not per call — so a passport that
   * lapses mid-visa keeps working until that visa runs out. Engineering the
   * tail away would put a database read on the credential path for a check the
   * mint already made, so it is stated instead.
   */
  it("states the mid-visa tail rather than implying expiry is instant", () => {
    expect(ui).toMatch(/not on every call/);
    expect(ui).toMatch(/visaTtlSeconds/);
    expect(ui).toMatch(/suspend it/i);
  });

  it("says the secret is shown once and never sent", () => {
    expect(ui).toMatch(/data-state="new-secret"/);
    expect(ui).toMatch(/shown once/i);
    expect(ui).toMatch(/never sent to the gateway/i);
  });

  it("distinguishes rotation from revocation, which is the thing it replaces", () => {
    expect(ui).toMatch(/same id, same budgets/);
    expect(ui).toMatch(/permanent/i);
  });

  // Same rule validateFallbacks documents: a form offering a choice the server
  // refuses is a failure the operator discovers at the moment they use it.
  it("offers no grace window longer than the server accepts", () => {
    const choices = ui.slice(ui.indexOf("GRACE_CHOICES"), ui.indexOf("] as const"));
    expect(choices).toMatch(/MAX_ROTATION_GRACE_S/);
    const literals = [...choices.matchAll(/seconds: ([\d_]+)/g)].map((m) =>
      Number((m[1] ?? "").replace(/_/g, ""))
    );
    expect(literals.length).toBeGreaterThan(0);
    for (const seconds of literals) {
      expect(seconds).toBeLessThanOrEqual(MAX_ROTATION_GRACE_S);
    }
  });

  /**
   * The constant is imported from a leaf module, not from lib/fleet. Importing
   * it from fleet would drag @upstash/redis and the Supabase service client
   * into the browser bundle to read one integer.
   */
  it("reads the bound without pulling server-only code into the browser", () => {
    expect(ui).toMatch(/from "@\/lib\/passport-limits"/);
    expect(ui).not.toMatch(/from "@\/lib\/fleet"/);
    expect(read("lib/passport-limits.ts")).not.toMatch(/^import /m);
  });

  it("does not offer to rotate a passport that is not active", () => {
    expect(ui).toMatch(/const active = status === "active"/);
    expect(ui).toMatch(/Only an active passport can be rotated/);
  });

  // fleet refuses this too; the UI declining to offer it means the operator
  // meets the rule as an explanation rather than as an error.
  it("does not offer to rotate again while a window is open", () => {
    expect(ui).toMatch(/disabled=\{pending \|\| windowOpen\}/);
    expect(ui).toMatch(/cut the first window short/);
  });
});

describe("new passport issuance reveal-once handoff", () => {
  it("does not refresh until the newly issued private key is acknowledged", () => {
    const issuance = read("components/PassportIssuanceModal.tsx");
    const store = read("components/PassportStoreAndConnect.tsx");
    const dashboardActions = read("app/dashboard/actions.ts");
    const helperStart = dashboardActions.indexOf("async function createAgentForUser");
    const helperEnd = dashboardActions.indexOf("\n/** Register a new agent passport", helperStart);
    const helper = dashboardActions.slice(helperStart, helperEnd);
    expect(helper).not.toMatch(/revalidatePath/);
    expect(issuance).toMatch(/useRouter/);
    expect(issuance).toMatch(/const acknowledgeStored = \(\) =>/);
    expect(issuance).toMatch(/onFinish=\{acknowledgeStored\}/);
    expect(store).toMatch(/disabled=\{!stored\} onClick=\{onFinish\}/);
    expect(store).toContain("beforeunload");
    expect(store).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  // A stored call older than the credential proves the PREVIOUS key, not this one.
  // Harmless while both call sites pass a just-created agent, and false the day
  // rotation or attachAgentPassport reuses this component — so the floor is a
  // required prop rather than something a future caller has to remember.
  it("proves the issued passport only from calls stored after it existed", () => {
    const store = read("components/PassportStoreAndConnect.tsx");
    expect(store).toMatch(/issuedAt: string/);
    // Historical read and live insert must apply the same floor.
    expect(store).toMatch(/\.gt\("created_at", issuedAt\)/);
    expect(store).toMatch(/next\.created_at\s*>\s*issuedAt/);
  });

  it("takes the floor from the server row, not the browser clock", () => {
    // agent_logs.created_at and agents.created_at are stamped by the same database
    // clock. A Date.now() taken in the browser is a different clock, and skew either
    // hides a real first call or admits a stale one.
    const store = read("components/PassportStoreAndConnect.tsx");
    expect(store).not.toMatch(/issuedAt\s*=\s*new Date\(\)/);
    expect(read("lib/fleet.ts")).toMatch(/select\("id, created_at"\)/);
    for (const caller of ["components/PassportIssuanceModal.tsx", "components/KeyImportOnramp.tsx"]) {
      expect(read(caller), caller).toMatch(/issuedAt=\{/);
    }
  });
});
