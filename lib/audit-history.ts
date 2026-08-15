// What changed about this agent, when, and — where the record allows it — from
// what.
//
// Pure, for the same reason lib/scope-rows.ts and lib/verify/receipt-view.ts
// are: the judgements here are the part worth testing, and a test should not
// need a React tree to reach them.
//
// ── The one rule this module exists to hold ─────────────────────────────────
//
// It must never claim to know a previous value it does not have. Audit rows
// written before `from`/`to` existed carry `fields:` alone, and the tempting
// repair — diff against the current value, or against the row before it — is
// wrong the moment a single write went unrecorded, which is exactly the
// population those rows come from. So a row with no `from` reads as "changed,
// and what it changed from was not recorded", and offers no diff at all.
//
// The same rule forbids the reverse error, and that one is subtler: a row whose
// stored value cannot be READ is not a row that predates the record. Saying "not
// recorded" over a snapshot that was recorded and then lost hides the loss on
// the one surface that exists to surface it. So there are three states, not two
// — see SnapshotState.
//
// This is the surface whose only job is to be trustworthy about the past. A
// gap it admits to is worth more than a diff it guessed.
import { toFallbackRows, type FallbackRow } from "./fallback-rows";
import { toScopeRows, type ScopeRow } from "./scope-rows";

export type ChangeVia = "dashboard" | "api";

/**
 * Which of three things is true about the values behind this row.
 *
 * "absent" and "unreadable" are both "no diff available", and collapsing them
 * into one flag is exactly how a truncated snapshot came to render as a row
 * that predated the record. They are different facts about the audit trail:
 * absent says we never wrote the value down; unreadable says a value that
 * should be here is not — it was cut, declined as too large, or written in a
 * shape this module cannot read. Only the second one is a reason to go looking.
 *
 * The reason WHY is carried at sentence level (see Gap), so the panel keeps two
 * lanes while the summary stays exact.
 */
export type SnapshotState = "recorded" | "absent" | "unreadable";

export interface CapabilityChange {
  id: string;
  at: string | null;
  action: string;
  /** One line, always present. */
  summary: string;
  /** Per-change lines, or null when the record does not support any. */
  detail: string[] | null;
  /** True only when this row's values are present AND readable. */
  recorded: boolean;
  /** Why `recorded` is false, when it is. */
  snapshot: SnapshotState;
  via: ChangeVia;
}

/** Audit actions that belong on ONE agent's page. */
const AGENT_ACTIONS = new Set([
  "agent.update",
  "agent.suspend",
  "agent.revoke",
  "agent.create",
  "agent.direct_key.create",
  "agent.direct_key.revoke",
  // The most privileged of them. Capability history shipped BEFORE break-glass
  // so that elevations would be reviewable here; omitting the action from this
  // set meant summariseChange returned null for both the grant and the end, the
  // page could say "Nothing recorded yet" for an agent that had been widened
  // beyond its stored capability, and the dropped rows still spent the fetch
  // limit that older changes needed.
  "agent.break_glass",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * One side of a change: a value, or the reason there isn't one.
 *
 * The reasons are kept apart on purpose — see SnapshotState. "absent" is a row
 * that never carried the value. "unreadable" is something stored that this
 * module cannot make a value of: JSON cut mid-document by the old 256-character
 * log bound, or a shape that is not diffable. "omitted" is the writer's own
 * marker, and it is the only one of the three that is a decision rather than a
 * loss — see omittedChars.
 */
type Gap = "absent" | "unreadable" | "omitted";
type Side = { ok: true; value: unknown } | { ok: false; why: Gap; chars?: number };

/**
 * Two of the three gaps are damage; "omitted" is a decision.
 *
 * The writer declines a value past AUDIT_VALUE_MAX_CHARS and leaves
 * `{ omitted: "too_large", chars }` in its place rather than storing a prefix.
 * Nothing about that row is corrupt — we chose not to store it — and the
 * operator is owed that difference, so it gets its own sentence. It still
 * renders in the damaged lane, because the fact that matters to a reader is the
 * same: a value that should be here is not.
 *
 * Matched structurally rather than by importing lib/audit.ts, which would drag
 * the service-role Supabase client into a module that is pure on purpose.
 */
function omittedChars(value: unknown): number | undefined | null {
  if (!isRecord(value) || value.omitted !== "too_large") return null;
  return typeof value.chars === "number" && Number.isFinite(value.chars) ? value.chars : undefined;
}

/**
 * `from`/`to` are JSON STRINGS, not objects — both writers call JSON.stringify.
 * A reader that assumed objects would produce an empty diff on every real row
 * while staying green against an object fixture.
 */
function parseSide(value: unknown): Side {
  if (value === undefined || value === null || value === "") return { ok: false, why: "absent" };
  const declined = omittedChars(value);
  if (declined !== null) return { ok: false, why: "omitted", chars: declined };
  if (typeof value !== "string") return { ok: false, why: "unreadable" };
  try {
    const parsed: unknown = JSON.parse(value);
    // `null` is what a never-set column serialises to, and it is meaningful:
    // "there was nothing here before". Anything scalar is not a value this
    // module knows how to diff.
    if (parsed === null || Array.isArray(parsed)) return { ok: true, value: parsed };
    return { ok: false, why: "unreadable" };
  } catch {
    return { ok: false, why: "unreadable" };
  }
}

/**
 * Both sides of a change, or the reason there is no diff.
 *
 * Both readable is the only case that supports one; a half-recorded change is
 * not a diff, and neither is a damaged one. When either side is present but
 * unreadable the row is damaged, and that outranks a merely missing other side
 * — the damage is the thing worth saying.
 */
type Pair =
  | { ok: true; from: unknown; to: unknown }
  | { ok: false; why: Gap; chars?: number };

/** Most specific reason wins: a declined value says more than a damaged one,
 *  and either says more than a value that was never there. */
function pair(from: Side, to: Side): Pair {
  if (from.ok && to.ok) return { ok: true, from: from.value, to: to.value };
  for (const why of ["omitted", "unreadable"] as const) {
    for (const side of [from, to]) {
      if (!side.ok && side.why === why) return { ok: false, why, chars: side.chars };
    }
  }
  return { ok: false, why: "absent" };
}

// Deliberately side-agnostic on the two damaged branches: `pair` reports them
// when EITHER side is affected, so a sentence naming the previous value would be
// wrong whenever it is the new one that is missing.
const GAP_CLAUSE: Record<Gap, string> = {
  absent: "the previous value was not recorded",
  unreadable: "what was recorded for it cannot be read",
  omitted: "the value was too large to record, so it was declined rather than stored in part",
};

/** How the reader is told about a gap, with the declined size when we have it. */
function gapClause(why: Gap, chars?: number): string {
  if (why !== "omitted" || chars === undefined) return GAP_CLAUSE[why];
  return `the value was too large to record (${chars.toLocaleString("en-GB")} characters), so it was declined rather than stored in part`;
}

const gapSentence = (why: Gap, chars?: number): string => {
  const clause = gapClause(why, chars);
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
};

/**
 * A declined value is not damage, but it is still a value that should be here
 * and is not — so it renders in the same lane as damage rather than as a row
 * that predates the record.
 */
const GAP_SNAPSHOT: Record<Gap, SnapshotState> = {
  absent: "absent",
  unreadable: "unreadable",
  omitted: "unreadable",
};

interface Summary {
  summary: string;
  detail: string[] | null;
  recorded: boolean;
  snapshot: SnapshotState;
}

/**
 * A change whose values this module cannot show, with the reason spelled out.
 *
 * Every field branch below routes through this rather than writing its own
 * sentence: a branch that spelled the sentence itself would keep saying "not
 * recorded" for a damaged row the day a second failure mode was added — which
 * is precisely the bug the states exist to prevent, and it has already happened
 * twice.
 */
function unresolved(noun: string, why: Gap, chars?: number): Summary {
  return {
    summary: `${noun} changed — ${gapClause(why, chars)}.`,
    detail: null,
    recorded: false,
    snapshot: GAP_SNAPSHOT[why],
  };
}

/**
 * Where the change came from.
 *
 * Only the control routes have ever set `via`. Rows already in the database
 * from the dashboard have it ABSENT, so absent must resolve to dashboard or
 * every historical change would be attributed to an API key nobody used. An
 * unrecognised value resolves the same way rather than becoming a third state
 * the UI would have to render.
 */
function readVia(metadata: Record<string, unknown>): ChangeVia {
  return metadata.via === "api" ? "api" : "dashboard";
}

/**
 * A policy side. Separate from parseSide because a policy is an OBJECT and
 * parseSide accepts only `null` and arrays — the two shapes toScopeRows and
 * toFallbackRows can read.
 *
 * Deliberately does NOT check whether the document is well-formed. This module
 * reports what was written, and a change that saved a malformed policy is
 * precisely the change someone comes here to find.
 */
function parsePolicySide(value: unknown): Side {
  if (value === undefined || value === null || value === "") return { ok: false, why: "absent" };
  if (typeof value !== "string") return { ok: false, why: "unreadable" };
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null) return { ok: true, value: null };
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, why: "unreadable" };
  } catch {
    return { ok: false, why: "unreadable" };
  }
}

/**
 * Lifecycle values are scalar strings (or null), not scope/policy documents.
 * Dashboard writers historically stored them directly, while prospective
 * previews stringify both sides just like the document writers do. Accepting
 * both representations keeps one vocabulary without rewriting old rows.
 */
function parseScalarSide(metadata: Record<string, unknown>, key: "from" | "to"): Side {
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) return { ok: false, why: "absent" };
  const raw = metadata[key];
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, why: "unreadable" };
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || typeof parsed === "string"
      ? { ok: true, value: parsed }
      : { ok: false, why: "unreadable" };
  } catch {
    return { ok: true, value: raw };
  }
}

function utcLabel(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "never";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function keyLabel(value: unknown, planned: boolean): string {
  if (planned) return "new browser-generated key";
  if (typeof value !== "string" || !value) return "not recorded";
  return `…${value.slice(-12)}`;
}

function durationLabel(seconds: number): string {
  if (seconds === 0) return "none — the old key stops authenticating immediately";
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? "" : "s"} — both keys authenticate during this window`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? "" : "s"} — both keys authenticate during this window`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} — both keys authenticate during this window`;
}

function summariseExpiry(metadata: Record<string, unknown>): Summary {
  const values = pair(parseScalarSide(metadata, "from"), parseScalarSide(metadata, "to"));
  if (!values.ok) return unresolved("Passport expiry", values.why, values.chars);
  const before = values.from === null ? null : text(values.from);
  const after = values.to === null ? null : text(values.to);
  if (before === after) {
    return {
      summary: "Passport expiry saved with no effective change.",
      detail: null,
      recorded: true,
      snapshot: "recorded",
    };
  }
  return {
    summary: before === null
      ? "Passport expiry added."
      : after === null
        ? "Passport expiry removed — this passport now works until it is revoked."
        : "Passport expiry changed.",
    detail: [`expiry: ${utcLabel(before)} → ${utcLabel(after)}`],
    recorded: true,
    snapshot: "recorded",
  };
}

function summariseRotation(metadata: Record<string, unknown>): Summary {
  const values = pair(parseScalarSide(metadata, "from"), parseScalarSide(metadata, "to"));
  if (!values.ok) return unresolved("Passport key", values.why, values.chars);
  const planned = metadata.planned === true;
  const detail = [
    `public key: ${keyLabel(values.from, false)} → ${keyLabel(values.to, planned)}`,
  ];
  const graceSeconds = metadata.grace_seconds;
  if (typeof graceSeconds === "number" && Number.isFinite(graceSeconds) && graceSeconds >= 0) {
    detail.push(`grace window: ${durationLabel(graceSeconds)}`);
  } else if (typeof metadata.previous_valid_until === "string") {
    detail.push(`both keys authenticate until ${utcLabel(metadata.previous_valid_until)}`);
  }
  return {
    summary: "Passport key rotated.",
    detail,
    recorded: true,
    snapshot: "recorded",
  };
}

/**
 * The shape of a policy change, in counts rather than a full diff.
 *
 * A rule-by-rule diff of deny rules and time windows would be a second policy
 * reader living outside lib/scope.ts, and the whole point of this feature is
 * that there is exactly one. Counts answer "did this get wider or narrower",
 * which is the question, without re-describing the grammar.
 */
function describePolicyChange(before: unknown, after: unknown): string[] {
  const size = (value: unknown, key: string): number => {
    if (!isRecord(value)) return 0;
    const list = value[key];
    return Array.isArray(list) ? list.length : 0;
  };
  const cap = (value: unknown): string => {
    if (!isRecord(value)) return "none";
    const raw = value.max_requests_per_hour;
    return typeof raw === "number" ? String(raw) : "none";
  };

  const lines: string[] = [];
  for (const [key, label] of [
    ["deny", "deny rules"],
    ["windows", "time windows"],
  ] as const) {
    const was = size(before, key);
    const now = size(after, key);
    if (was !== now) lines.push(`${label}: ${was} → ${now}`);
  }
  const wasCap = cap(before);
  const nowCap = cap(after);
  if (wasCap !== nowCap) lines.push(`hourly cap: ${wasCap} → ${nowCap}`);

  // Same counts and same cap can still be a different document — a changed
  // model pattern, a shifted window. Saying "no effective change" would be a
  // claim this function is not equipped to make.
  if (lines.length === 0 && JSON.stringify(before) !== JSON.stringify(after)) {
    lines.push("the rules were rewritten without changing how many there are");
  }
  return lines;
}

const fallbackKey = (row: FallbackRow) => `${row.provider}/${row.model}`;

/**
 * What a provider is actually authorized for: the UNION of every row naming it.
 *
 * `scopeRuleMatch` walks the whole list and stops at the first entry that
 * matches, so two rows for the same provider BOTH grant — nothing de-duplicates
 * them and nothing rejects them on the write path. A diff keyed by provider
 * alone therefore kept the last row and silently dropped the others, and
 * `[openai:[gpt-4], openai:[gpt-5]] → [openai:[*], openai:[gpt-5]]` — a widening
 * to every OpenAI model — compared as unchanged and read as "no effective
 * change". Comparing unions compares what the gateway will actually allow.
 *
 * First-seen order is kept for display; the comparison itself is order- and
 * duplicate-insensitive, because authorization is.
 */
function scopeUnion(rows: ScopeRow[]): Map<string, string[]> {
  const union = new Map<string, string[]>();
  for (const row of rows) {
    const patterns = union.get(row.provider) ?? [];
    for (const model of row.models) if (!patterns.includes(model)) patterns.push(model);
    union.set(row.provider, patterns);
  }
  return union;
}

const sameAuthorization = (was: string[], now: string[]): boolean =>
  was.length === now.length && JSON.stringify([...was].sort()) === JSON.stringify([...now].sort());

function diffScopes(from: ScopeRow[], to: ScopeRow[]): string[] {
  const lines: string[] = [];
  const before = scopeUnion(from);
  const after = scopeUnion(to);

  for (const [provider, models] of after) {
    const was = before.get(provider);
    if (!was) {
      lines.push(`${provider} added — ${models.join(", ") || "no model patterns"}`);
      continue;
    }
    if (!sameAuthorization(was, models)) {
      lines.push(`${provider}: ${was.join(", ") || "nothing"} → ${models.join(", ") || "nothing"}`);
    }
  }
  for (const [provider, models] of before) {
    if (!after.has(provider)) {
      lines.push(`${provider} removed — was ${models.join(", ") || "no model patterns"}`);
    }
  }

  // Same authorization, different document: rows merged, split or reordered.
  // Enforcement is unchanged, but the row is not, and "no effective change"
  // would be a claim about a document this function did not compare. Said the
  // same way describePolicyChange says it, one screen down.
  if (lines.length === 0 && JSON.stringify(from) !== JSON.stringify(to)) {
    lines.push("the same providers and model patterns, written differently");
  }
  return lines;
}

function diffFallbacks(from: FallbackRow[], to: FallbackRow[]): string[] {
  const lines: string[] = [];
  const before = from.map(fallbackKey);
  const after = to.map(fallbackKey);

  for (const key of after) if (!before.includes(key)) lines.push(`${key} added`);
  for (const key of before) if (!after.includes(key)) lines.push(`${key} removed`);

  // Order is not decoration: the list is tried first to last, so a reorder
  // changes which provider's key is spent first. Same members, different
  // sequence, is a real change and must not read as none.
  if (before.join("|") !== after.join("|")) {
    if (lines.length === 0) {
      lines.push(`order changed — now ${after.join(", ")}`);
    } else {
      lines.push(`order: ${before.join(", ") || "none"} → ${after.join(", ") || "none"}`);
    }
  }
  return lines;
}

function summariseUpdate(fields: string, metadata: Record<string, unknown>): Summary {
  if (fields === "expires_at") return summariseExpiry(metadata);
  if (fields === "passport_pubkey" && metadata.rotated === true) {
    return summariseRotation(metadata);
  }

  // Only the branches whose writers stringify a document read these. A field
  // this module does not know (expires_at, say, which records a bare date
  // string) must not be run through a JSON parser and reported as damaged when
  // nothing is wrong with it — see the closing branch.
  const sides = pair(parseSide(metadata.from), parseSide(metadata.to));

  if (fields === "allowed_scopes") {
    if (!sides.ok) return unresolved("Scope", sides.why, sides.chars);
    const after = toScopeRows(sides.to);
    const detail = diffScopes(toScopeRows(sides.from), after);
    const summary =
      after.length === 0
        ? "Scope cleared — this passport was left able to reach nothing."
        : detail.length === 0
          ? "Scope saved with no effective change."
          : "Scope changed.";
    return { summary, detail, recorded: true, snapshot: "recorded" };
  }

  if (fields === "fallbacks") {
    if (!sides.ok) return unresolved("Fallbacks", sides.why, sides.chars);
    const after = toFallbackRows(sides.to);
    const detail = diffFallbacks(toFallbackRows(sides.from), after);
    const summary =
      after.length === 0
        ? "Fallbacks cleared — a failed call now comes straight back to the agent."
        : detail.length === 0
          ? "Fallbacks saved with no effective change."
          : "Fallbacks changed.";
    return { summary, detail, recorded: true, snapshot: "recorded" };
  }

  // Policy is an OBJECT, not an array, so parseSide deliberately refuses it —
  // it exists to feed toScopeRows / toFallbackRows, which both take lists. These
  // two branches parse their own sides for that reason.
  if (fields === "policy_shadow") {
    const drafts = pair(parsePolicySide(metadata.from), parsePolicySide(metadata.to));
    if (!drafts.ok) return unresolved("Draft policy", drafts.why, drafts.chars);
    if (drafts.to === null) {
      return {
        summary: "Shadow mode turned off. The draft policy was cleared.",
        detail: null,
        recorded: true,
        snapshot: "recorded",
      };
    }
    return {
      summary:
        drafts.from === null
          ? "Shadow mode turned on. Nothing about enforcement changed."
          : "Draft policy changed. Nothing about enforcement changed.",
      detail: describePolicyChange(drafts.from, drafts.to),
      recorded: true,
      snapshot: "recorded",
    };
  }

  if (fields === "policy") {
    const policies = pair(parsePolicySide(metadata.from), parsePolicySide(metadata.to));
    // `promoted` distinguishes "this came from the draft you were testing" from
    // a direct policy write. The two are worth telling apart when reading back
    // why enforcement changed.
    const how = metadata.promoted === true ? "Draft policy promoted — it now decides calls." : "Policy changed.";
    if (!policies.ok) {
      return {
        summary: `${how} ${gapSentence(policies.why, policies.chars)}`,
        detail: null,
        recorded: false,
        snapshot: GAP_SNAPSHOT[policies.why],
      };
    }
    if (policies.to === null) {
      return {
        summary: "Policy cleared. Scope, endpoint controls and budgets still apply.",
        detail: null,
        recorded: true,
        snapshot: "recorded",
      };
    }
    return {
      summary: how,
      detail: describePolicyChange(policies.from, policies.to),
      recorded: true,
      snapshot: "recorded",
    };
  }

  if (fields.startsWith("budget")) {
    // updateAgentBudgets records `fields` only — there is no from/to to damage,
    // so this row is always the absent kind. Say so rather than skipping it, or
    // a budget change would be invisible in the one place someone looks for it.
    return unresolved("Budget", "absent");
  }

  if (fields === "name") {
    return { summary: "Name changed.", detail: null, recorded: false, snapshot: "absent" };
  }

  // A field this module has no reader for. `sides` is deliberately NOT consulted
  // here: expires_at, for one, records a bare ISO date in `to`, and calling that
  // damaged because it is not JSON would invent a loss that never happened. With
  // no reader, the only honest thing to say is that the value is not shown.
  return {
    summary: fields ? `Changed ${fields} — ${GAP_CLAUSE.absent}.` : "Changed.",
    detail: null,
    recorded: false,
    snapshot: "absent",
  };
}

/**
 * An elevation, and the end of one.
 *
 * The two shapes are fixed by app/dashboard/agents/[id]/break-glass-actions.ts:
 *
 *   grant  { via, reason, scopes: <JSON string>, expires_at }
 *   end    { via, ended: true, revoked: <count> }
 *
 * `ended === true` is the only field present in one and absent from the other,
 * so it is the discriminator. `revoked` is a COUNT of grants closed, not a
 * boolean — `revokeBreakGlass` returns the number of rows it updated — and 0
 * means there was nothing live to end. Reporting that as an ended elevation
 * would be the same class of untrue statement this module exists to avoid.
 *
 * Everything is parsed defensively and nothing is inferred: the granted scopes
 * are whatever the operator submitted, stringified, and a value this module
 * cannot read is said to be unreadable rather than guessed at or dropped.
 */
function summariseBreakGlass(metadata: Record<string, unknown>): Summary {
  if (metadata.ended === true) {
    const revoked = typeof metadata.revoked === "number" ? metadata.revoked : null;
    if (revoked === 0) {
      return {
        summary: "Break-glass elevation ended — there was no live elevation to end.",
        detail: null,
        recorded: true,
        snapshot: "recorded",
      };
    }
    return {
      summary: "Break-glass elevation ended.",
      // Stated because the button states it: ending stops NEW visas carrying the
      // elevation. One already minted keeps it until it expires, because the
      // proxy gates on the snapshot in the token.
      detail: ["a visa already minted keeps the elevation until it expires"],
      recorded: true,
      snapshot: "recorded",
    };
  }

  const granted = parseSide(metadata.scopes);
  const detail: string[] = [];
  if (granted.ok) {
    for (const row of toScopeRows(granted.value)) {
      detail.push(`${row.provider} — ${row.models.join(", ") || "no model patterns"}`);
    }
  }
  const until = text(metadata.expires_at).trim();
  if (until) detail.push(`until ${until}`);
  const reason = text(metadata.reason).trim();
  if (reason) detail.push(`reason: ${reason}`);

  if (!granted.ok) {
    // Same three gaps as everywhere else, said about what was GRANTED rather
    // than about a previous value — an elevation has no previous value; it has
    // a hole it opened, and that is the thing the reader came for.
    const why: Record<Gap, string> = {
      absent: "what it granted was not recorded",
      unreadable: "what it granted was recorded, but what is stored cannot be read",
      omitted:
        granted.chars === undefined
          ? "what it granted was too large to record, so it was declined rather than stored in part"
          : `what it granted was too large to record (${granted.chars.toLocaleString("en-GB")} characters), so it was declined rather than stored in part`,
    };
    return {
      summary: `Break-glass elevation taken — ${why[granted.why]}.`,
      detail: detail.length > 0 ? detail : null,
      recorded: false,
      snapshot: GAP_SNAPSHOT[granted.why],
    };
  }

  return {
    summary: "Break-glass elevation taken — this passport was widened beyond its stored capability.",
    detail,
    recorded: true,
    snapshot: "recorded",
  };
}

/** One audit row → one line of history, or null when it is not about an agent. */
export function summariseChange(raw: unknown): CapabilityChange | null {
  if (!isRecord(raw)) return null;
  const action = text(raw.action);
  if (!AGENT_ACTIONS.has(action)) return null;

  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const base = {
    id: text(raw.id),
    at: text(raw.created_at) || null,
    action,
    via: readVia(metadata),
  };

  if (action === "agent.create") {
    const name = text(metadata.name);
    const direct = metadata.auth_method === "direct_key";
    return {
      ...base,
      summary: direct
        ? name
          ? `Direct agent created as “${name}”.`
          : "Direct agent created."
        : name
          ? `Passport issued as “${name}”.`
          : "Passport issued.",
      detail: null,
      recorded: true,
      snapshot: "recorded",
    };
  }
  if (action === "agent.direct_key.create") {
    const name = text(metadata.name);
    const suffix = text(metadata.suffix);
    return {
      ...base,
      summary: `Direct Agent Key created${name ? ` for “${name}”` : ""}${suffix ? ` (…${suffix})` : ""}.`,
      detail: null,
      recorded: true,
      snapshot: "recorded",
    };
  }
  if (action === "agent.direct_key.revoke") {
    const name = text(metadata.name);
    const suffix = text(metadata.suffix);
    return {
      ...base,
      summary: `Direct Agent Key revoked${name ? ` for “${name}”` : ""}${suffix ? ` (…${suffix})` : ""}.`,
      detail: null,
      recorded: true,
      snapshot: "recorded",
    };
  }
  if (action === "agent.revoke") {
    return {
      ...base,
      summary: "Passport revoked. This is terminal — it can never be reactivated.",
      detail: null,
      recorded: true,
      snapshot: "recorded",
    };
  }
  if (action === "agent.suspend") {
    return {
      ...base,
      summary: metadata.suspended === true ? "Agent suspended." : "Agent resumed.",
      detail: null,
      recorded: true,
      snapshot: "recorded",
    };
  }
  // Before the fallthrough, and not only in AGENT_ACTIONS: an elevation carries
  // no `fields`, so reaching summariseUpdate would render the widest action in
  // the product as the word "Changed."
  if (action === "agent.break_glass") {
    return { ...base, ...summariseBreakGlass(metadata) };
  }

  return { ...base, ...summariseUpdate(text(metadata.fields), metadata) };
}

/** Rows → history, dropping anything that is not about this agent. */
export function toCapabilityHistory(rows: unknown): CapabilityChange[] {
  if (!Array.isArray(rows)) return [];
  const history: CapabilityChange[] = [];
  for (const row of rows) {
    const change = summariseChange(row);
    if (change) history.push(change);
  }
  return history;
}
