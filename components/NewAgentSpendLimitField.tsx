"use client";

// The daily spending limit a new agent starts with (F1), as one field shared by
// the passport form, the Direct Agent Key form and the key-import on-ramp, so the
// three can never word or send it differently.
//
// The limit is filled in. Removing it takes the checkbox, whose wording follows
// Simon Willison's case for hard caps by default; clearing the field is not a
// removal (lib/new-agent-spend-limit.ts `spendLimitChoiceFromForm`).
import { useState } from "react";

import {
  REMOVE_SPENDING_LIMIT_STATEMENT,
  formatLimitUsd,
  scopesNeedDollarLimit,
  spendLimitChoiceFromForm,
} from "@/lib/new-agent-spend-limit";

type Scope = { provider: string };

function usdText(cents: number | null): string {
  if (cents === null) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** Form state for the field, initialised from the deployment's default. */
export function useNewAgentSpendLimit(defaultCents: number | null) {
  const [usd, setUsd] = useState(() => usdText(defaultCents));
  const [removed, setRemoved] = useState(false);
  return {
    usd,
    setUsd,
    removed,
    setRemoved,
    reset() {
      setUsd(usdText(defaultCents));
      setRemoved(false);
    },
    /** What to send with the create call. Throws a message to show on a bad amount. */
    choice(scopes: readonly Scope[]) {
      // An agent the gateway cannot price gets no limit; the server decides that
      // too, so sending nothing here only keeps a hidden field out of the call.
      if (!scopesNeedDollarLimit(scopes)) return {};
      return spendLimitChoiceFromForm({ usd, removed }, defaultCents);
    },
  };
}

export function NewAgentSpendLimitField({
  state,
  defaultCents,
  scopes,
}: {
  state: ReturnType<typeof useNewAgentSpendLimit>;
  defaultCents: number | null;
  scopes: readonly Scope[];
}) {
  // No model at all (services only): nothing to limit, nothing to say.
  if (scopes.length === 0) return null;
  if (!scopesNeedDollarLimit(scopes)) {
    const names = [...new Set(scopes.map((scope) => scope.provider))].join(" and ");
    return (
      <p className="m-0 text-xs leading-5 text-muted-foreground" data-new-agent-limit="exempt">
        No daily spending limit: {names} calls have no price, so a dollar limit would refuse every one of them.
      </p>
    );
  }

  const hasDefault = defaultCents !== null;
  return (
    <div className="grid gap-2" data-new-agent-limit={state.removed ? "removed" : "set"}>
      <label className="grid gap-1.5 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Daily spending limit (USD)</span>
        <input
          value={state.usd}
          onChange={(event) => state.setUsd(event.target.value)}
          inputMode="decimal"
          disabled={state.removed}
          placeholder={hasDefault ? undefined : "No limit"}
          data-new-agent-limit-amount
        />
        <span className="text-xs leading-5 text-muted-foreground">
          {hasDefault
            ? `New agents start with ${formatLimitUsd(defaultCents)} a day. Past it, calls are refused until midnight UTC. You can change it on the agent's page.`
            : "Blank means no daily limit."}
        </span>
      </label>
      {hasDefault ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 w-auto"
            checked={state.removed}
            onChange={(event) => state.setRemoved(event.target.checked)}
            data-new-agent-limit-remove
          />
          <span>
            {REMOVE_SPENDING_LIMIT_STATEMENT}
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Wording after Simon Willison&apos;s case for hard spending caps by default.
            </span>
          </span>
        </label>
      ) : null}
    </div>
  );
}
