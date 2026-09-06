// What an operator EXPECTS of key custody across their workspace.
//
// ── This is a statement, not a control ──────────────────────────────────────
//
// research/passport-key-protection.md §5 is precise about what the settings tab
// is allowed to do, and precise about why. The dashboard runs on the server; the
// passport key lives on the agent's machine; the server has never seen it. So a
// toggle here cannot move a key, and "building something that looks like it can
// would be worse than not building it". What is left, and is still worth doing:
// the operator states an expectation, and every surface that shows a declared
// tier can say whether it was met.
//
// Nothing in the proxy, the visa, or a receipt reads this. It gates nothing,
// blocks nothing, and appears in no signed artifact. An agent below the stated
// expectation keeps working exactly as before — the operator is the enforcement
// mechanism, which is the honest shape when the claim itself cannot be checked.
//
// ── Two unverified things are being compared ────────────────────────────────
//
// The expectation is what somebody typed. The declaration is what an agent said
// about itself, and §4 settles that the gateway cannot verify it at any tier.
// A verdict here is therefore "this claim does not match this policy", never
// "this agent is non-compliant" — and the UI has to keep saying so.
//
// ── Why a column and not Redis ──────────────────────────────────────────────
//
// The exact opposite of the declaration next door. That is evidence with a
// shelf life, so it expires; this is durable operator intent, and a policy that
// silently disappeared after 45 days would be worse than one never stated. It
// costs a migration (0051), which the OWNER applies — so every reader here has
// to work on an instance that has this code and not yet the column.
// ── This module is imported by a CLIENT component ──────────────────────────
//
// components/AgentFleetTable.tsx is "use client" and calls expectationVerdict()
// at runtime, so everything here ends up in the browser bundle. It only
// `import type`s the Supabase client, which is erased — keep it that way. A
// server-only import added below (serviceClient, next/headers, node:*) would
// break the fleet table at build time, and the error would name this file
// rather than the component that pulled it in.
import type { SupabaseClient } from "@supabase/supabase-js";

import { storeTier, type DeclaredKeyStorageView } from "@/lib/passport-key-storage";

/** Named once. Referenced by the read, the write, and their tests. */
export const KEY_CUSTODY_EXPECTATION_COLUMN = "key_custody_expectation";

/**
 * What this build offers in the settings control.
 *
 * Only tier 1. An expectation of tier 0 is not a policy — it is the default
 * every agent already meets — and tiers 2 and 3 do not exist yet. The stored
 * value is a store token rather than an enum so that adding one later is a data
 * change here and a migration constraint change, not a new shape.
 */
export const OFFERED_EXPECTATIONS = ["os"] as const;

// Same bound as the agent's own declaration. A settings field is no less
// client-controlled than a signed payload, and this string reaches a dashboard.
const STORE_TOKEN = /^[a-z][a-z0-9_]{0,31}$/;

/** PostgREST when the column is not there: the schema cache, then Postgres. */
const UNMIGRATED_CODES = new Set(["PGRST204", "42703"]);

export type ExpectationVerdict = "not_stated" | "meets" | "short" | "unknown";

export interface KeyCustodyExpectationState {
  /**
   * `unmigrated` is its own answer on purpose. Rendering it as "you have stated
   * no expectation" would invite the operator to state one into a control whose
   * write is guaranteed to fail.
   */
  state: "ready" | "unmigrated" | "unavailable";
  expectation: string | null;
}

/**
 * Read an expectation out of untrusted input. Every way of saying nothing —
 * absent, empty, the literal "none" a `<select>` sends — becomes null, so the
 * "no expectation" state has exactly one representation at rest.
 */
export function parseKeyCustodyExpectation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") return null;
  return STORE_TOKEN.test(trimmed) ? trimmed : null;
}

/**
 * Does this agent's declared custody meet the workspace expectation?
 *
 * ORDINAL, not string equality, and that is the load-bearing decision. An agent
 * declaring a store that shipped after this build is not BELOW an expectation of
 * tier 1 — `declared === expected` would say it is, which is the same forward-
 * compatibility lie the panel's `unrecognised` state exists to prevent. When
 * either side cannot be given a tier, the answer is `unknown`.
 *
 * `unknown` also covers an agent that has declared nothing, and it must. Silence
 * means the agent has not minted since this shipped, or uses the SDK or an older
 * CLI, or the record expired — so counting it as a shortfall is the tier-0-by-
 * default lie in a new costume, and counting it as compliance is worse.
 */
export function expectationVerdict(
  view: DeclaredKeyStorageView,
  expectation: string | null
): ExpectationVerdict {
  if (!expectation) return "not_stated";
  const expected = storeTier(expectation);
  if (expected === undefined) return "unknown";
  if (view.state !== "declared" || view.tier === undefined) return "unknown";
  return view.tier >= expected ? "meets" : "short";
}

/**
 * The expectation for one workspace.
 *
 * Its OWN query, deliberately not a field appended to readProfile's select
 * list: on an instance that has not applied 0051, PostgREST fails the whole
 * request for an unknown column, so sharing a query would take the existing
 * profile panels down with the new one. This way the blast radius of an
 * unapplied migration is exactly the surface that needs the column.
 *
 * A missing row is "stated nothing" rather than an error — nothing creates a
 * public.users row at signup (see ensureProfileRow), so a fresh operator
 * legitimately has none.
 */
export async function readKeyCustodyExpectation(
  db: Pick<SupabaseClient, "from">,
  userId: string
): Promise<KeyCustodyExpectationState> {
  try {
    const { data, error } = await db
      .from("users")
      .select(KEY_CUSTODY_EXPECTATION_COLUMN)
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      return {
        state: UNMIGRATED_CODES.has(error.code ?? "") ? "unmigrated" : "unavailable",
        expectation: null,
      };
    }
    const row = (data ?? null) as Record<string, unknown> | null;
    return {
      state: "ready",
      expectation: parseKeyCustodyExpectation(row?.[KEY_CUSTODY_EXPECTATION_COLUMN]),
    };
  } catch {
    return { state: "unavailable", expectation: null };
  }
}

/**
 * Write the expectation.
 *
 * Takes a SERVICE-ROLE client. 0032 revoked insert/update/delete on
 * public.users from `authenticated`, and 0051 deliberately adds no grant back —
 * 0033's note is explicit that never granting leaves a column server-write-only
 * by construction. The tenant boundary is therefore enforced in code: `userId`
 * comes from an MFA-verified session and is never taken from client input, the
 * same rule lib/profile/manage.ts opens with.
 *
 * A store this build cannot name a tier for is refused. Storing one would leave
 * every agent in the workspace sitting at `unknown` against a policy nothing
 * could ever satisfy.
 */
export async function writeKeyCustodyExpectation(
  admin: Pick<SupabaseClient, "from">,
  userId: string,
  expectation: string | null
): Promise<{ ok: true } | { ok: false; code: "unknown_store" | "unmigrated" | "write_failed" }> {
  if (expectation !== null && storeTier(expectation) === undefined) {
    return { ok: false, code: "unknown_store" };
  }

  const { error } = await admin
    .from("users")
    .update({ [KEY_CUSTODY_EXPECTATION_COLUMN]: expectation })
    .eq("id", userId); // tenant boundary — service_role bypasses RLS

  if (!error) return { ok: true };
  return {
    ok: false,
    code: UNMIGRATED_CODES.has((error as { code?: string }).code ?? "") ? "unmigrated" : "write_failed",
  };
}
