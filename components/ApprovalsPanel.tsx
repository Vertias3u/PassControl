"use client";
// "Ask me first": the open questions, with an answer button on each.
//
// What the owner reads here is what they approve: the method and path the
// gateway will send and the start of the body. Everything shown is agent-
// chosen text, rendered as text by React, never as markup.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, RefreshCw, X } from "lucide-react";

import { clearInjectionTaint } from "@/app/dashboard/agents/[id]/injection-actions";
import { useHydratedNow } from "@/components/dashboard/useHydratedNow";
import { HELD_TAINTED, HELD_UNKNOWN } from "@/lib/injection-hold";
import { decideApprovalAction, type DecideResult } from "@/app/dashboard/approvals/actions";

export interface PendingApprovalView {
  id: string;
  agentId: string;
  agentName: string;
  serviceLabel: string;
  method: string;
  path: string;
  preview: string;
  createdAt: number;
  onTelegram: boolean;
  /** A tool on the agent's machine (Claude Code or Codex), held by the sidecar rather than the gateway. */
  tool?: boolean;
  hold?: "tainted" | "cleared" | "unknown" | null;
}

type Outcome = { ok: boolean; text: string };

/**
 * What the page says once the owner has answered. A service call waits in the gateway
 * and goes on the agent's next try; a Claude Code tool waits in the sidecar, which runs
 * it on seeing the yes, but only while Claude Code is still waiting for it.
 */
export function approvalOutcome(result: DecideResult, tool: boolean): Outcome {
  if ("error" in result) return { ok: false, text: result.error };
  if (result.state === "approved") {
    return { ok: true, text: tool ? "Approved. If the agent is still waiting, the tool runs now, once." : "Approved. The agent's next try sends it, once." };
  }
  if (result.state === "denied") return { ok: true, text: tool ? "Denied. The tool is refused." : "Denied. The agent's retries are refused." };
  return { ok: false, text: "Already answered somewhere else, or expired." };
}

function ago(createdAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
  return minutes < 1 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

export function ApprovalsPanel({ items }: { items: PendingApprovalView[] | null }) {
  const router = useRouter();
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [clearErrors, setClearErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  // After mount only: a server sample and a browser one a second later can round to
  // different minutes, and a mismatch left Approve and Deny dead on the first click.
  const now = useHydratedNow();

  if (items === null) {
    return (
      <p className="pc-inline-notice is-danger" role="alert" data-approvals="unavailable">
        The waiting requests could not be read. Calls under an “Ask me first” rule are refused until
        they can be; try again shortly.
      </p>
    );
  }

  const answer = (id: string, decision: "approved" | "denied", tool: boolean) =>
    start(async () => {
      const outcome = approvalOutcome(await decideApprovalAction(id, decision), tool);
      setOutcomes((current) => ({ ...current, [id]: outcome }));
    });

  const clear = (item: PendingApprovalView) =>
    start(async () => {
      const result = await clearInjectionTaint(item.agentId);
      setClearErrors((current) => ({ ...current, [item.id]: result.error ?? "" }));
      if (!result.error) router.refresh();
    });

  return (
    <div className="grid gap-4" data-approvals={items.length === 0 ? "empty" : "pending"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {items.length === 0
            ? "Nothing is waiting for you."
            : `${items.length} ${items.length === 1 ? "request is" : "requests are"} waiting for you.`}
        </p>
        <button
          type="button"
          className="ghost inline-flex items-center gap-2"
          onClick={() => router.refresh()}
          data-action="refresh-approvals"
        >
          <RefreshCw aria-hidden="true" className="size-4" /> Refresh
        </button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-6 text-sm leading-6 text-muted-foreground" data-approvals-help>
          To be asked before an agent acts, open the agent, find its service access (GitHub, Discord,
          Notion, Telegram…) and tick <strong>Ask me first before each write</strong>, or tick “Ask
          me first” on one custom rule. Questions also go to your alert destination in Settings:
          on Telegram with Approve and Deny buttons.
        </div>
      ) : (
        <ul className="grid gap-3" aria-label="Requests waiting for approval">
          {items.map((item) => {
            const outcome = outcomes[item.id];
            return (
              <li
                key={item.id}
                className="pc-approval grid gap-3 rounded-xl border border-border bg-card p-4"
                data-approval={item.id}
                data-hold={item.hold ?? undefined}
                data-state={outcome ? (outcome.ok ? "answered" : "error") : "pending"}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <strong>
                    <a href={`/dashboard/agents/${encodeURIComponent(item.agentId)}`}>{item.agentName}</a>{" "}
                    <span className="font-normal text-muted-foreground">asks to call {item.serviceLabel}</span>
                  </strong>
                  <small className="text-muted-foreground">
                    {now === null ? "Waiting" : ago(item.createdAt, now)}
                    {item.onTelegram ? " · also asked on Telegram" : ""}
                  </small>
                </div>
                {item.hold ? (
                  <p className="pc-inline-notice">{item.hold === "cleared"
                    ? "Held by the injection guard when it was asked. The hold has since been cleared; this request still waits for Approve or Deny."
                    : item.hold === "tainted" ? HELD_TAINTED : HELD_UNKNOWN}</p>
                ) : null}
                {item.hold === "tainted" ? (
                  <div className="grid gap-2">
                    <button type="button" className="ghost justify-self-start" disabled={pending} onClick={() => clear(item)} data-action="clear-hold">
                      Clear the hold
                    </button>
                    <p className="text-sm text-muted-foreground">
                      Clearing ends the hold for the agent’s next actions; this request still waits for Approve or Deny.
                    </p>
                    {clearErrors[item.id] ? (
                      <p className="pc-approval__outcome pc-inline-notice is-danger" role="status">{clearErrors[item.id]}</p>
                    ) : null}
                  </div>
                ) : null}
                <code className="break-all text-sm" data-approval-request>
                  {item.method} {item.path}
                </code>
                {item.preview ? (
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs" data-approval-preview>
                    {item.preview}
                  </pre>
                ) : null}
                {outcome ? (
                  <p className={`pc-approval__outcome ${outcome.ok ? "pc-inline-notice is-success" : "pc-inline-notice is-danger"}`} role="status">
                    {outcome.text}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="inline-flex items-center gap-2"
                      disabled={pending}
                      onClick={() => answer(item.id, "approved", item.tool === true)}
                      data-action="approve"
                    >
                      <Check aria-hidden="true" className="size-4" /> Approve
                    </button>
                    <button
                      type="button"
                      className="ghost inline-flex items-center gap-2"
                      disabled={pending}
                      onClick={() => answer(item.id, "denied", item.tool === true)}
                      data-action="deny"
                    >
                      <X aria-hidden="true" className="size-4" /> Deny
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
