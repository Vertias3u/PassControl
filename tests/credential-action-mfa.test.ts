// Every dashboard Server Action that MINTS or STORES a credential must clear the
// strict MFA gate.
//
// Why this is a source-shape test rather than a behavioural one: a Server Action is
// addressable over HTTP by its id, so the action IS the authorization decision —
// there is no later re-check to catch a missing gate. The failure mode is therefore
// "someone adds a credential action and forgets", which is a property of the file,
// not of any one call. `lib/mfa.ts` explains at length why only the strict helper
// may authorize a write; this pins that every credential path actually uses it.
//
// The gate lives on the shared internal helpers (`createAgentForUser`,
// `addProviderKeyForUser`) rather than on each exported wrapper, so a future caller
// that reuses a helper inherits the check instead of re-introducing the gap.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "app/dashboard/actions.ts"), "utf8");

/** Slice one function body out of the actions module, exported or not. */
function functionBody(name: string): string {
  const start = source.search(new RegExp(`^(?:export )?async function ${name}\\b`, "m"));
  expect(start, `${name} not found in app/dashboard/actions.ts`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?async function \w/m);
  return rest.slice(0, next === -1 ? undefined : next);
}

// Minting a credential and replacing the secret behind an existing one are the same
// risk: both hand a usable key to whoever is driving the session.
const MUST_GATE = [
  // Passport registration — a public key the gateway will mint visas for.
  "createAgentForUser",
  // Provider secret into Vault, and the secret behind an existing credential row.
  "addProviderKeyForUser",
  "rotateProviderKey",
  // Direct Agent Keys — bearer credentials on the data plane.
  "issueDirectAgent",
  "issueDirectAgentKey",
  "attachAgentPassport",
  // A `pc_` developer key is control-plane authority: fleet reads, budget writes,
  // the kill switch. It is the most consequential credential in the file.
  "createApiKey",
  // Revoking a Direct Agent Key is a write against a credential row.
  "revokeDirectAgentKey",
];

describe("credential-minting Server Actions clear the strict MFA gate", () => {
  it.each(MUST_GATE)("%s calls requireCredentialMfa", (name) => {
    expect(functionBody(name)).toMatch(/requireCredentialMfa\(/);
  });

  it("routes every gate through the strict helper, never the lenient one", () => {
    // needsMfaStepUp reads an AAL hint derived from unsigned cookie state and fails
    // open. It may redirect a page; it must never authorize an action.
    expect(source).not.toMatch(/needsMfaStepUp/);
    expect(functionBody("requireCredentialMfa")).toMatch(/mfaAuthorizedUser\(/);
  });

  it("keeps revocation and the kill switch reachable without a step-up", () => {
    // Deliberate asymmetry: making it HARDER to stop a leaking credential than to
    // create one would be the wrong trade. These stay on requireUser().
    //
    // Read this together with the two tests below, not on its own: taken literally
    // it would also forbid the gate on revokeDirectAgentKey, which IS in MUST_GATE.
    // The rule that reconciles them — every credential keeps at least one stop
    // reachable without a step-up — and the evidence for it are directly below.
    expect(functionBody("setMasterKill")).not.toMatch(/requireCredentialMfa\(/);
    expect(functionBody("setAgentSuspended")).not.toMatch(/requireCredentialMfa\(/);
    expect(functionBody("revokeApiKey")).not.toMatch(/requireCredentialMfa\(/);
  });

  // ── Why ONE revocation is gated and the others are not ────────────────────
  //
  // revokeDirectAgentKey is in MUST_GATE above, which on its own looks like it
  // contradicts the test right above this one. It does not, and the rule that
  // reconciles them is: every credential keeps at least one stop reachable
  // WITHOUT a step-up. What differs is where that stop lives.
  //
  // The two assertions below are the load-bearing evidence, not decoration. If
  // the control plane ever starts reading kill state, or the gateway stops, the
  // rationale in app/dashboard/actions.ts must be re-derived rather than assumed.
  it("gates a direct-key revocation only because suspend and kill already stop it", () => {
    // The gateway consults tenant kill + per-agent suspend on every call, so an
    // ungated Suspend/kill switch stops a leaking Direct Agent Key immediately.
    const gateway = readFileSync(join(process.cwd(), "app/api/v1/[provider]/[...path]/route.ts"), "utf8");
    expect(gateway).toMatch(/readKillState\(userId\)/);
    expect(gateway).toMatch(/isSuspended\(agentId\)/);
    // Both of those stops are ungated Server Actions (asserted above), and they
    // reach the key because a Direct Agent Key is bound to exactly one agent row —
    // suspending that agent suspends every key issued against it.
    const expand = readFileSync(join(process.cwd(), "db/migrations/0023_direct_agent_keys_expand.sql"), "utf8");
    const keys = expand.slice(expand.indexOf("create table if not exists public.agent_access_keys"));
    expect(keys).toMatch(/agent_id\s+uuid references public\.agents\(id\)/);
  });

  it("leaves the control-plane key ungated because revocation is its ONLY stop", () => {
    // No kill switch, no suspend: lib/control only refuses on api_keys.revoked_at.
    const handler = readFileSync(join(process.cwd(), "lib/control/handler.ts"), "utf8");
    const controlAuth = readFileSync(join(process.cwd(), "lib/control/auth.ts"), "utf8");
    for (const source of [handler, controlAuth]) {
      expect(source).not.toMatch(/readKillState|isBlocked|isSuspended/);
    }
    expect(controlAuth).toMatch(/revoked_at/);
    // Which is exactly why revokeApiKey may not grow a step-up gate.
    expect(functionBody("revokeApiKey")).not.toMatch(/requireCredentialMfa\(/);
  });

  // The gate guards revocation as well as minting, so its refusal text may not
  // name one verb — an operator who pressed Revoke and is told to verify "before
  // creating credentials" reasonably concludes they hit the wrong control.
  it("refuses in words that fit every action it guards", () => {
    const body = functionBody("requireCredentialMfa");
    expect(body).toMatch(/Complete two-factor verification before changing credentials\./);
    expect(body).not.toMatch(/before creating credentials/);
  });

  // What the gate actually enforces. `mfaAuthorizedUser` returns ok for an account
  // with ZERO verified factors, because there is no step-up to demand — so this is
  // "enforced wherever a second factor exists", never "universally enforced".
  // Any doc or report that says otherwise is describing a product we did not build.
  it("is honest that a factorless account passes, and says so where it is decided", () => {
    const mfa = readFileSync(join(process.cwd(), "lib/mfa.ts"), "utf8");
    const gate = mfa.slice(mfa.indexOf("export async function mfaAuthorizedUser"));
    expect(gate).toMatch(/verified\.length === 0\) return \{ ok: true, user \}/);
    expect(gate).toMatch(/No verified factor means no step-up is possible/);
    // …and the factor list is the server's, so a forged cookie cannot deny service
    // by inventing a factor either.
    expect(gate).toMatch(/supabase\.auth\.getUser\(\)/);
    // …and the module says so at the gate, so the next reader does not have to
    // rediscover it from lib/mfa.ts.
    expect(source).toMatch(/second factor enforced wherever a second factor exists/);
  });

  it("gates the key-import on-ramp through the shared helpers it delegates to", () => {
    // completeKeyImport stores a provider secret AND registers a passport. It holds
    // no gate of its own; both helpers it calls carry one, which is what keeps a
    // future third caller safe by default.
    const body = functionBody("completeKeyImport");
    expect(body).toMatch(/addProviderKeyForUser\(/);
    expect(body).toMatch(/createAgentForUser\(/);
  });
});
