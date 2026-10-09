"use client";
// Try a policy before it bites.
//
// This is also, as it happens, the FIRST way to write `policy` from a browser at
// all — the live summary above it has always been read-only. That is deliberate
// rather than incidental: the only route from here to enforcement is Promote,
// which copies the exact document the numbers on this panel describe. An
// operator can never enforce a rule they did not first watch run.
//
// ── What this UI has to be honest about ─────────────────────────────────────
//
// 1. A MALFORMED DRAFT IS NOT A STRICT DRAFT. parsePolicy rejects the whole
//    document on any violation, so a typo records "would block" against every
//    attempt — by the numbers alone, identical to a draft that is working and
//    blocking everything. So the invalid state is announced BEFORE the counts,
//    and the counts are suppressed while it holds. The number would be true and
//    the conclusion it invites would be wrong.
// 2. THE COUNTS ARE ATTEMPTS, AND A FLOOR. One call that failed over writes two
//    audit rows carrying the same verdict, and writeLog is best-effort, so rows
//    can be missing entirely. Both are said out loud rather than smoothed over.
// 3. PROMOTING CHANGES ENFORCEMENT. The button says what it will do to live
//    traffic, and that shadow mode ends when it does.
import { useState, useTransition } from "react";

import { POLICY_DAYS } from "@/lib/scope";
import type { ShadowState } from "@/lib/policy-shadow";
import {
  promoteAgentPolicyShadow,
  saveAgentPolicyShadow,
} from "@/app/dashboard/agents/[id]/shadow-actions";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";
import { prospectiveAgentChange } from "@/lib/impact-preview";
import { ImpactPreview } from "@/components/ImpactPreview";

const MAX_DENY_RULES = 10;
const MAX_WINDOWS = 6;

interface DenyDraft {
  provider: string;
  models: string;
}

interface WindowDraft {
  days: string[];
  start: string;
  end: string;
}

/** The editable form of a policy document. */
interface Draft {
  deny: DenyDraft[];
  windows: WindowDraft[];
  cap: string;
  /** `max_output_tokens`. A string so a half-typed number is not lost. */
  ceiling: string;
  /** `subagent_models` rows: what a DECLARED sub-agent may call (sprint C(a)). */
  subagentRules: DenyDraft[];
  /**
   * The explicit "sub-agents may call no model" choice, stored as `[]`. Its own
   * control, so a cleared list can only ever mean "not restricted".
   */
  subagentNone: boolean;
  /** `secret_guard.mode`, or "" for off. */
  secretGuard: "" | "block" | "redact";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored policy → the form. Unreadable pieces become empty rather than throwing. */
export function toDraft(policy: unknown): Draft {
  const source = isRecord(policy) ? policy : {};
  const deny = Array.isArray(source.deny)
    ? source.deny.filter(isRecord).map((rule) => ({
        provider: typeof rule.provider === "string" ? rule.provider : "",
        models: Array.isArray(rule.models)
          ? rule.models.filter((m): m is string => typeof m === "string").join(", ")
          : "",
      }))
    : [];
  const windows = Array.isArray(source.windows)
    ? source.windows.filter(isRecord).map((w) => ({
        days: Array.isArray(w.days) ? w.days.filter((d): d is string => typeof d === "string") : [],
        start: typeof w.start === "string" ? w.start : "",
        end: typeof w.end === "string" ? w.end : "",
      }))
    : [];
  const cap = typeof source.max_requests_per_hour === "number" ? String(source.max_requests_per_hour) : "";
  // Round-tripped, so saving a draft that already carries a ceiling cannot drop
  // it — this form is the only browser route to the live policy, via Promote.
  const ceiling = typeof source.max_output_tokens === "number" ? String(source.max_output_tokens) : "";
  // Round-tripped for the same reason as the ceiling.
  const subagentList = Array.isArray(source.subagent_models) ? source.subagent_models.filter(isRecord) : null;
  const subagentRules = (subagentList ?? []).map((rule) => ({
    provider: typeof rule.provider === "string" ? rule.provider : "",
    models: Array.isArray(rule.models) ? rule.models.filter((m): m is string => typeof m === "string").join(", ") : "",
  }));
  const subagentNone = Array.isArray(source.subagent_models) && source.subagent_models.length === 0;
  // Round-tripped for the same reason as the ceiling.
  const guardMode = isRecord(source.secret_guard) ? source.secret_guard.mode : undefined;
  const secretGuard = guardMode === "block" || guardMode === "redact" ? guardMode : "";
  return { deny, windows, cap, ceiling, subagentRules, subagentNone, secretGuard };
}

/**
 * Where the form starts: the draft being measured if there is one, otherwise the
 * LIVE policy (owner decision 2026-09-27). An empty start meant a draft written
 * to add one rule dropped every other live rule on promotion, silently.
 */
export function initialDraft(shadowDraft: unknown, livePolicy: unknown, liveReadable: boolean): Draft {
  if (shadowDraft !== null && shadowDraft !== undefined) return toDraft(shadowDraft);
  // A live policy the gateway cannot read (policy:malformed) is not copied: the
  // form would carry only its readable pieces, and promoting that partial copy
  // would drop the rest without saying so.
  return toDraft(liveReadable ? livePolicy : null);
}

/**
 * The form → what gets stored, or `null` for an empty draft.
 *
 * `null`, not `{}`. `{}` is a well-formed policy meaning "permit everything",
 * so saving it would leave shadow mode ON, recording "allow" against every
 * attempt, while the operator believes they switched it off. Note this is
 * inverted from fallbacks, where `[]` is the value that means off. The server
 * normalises this too — the form is not the only writer.
 */
export function toPolicy(draft: Draft): unknown {
  const policy: Record<string, unknown> = {};

  const deny = draft.deny
    .map((rule) => ({
      provider: rule.provider.trim(),
      models: rule.models
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    }))
    .filter((rule) => rule.provider && rule.models.length > 0);
  if (deny.length) policy.deny = deny;

  const windows = draft.windows
    .filter((w) => w.days.length > 0 && w.start && w.end)
    .map((w) => ({ days: w.days, start: w.start, end: w.end, tz: "UTC" }));
  if (windows.length) policy.windows = windows;

  const cap = Number(draft.cap.trim());
  if (draft.cap.trim() && Number.isSafeInteger(cap) && cap > 0) {
    policy.max_requests_per_hour = cap;
  }

  const ceiling = Number(draft.ceiling.trim());
  if (draft.ceiling.trim() && Number.isSafeInteger(ceiling) && ceiling > 0) {
    policy.max_output_tokens = ceiling;
  }

  // Absent unless the operator listed something or chose "no model at all".
  // A cleared list is "not restricted", never `[]`.
  if (draft.subagentNone) {
    policy.subagent_models = [];
  } else {
    const subagent = draft.subagentRules
      .map((rule) => ({
        provider: rule.provider.trim(),
        models: rule.models
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
      }))
      .filter((rule) => rule.provider && rule.models.length > 0);
    if (subagent.length) policy.subagent_models = subagent;
  }

  if (draft.secretGuard) policy.secret_guard = { mode: draft.secretGuard };

  return Object.keys(policy).length === 0 ? null : policy;
}

const SECRET_GUARD_CHOICES = [
  { value: "", label: "Off" },
  {
    value: "redact",
    label: "Replace with a placeholder",
    help: "The call goes through with the key swapped for a placeholder naming its kind, so the model never sees it. In a coding agent, a file the model then rewrites gets the placeholder back, not the key.",
  },
  {
    value: "block",
    label: "Refuse the call",
    help: "Nothing is sent. Claude Code and Codex re-send the whole conversation on every call, so once a key is in it every later call is refused too, until the user removes it (/rewind or /clear).",
  },
] as const;

/**
 * `secret_guard` (2026-10-08): what to do when a request carries something that looks
 * like a key (lib/secret-guard.ts). Exported on its own so it can be rendered and
 * tested without opening the whole form.
 */
export function SecretGuardField({
  draft,
  setDraft,
  pending,
}: {
  draft: Draft;
  setDraft: (update: (prev: Draft) => Draft) => void;
  pending: boolean;
}) {
  return (
    <fieldset className="m-0 grid gap-3 border-0 border-t border-border p-0 pt-4" data-policy-field="secret_guard">
      <legend className="m-0 p-0 text-sm font-semibold text-foreground">Keys in requests</legend>
      <p className="m-0 text-xs leading-5 text-muted-foreground">
        When a request carries something that looks like a key (a provider key, a GitHub or cloud token, a private
        key, a PassControl key), PassControl can stop it reaching the provider. Made-up test values and base64
        images are left alone. Takes effect when promoted; shadow mode does not measure it.
      </p>
      {SECRET_GUARD_CHOICES.map((choice) => (
        <label key={choice.value || "off"} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="secret_guard"
            value={choice.value}
            checked={draft.secretGuard === choice.value}
            disabled={pending}
            onChange={() => setDraft((prev) => ({ ...prev, secretGuard: choice.value }))}
          />
          <span className="grid gap-1">
            <span>{choice.label}</span>
            {"help" in choice ? <span className="text-xs leading-5 text-muted-foreground">{choice.help}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * `subagent_models` (sprint C(a)): which models a sub-agent of this agent may
 * call. Exported on its own so it can be rendered and tested without opening the
 * whole form.
 */
export function SubagentModelsField({
  draft,
  setDraft,
  pending,
}: {
  draft: Draft;
  setDraft: (update: (prev: Draft) => Draft) => void;
  pending: boolean;
}) {
  const setRule = (index: number, patch: Partial<DenyDraft>) =>
    setDraft((prev) => ({
      ...prev,
      subagentRules: prev.subagentRules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  return (
    <div className="grid gap-3 border-t border-border pt-4" data-policy-field="subagent_models">
      <p className="m-0 text-sm font-semibold text-foreground">Sub-agent models</p>
      <p className="m-0 text-xs leading-5 text-muted-foreground">
        When Claude Code or Codex declares that a sub-agent made the call, it may only use these models; the main
        agent keeps its full scope. A guard rail against a misbehaving model, not a security boundary: the
        sub-agent is declared by the client, and a call that declares none is treated as the main agent. Leave it
        empty for no restriction.
      </p>
      {draft.subagentRules.map((rule, index) => (
        <div key={index} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Provider</span>
            <input
              value={rule.provider}
              onChange={(e) => setRule(index, { provider: e.target.value })}
              placeholder="anthropic"
              spellCheck={false}
              disabled={draft.subagentNone}
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Models — comma separated, <code>*</code> allowed
            </span>
            <input
              value={rule.models}
              onChange={(e) => setRule(index, { models: e.target.value })}
              placeholder="claude-haiku-*"
              spellCheck={false}
              disabled={draft.subagentNone}
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <button
            type="button"
            className="ghost"
            disabled={pending}
            onClick={() => setDraft((prev) => ({ ...prev, subagentRules: prev.subagentRules.filter((_, i) => i !== index) }))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="ghost"
          disabled={pending || draft.subagentNone || draft.subagentRules.length >= MAX_DENY_RULES}
          onClick={() => setDraft((prev) => ({ ...prev, subagentRules: [...prev.subagentRules, { provider: "", models: "" }] }))}
        >
          Add sub-agent model
        </button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.subagentNone}
            disabled={pending}
            onChange={(e) => setDraft((prev) => ({ ...prev, subagentNone: e.target.checked }))}
          />
          Sub-agents may call no model at all
        </label>
      </div>
    </div>
  );
}

/** "attempt" / "attempts". The unit is load-bearing here, so it should read right. */
const plural = (n: number) => (n === 1 ? "attempt" : "attempts");

function Counts({ shadow }: { shadow: ShadowState }) {
  const { divergence } = shadow;
  const { format } = useDashboardTime();

  if (divergence.considered === 0) {
    return (
      <p
        className="m-0 rounded-lg border border-dashed border-border p-4 text-sm leading-6 text-muted-foreground"
        data-state="no-observations"
      >
        No attempts have been measured against this draft yet. Traffic recorded from now on will
        show up here — an attempt that a kill switch, scope or budget stopped before the policy step
        is not counted, because the draft never got a say in it. Neither is an attempt measured
        against a different draft, nor one where this draft sets an hourly cap the live policy does
        not: the counter that would answer it was never read, and this panel does not guess.
      </p>
    );
  }

  return (
    <div className="grid gap-3" data-state="observed">
      {/* Which draft the numbers below are about. Attribution is by revision —
          each verdict is stamped with the draft that produced it — so this is a
          statement of fact rather than an inference from when a row landed. */}
      <p className="m-0 text-xs uppercase tracking-[0.14em] text-muted-foreground" data-state="dated">
        Measured against this draft
        {shadow.revision ? ` · revision ${shadow.revision.slice(0, 8)}` : ""}
        {shadow.since ? ` · since ${format(shadow.since, "short")}` : ""}
      </p>
      {/* The attribution failure that is still real: a verdict with no stamp,
          or one stamped by a different draft, cannot be counted here. Saying
          which is the difference between a caveat and an excuse. */}
      {divergence.partial ? (
        <p
          className="m-0 rounded-lg border p-3 text-xs leading-5 text-muted-foreground"
          style={{
            borderColor: "var(--warning)",
            background: "color-mix(in srgb, var(--warning) 10%, transparent)",
          }}
          data-state="unattributed"
        >
          <strong>Some recorded attempts are not counted above.</strong> A verdict counts only when
          it carries this draft&rsquo;s revision, so attempts measured against a different draft,
          attempts recorded before verdicts carried one, attempts an earlier gate decided before the
          policy step, and attempts where this draft&rsquo;s hourly cap had no counter reading of
          its own are all excluded. They are excluded because they cannot be attributed, not because
          they agreed.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-secondary/40 p-4" data-state="would-block">
          <p className="m-0 text-2xl font-bold tabular-nums text-foreground">
            {divergence.wouldBlock.toLocaleString()}
          </p>
          <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
            {plural(divergence.wouldBlock)} the draft would have <strong>blocked</strong> that the
            live policy let past
          </p>
        </div>
        <div className="rounded-lg border border-border bg-secondary/40 p-4" data-state="would-allow">
          <p className="m-0 text-2xl font-bold tabular-nums text-foreground">
            {divergence.wouldAllow.toLocaleString()}
          </p>
          <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
            {plural(divergence.wouldAllow)} the draft would have <strong>allowed</strong> that the
            live policy blocked
          </p>
        </div>
        <div className="rounded-lg border border-border bg-secondary/40 p-4" data-state="agreed">
          <p className="m-0 text-2xl font-bold tabular-nums text-foreground">
            {divergence.agreed.toLocaleString()}
          </p>
          <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
            {plural(divergence.agreed)} where the two agreed
          </p>
        </div>
      </div>

      {/* Both caveats, at the numbers rather than in a footnote. */}
      <p className="m-0 text-xs leading-5 text-muted-foreground">
        Out of {divergence.considered.toLocaleString()} recorded{" "}
        <strong>{plural(divergence.considered)}</strong>, not calls: a call that failed over to a
        second provider is recorded once per provider tried, and each attempt carries the verdict
        for the provider and model it actually went to. These are a floor. Audit writes are
        best-effort, so a database failure loses a row and the verdict on it.
      </p>
    </div>
  );
}

export function PolicyShadowPanel({
  agentId,
  shadow,
  liveConfigured,
  liveReadable = false,
  livePolicy = null,
}: {
  agentId: string;
  shadow: ShadowState;
  liveConfigured: boolean;
  /** The live policy parses. Absent reads as not, so a caller that forgets cannot seed a partial copy. */
  liveReadable?: boolean;
  livePolicy?: unknown;
}) {
  const active = shadow.draft !== null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(shadow.draft, livePolicy, liveReadable));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const promotionPreview = active && shadow.wellFormed
    ? prospectiveAgentChange("policy", livePolicy, shadow.draft, { promoted: true })
    : null;

  const setWindow = (index: number, patch: Partial<WindowDraft>) =>
    setDraft((prev) => ({
      ...prev,
      windows: prev.windows.map((w, i) => (i === index ? { ...w, ...patch } : w)),
    }));
  const setDeny = (index: number, patch: Partial<DenyDraft>) =>
    setDraft((prev) => ({
      ...prev,
      deny: prev.deny.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));

  const run = (action: () => Promise<{ ok?: true; error?: string }>, onOk?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else onOk?.();
    });
  };

  const save = () =>
    run(() => saveAgentPolicyShadow(agentId, toPolicy(draft)), () => setEditing(false));

  // The revision the numbers above were counted under. Sending it is what makes
  // Promote mean "ship the draft I reviewed" rather than "ship whatever is
  // there now" — if another tab saved a different draft in the meantime, the
  // server refuses instead of quietly shipping it.
  const promote = () => run(() => promoteAgentPolicyShadow(agentId, shadow.revision ?? ""));

  return (
    <section
      className="grid gap-4 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
      aria-labelledby="policy-shadow-heading"
      data-state={active ? (shadow.wellFormed ? "active" : "invalid") : "off"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Policy you can try before it bites
          </p>
          <h2 id="policy-shadow-heading" className="mt-2 text-lg font-bold text-foreground">
            Shadow policy
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            A draft policy is checked against every call alongside the live one, and its verdict is
            recorded. It decides nothing — no response changes, no call is blocked, no key is
            withheld. When the numbers say what you expect, promote it.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
          {active ? "Running · decides nothing" : "Off"}
        </span>
      </div>

      {/* Announced before the counts, and the counts are suppressed while it
          holds: a malformed draft records "would block" on everything, which
          reads exactly like a draft that works. */}
      {active && !shadow.wellFormed ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-4"
          data-state="malformed"
        >
          <p className="m-0 text-sm font-semibold text-destructive">
            This draft is not a policy the gateway can read.
          </p>
          <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
            It is inert, so nothing is being blocked by it — but every attempt records
            &ldquo;would block&rdquo;, because an unreadable policy denies everything. That is a
            broken draft, not a strict one, so the counts are not shown. Promoting it is refused.
          </p>
        </div>
      ) : active ? (
        <Counts shadow={shadow} />
      ) : (
        <p
          className="m-0 rounded-lg border border-dashed border-border p-5 text-sm leading-6 text-muted-foreground"
          data-state="off"
        >
          Shadow mode is off. Write a draft below to start measuring what it would have done,
          without it doing anything.
        </p>
      )}

      {editing ? (
        <form
          className="grid gap-5 rounded-lg border border-border bg-secondary/40 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="grid gap-3">
            <p className="m-0 text-sm font-semibold text-foreground">Denied models</p>
            {draft.deny.length === 0 ? (
              <p className="m-0 text-xs text-muted-foreground">None. Nothing is denied by model.</p>
            ) : (
              draft.deny.map((rule, index) => (
                <div key={index} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      Provider
                    </span>
                    <input
                      value={rule.provider}
                      onChange={(e) => setDeny(index, { provider: e.target.value })}
                      placeholder="anthropic"
                      spellCheck={false}
                      className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      Models — comma separated, <code>*</code> allowed
                    </span>
                    <input
                      value={rule.models}
                      onChange={(e) => setDeny(index, { models: e.target.value })}
                      placeholder="claude-opus-*, claude-4-*"
                      spellCheck={false}
                      className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    disabled={pending}
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        deny: prev.deny.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
            <div>
              <button
                type="button"
                className="ghost"
                disabled={pending || draft.deny.length >= MAX_DENY_RULES}
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    deny: [...prev.deny, { provider: "", models: "" }],
                  }))
                }
              >
                Add deny rule
              </button>
            </div>
          </div>

          <div className="grid gap-3 border-t border-border pt-4">
            <p className="m-0 text-sm font-semibold text-foreground">
              Allowed windows <span className="font-normal text-muted-foreground">(UTC)</span>
            </p>
            {draft.windows.length === 0 ? (
              <p className="m-0 text-xs text-muted-foreground">
                None. Calls are allowed at any time of day.
              </p>
            ) : (
              draft.windows.map((window, index) => (
                <div key={index} className="grid gap-3 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap gap-2">
                    {POLICY_DAYS.map((day) => {
                      const on = window.days.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          disabled={pending}
                          aria-pressed={on}
                          onClick={() =>
                            setWindow(index, {
                              days: on
                                ? window.days.filter((d) => d !== day)
                                : [...window.days, day],
                            })
                          }
                          className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${
                            on
                              ? "border-primary bg-primary/15 text-foreground"
                              : "border-border bg-background text-muted-foreground"
                          }`}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <label className="grid gap-1 text-sm">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">
                        From
                      </span>
                      <input
                        type="time"
                        value={window.start}
                        onChange={(e) => setWindow(index, { start: e.target.value })}
                        className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
                      />
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">
                        Until
                      </span>
                      <input
                        type="time"
                        value={window.end}
                        onChange={(e) => setWindow(index, { end: e.target.value })}
                        className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
                      />
                    </label>
                    <button
                      type="button"
                      className="ghost"
                      disabled={pending}
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          windows: prev.windows.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))
            )}
            <div>
              <button
                type="button"
                className="ghost"
                disabled={pending || draft.windows.length >= MAX_WINDOWS}
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    windows: [...prev.windows, { days: [], start: "09:00", end: "17:00" }],
                  }))
                }
              >
                Add window
              </button>
            </div>
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              Windows are UTC and do not wrap past midnight — the start must be earlier than the
              end. Adding any window means calls outside all of them are denied.
            </p>
          </div>

          <div className="grid gap-1 border-t border-border pt-4">
            <label className="grid gap-1 text-sm">
              <span className="text-sm font-semibold text-foreground">Hourly request cap</span>
              <input
                value={draft.cap}
                onChange={(e) => setDraft((prev) => ({ ...prev, cap: e.target.value }))}
                inputMode="numeric"
                placeholder="Leave empty for no additional cap"
                className="h-10 max-w-xs rounded-lg border border-border bg-background px-3 text-sm"
              />
            </label>
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              Counted against the same hourly reading the live policy uses — measuring a draft never
              consumes the cap twice.
            </p>
          </div>

          <div className="grid gap-1 border-t border-border pt-4" data-policy-field="max_output_tokens">
            <label className="grid gap-1 text-sm">
              <span className="text-sm font-semibold text-foreground">Output ceiling (tokens per request)</span>
              <input
                value={draft.ceiling}
                onChange={(e) => setDraft((prev) => ({ ...prev, ceiling: e.target.value }))}
                inputMode="numeric"
                placeholder="Leave empty for no ceiling"
                className="h-10 max-w-xs rounded-lg border border-border bg-background px-3 text-sm"
              />
            </label>
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              Every request must then state its own limit — <code>max_tokens</code>,{" "}
              <code>max_completion_tokens</code> or <code>max_output_tokens</code>, times <code>n</code> —
              at or under this number. A request that states none, or a larger one, is refused and told
              the ceiling; PassControl never shortens a request for you. Many SDKs omit the limit by
              default, so watch this draft&rsquo;s counts before promoting it.
            </p>
          </div>

          <SubagentModelsField draft={draft} setDraft={setDraft} pending={pending} />

          <SecretGuardField draft={draft} setDraft={setDraft} pending={pending} />

          <p className="m-0 rounded-lg border border-border bg-background p-3 text-xs leading-5 text-muted-foreground">
            Saving a draft changes nothing about enforcement. An empty draft turns shadow mode off.
            Takes effect within 60 seconds.
          </p>

          {error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="ghost"
              disabled={pending}
              onClick={() => {
                setDraft(initialDraft(shadow.draft, livePolicy, liveReadable));
                setError(null);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="submit" disabled={pending}>
              {pending
                ? "Saving…"
                : toPolicy(draft) === null
                  ? "Save — turns shadow mode off"
                  : "Save draft"}
            </button>
          </div>
        </form>
      ) : (
        <>
          {error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {promotionPreview ? (
            <ImpactPreview change={promotionPreview} title="Live-policy impact" />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="ghost" disabled={pending} onClick={() => setEditing(true)}>
              {active ? "Edit draft" : liveConfigured && liveReadable ? "Write a draft from the live policy" : "Write a draft policy"}
            </button>
            {active && shadow.wellFormed ? (
              <button type="button" disabled={pending} onClick={promote}>
                {pending ? "Promoting…" : "Promote to live policy"}
              </button>
            ) : null}
          </div>
          {active && shadow.wellFormed ? (
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              Promoting makes this exact draft the policy that decides calls
              {liveConfigured ? ", replacing the live one above" : ""}, and ends shadow mode. It is
              the draft itself that is promoted, never a retyped copy — so what starts deciding is
              what the numbers above describe. Takes effect within 60 seconds.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
