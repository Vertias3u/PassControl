// What an agent SAYS about where it keeps its passport private key.
//
// ── This is a self-report, and the product has to say so ────────────────────
//
// research/passport-key-protection.md §4 settles the question this module has
// to keep answering: the gateway cannot verify a key-storage claim at any tier.
// Tier 1 leaves no trace in a signature; tiers 2 and 3 would need hardware
// attestation. So the honest contract is "report the tier, label it as
// declared, and never let the UI imply it was checked" — which is why nothing
// here reaches a receipt, a visa claim, or any policy gate. A receipt proves
// what the gateway ENFORCED. This proves only what an agent claimed.
//
// ── Why the declaration rides inside the SIGNED challenge payload ───────────
//
// A passport id is public: /verify/[passportId] serves one, and a published
// agent shows another. An unsigned header or body field would let any stranger
// who knows an agent's id set what its operator's dashboard reports about key
// custody. Carrying it inside the bytes the passport key signs makes the claim
// attributable to the key holder — still a claim, but one only the holder can
// make. The route must therefore record it only AFTER the signature verifies.
//
// ── Why Redis and not a column ──────────────────────────────────────────────
//
// It is evidence with a shelf life, not a fact about the agent, and it follows
// lib/passport-source-observation.ts exactly: written best-effort on a verified
// mint, capped by one TTL, fail-open at every step. An evicted or expired value
// costs an operator a dashboard line and costs an agent nothing. It also keeps
// the feature off the migration path entirely.
import type { Redis } from "@upstash/redis";

/**
 * Mirrors PASSPORT_SOURCE_STATE_TTL_SECONDS: an agent that mints at all keeps
 * its declaration alive, and one silent for a season stops being described by a
 * claim nobody has repeated. Expiry here reads as "undeclared", never as tier 0.
 */
export const PASSPORT_KEY_STORAGE_TTL_SECONDS = 45 * 24 * 60 * 60;

/**
 * A declaration is stale once the agent has authenticated well after making it —
 * those later mints said nothing about storage, so the claim describes an
 * earlier moment. Generous, because a mint burst around a declaration is normal.
 */
const SUPERSEDED_AFTER_MS = 60 * 60 * 1000;

/** Stores this build understands, and the tier each one means. */
const KNOWN_STORES: Record<string, 0 | 1> = { file: 0, os: 1 };

// Client-controlled text that ends up on an operator's dashboard. Bounded at the
// door: lowercase, short, no separators, no markup.
const STORE_TOKEN = /^[a-z][a-z0-9_]{0,31}$/;

const keyStorageKey = (agentId: string) => `keystorage:${agentId}`;

export interface KeyStorageDeclaration {
  store: string;
  fallback: boolean;
}

export interface StoredKeyStorageDeclaration extends KeyStorageDeclaration {
  declaredAt: string;
}

export interface DeclaredKeyStorageView {
  state: "declared" | "unrecognised" | "undeclared";
  /** For assertions and styling — the prose is free to change, this is not. */
  dataState: "os" | "file" | "unknown" | "undeclared";
  store: string | null;
  /** Present only for a store this build can name a tier for. */
  tier?: 0 | 1;
  declaredAt: string | null;
  /** The agent meant to be on tier 1 and read its key from the file instead. */
  fellBack: boolean;
  /** Always false. It exists so a renderer cannot forget which of the two it is. */
  verified: false;
  supersededByLaterActivity: boolean;
}

/**
 * Read a declaration out of a challenge payload.
 *
 * A store name this build does not know is KEPT, not dropped: a newer CLI on a
 * tier that shipped after this deployment must render as "unrecognised" rather
 * than silently as tier 0, which is the exact lie the panel exists to prevent.
 * Anything malformed returns null — a declaration is never worth a failed mint.
 */
export function parseKeyStorageDeclaration(value: unknown): KeyStorageDeclaration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.store !== "string" || !STORE_TOKEN.test(row.store)) return null;
  return { store: row.store, fallback: row.fallback === true };
}

/** Best-effort. Callers must not await this in a way that can fail the mint. */
export async function recordDeclaredKeyStorage(
  r: Pick<Redis, "set">,
  agentId: string,
  declaration: KeyStorageDeclaration,
  now: number = Date.now()
): Promise<void> {
  await r.set(
    keyStorageKey(agentId),
    JSON.stringify({
      store: declaration.store,
      fallback: declaration.fallback,
      at: new Date(now).toISOString(),
    }),
    { ex: PASSPORT_KEY_STORAGE_TTL_SECONDS }
  );
}

/**
 * One stored value → a declaration, or null.
 *
 * Extracted rather than inlined because there are now two readers, the single
 * agent page and the fleet's batch read, and the Upstash quirk below is exactly
 * the kind of detail a second hand-rolled copy forgets.
 */
function parseStoredDeclaration(raw: unknown): StoredKeyStorageDeclaration | null {
  // The Upstash client JSON.parses every response, so a value written as JSON
  // text comes back as an object — see the asCachedString note in
  // lib/state/redis.ts. Accept both rather than assume either.
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const row = candidate as Record<string, unknown>;
  const parsed = parseKeyStorageDeclaration(row);
  if (!parsed) return null;
  if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) return null;
  return { ...parsed, declaredAt: row.at };
}

export async function readDeclaredKeyStorage(
  r: Pick<Redis, "get">,
  agentId: string
): Promise<StoredKeyStorageDeclaration | null> {
  try {
    return parseStoredDeclaration(await r.get(keyStorageKey(agentId)));
  } catch {
    // An unreachable Redis is "nothing declared", which the view already knows
    // how to say honestly. It is never an error on a page about an agent.
    return null;
  }
}

/**
 * Every declaration for one page of agents, in a single round trip.
 *
 * The fleet table shows a custody line per row, and a `get` per row would put a
 * Redis round trip behind each line of the one table on the dashboard that
 * exists to be scanned quickly. Callers pass PASSPORT agent ids only — a Direct
 * Agent Key has no private key to keep anywhere, so a missing entry for one
 * would be a question that was never asked reading as an answer.
 *
 * Absence from the returned map is the only way an agent reads as undeclared,
 * and it is deliberately indistinguishable from an unreachable Redis: both mean
 * this instance has not heard a claim, which is what the view already says.
 */
export async function readDeclaredKeyStorageMany(
  r: Pick<Redis, "mget">,
  agentIds: string[]
): Promise<Record<string, StoredKeyStorageDeclaration>> {
  const ids = [...new Set(agentIds)];
  // Upstash rejects a zero-key MGET, and a workspace whose agents are all
  // Direct Agent Keys asks for exactly that.
  if (!ids.length) return {};

  let values: unknown[];
  try {
    values = (await r.mget(...ids.map(keyStorageKey))) as unknown[];
  } catch {
    return {};
  }

  const found: Record<string, StoredKeyStorageDeclaration> = {};
  ids.forEach((agentId, index) => {
    const parsed = parseStoredDeclaration(values?.[index]);
    if (parsed) found[agentId] = parsed;
  });
  return found;
}

/**
 * The tier a store name means, or undefined for one this build has never heard
 * of. Exported so the workspace expectation can compare tiers ORDINALLY rather
 * than by string equality — see lib/key-custody-expectation.ts.
 */
export function storeTier(store: string): 0 | 1 | undefined {
  return KNOWN_STORES[store];
}

/**
 * Turn a declaration — or its absence — into what the dashboard may say.
 *
 * `latestActivityAt` is the freshest evidence the page has that this agent
 * authenticated. `agents.last_seen_at` lags behind the reconcile flush by up to
 * a day, so it can only ever be older than the truth: that direction
 * under-reports staleness, which is the safe way to be wrong here.
 */
export function toDeclaredKeyStorageView(
  declaration: StoredKeyStorageDeclaration | null,
  latestActivityAt: string | null
): DeclaredKeyStorageView {
  if (!declaration) {
    return {
      state: "undeclared",
      dataState: "undeclared",
      store: null,
      declaredAt: null,
      fellBack: false,
      verified: false,
      supersededByLaterActivity: false,
    };
  }

  const declaredMs = Date.parse(declaration.declaredAt);
  const activityMs = latestActivityAt ? Date.parse(latestActivityAt) : NaN;
  const superseded =
    Number.isFinite(declaredMs) &&
    Number.isFinite(activityMs) &&
    activityMs - declaredMs > SUPERSEDED_AFTER_MS;

  const tier = KNOWN_STORES[declaration.store];
  const known = tier !== undefined;

  return {
    state: known ? "declared" : "unrecognised",
    dataState: known ? (declaration.store as "os" | "file") : "unknown",
    store: declaration.store,
    ...(known ? { tier } : {}),
    declaredAt: declaration.declaredAt,
    fellBack: declaration.fallback,
    verified: false,
    supersededByLaterActivity: superseded,
  };
}
