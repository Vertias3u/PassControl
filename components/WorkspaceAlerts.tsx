"use client";
// Settings → Alerts: send this workspace's own alerts to Slack, Discord or
// Telegram (plans/workspace-alerts.md). The webhook URL and the Telegram bot
// token are write-only from here: they go to Vault and never come back; the
// page only ever holds the hint.
import { useState, useTransition } from "react";

import {
  removeAlertDestination,
  saveAlertSettings,
  sendTestAlert,
  type AlertActionState,
} from "@/app/dashboard/settings/alert-actions";

type Kind = "refused" | "budget" | "security";

const KINDS: { value: Kind; label: string; detail: string }[] = [
  {
    value: "refused",
    label: "Refused calls",
    detail: "An agent asked for a model or endpoint it is not allowed to use, or its policy refused the call.",
  },
  {
    value: "budget",
    label: "Out of budget",
    detail: "An agent ran out of budget, or reached its budget for the period.",
  },
  {
    value: "security",
    label: "Security changes",
    detail: "An agent's passport was rotated, or a break-glass grant was opened for it.",
  },
];

const LABEL: Record<string, string> = { slack: "Slack", discord: "Discord", telegram: "Telegram" };

type Service = "webhook" | "telegram";
const SERVICES: { value: Service; label: string }[] = [
  { value: "webhook", label: "Slack or Discord" },
  { value: "telegram", label: "Telegram" },
];

export interface WorkspaceAlertsDestination {
  kind: string;
  hint: string;
  events: string[];
}

export function WorkspaceAlerts({
  state,
  destination,
}: {
  state: "ready" | "unmigrated" | "unavailable";
  destination: WorkspaceAlertsDestination | null;
}) {
  const [result, setResult] = useState<AlertActionState | null>(null);
  const [service, setService] = useState<Service>(destination?.kind === "telegram" ? "telegram" : "webhook");
  const [pending, start] = useTransition();
  const enabled = new Set(destination ? destination.events : KINDS.map((kind) => kind.value));

  const run = (action: () => Promise<AlertActionState>) =>
    start(async () => {
      setResult(await action());
    });

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
      data-panel="workspace-alerts"
      data-state={state}
      data-destination={destination?.kind ?? "none"}
    >
      <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Slack, Discord or Telegram
      </p>
      <h2 className="mt-2 mb-0 text-lg font-bold">Alerts for your agents</h2>
      <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
        A message in your channel when something needs you, so you do not have to keep this
        dashboard open. Each kind is sent at most once per agent every 10 minutes. Calls refused
        because you suspended an agent or used the kill switch never alert: you already know.
      </p>

      {state !== "ready" ? (
        <p className="mt-4 mb-0 text-sm leading-6" style={{ color: "var(--warning)" }}>
          {state === "unmigrated"
            ? "This instance has not applied migration 0078, so alerts cannot be saved yet. Everything else on this page is unaffected."
            : "Your alert settings could not be read just now. Nothing has changed. Try again in a moment."}
        </p>
      ) : (
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const events = KINDS.filter((kind) => form.get(kind.value) === "on").map((kind) => kind.value);
            run(() =>
              saveAlertSettings({
                url: service === "webhook" ? String(form.get("url") ?? "") : "",
                telegramToken: service === "telegram" ? String(form.get("telegramToken") ?? "") : "",
                telegramChatId: service === "telegram" ? String(form.get("telegramChatId") ?? "") : "",
                events,
              })
            );
          }}
        >
          {destination ? (
            <p className="m-0 text-sm" data-alert-destination={destination.kind}>
              Sending to <strong>{LABEL[destination.kind] ?? destination.kind}</strong>{" "}
              <code>{destination.hint}</code>
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Where to send alerts">
            {SERVICES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={service === option.value}
                data-service-choice={option.value}
                className={service === option.value ? undefined : "ghost"}
                disabled={pending}
                onClick={() => setService(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {service === "webhook" ? (
            <label className="grid gap-2">
              <span className="text-sm font-semibold">
                {destination ? "Replace the webhook URL (leave blank to keep the current one)" : "Webhook URL"}
              </span>
              <input
                name="url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                required={!destination}
                placeholder="https://hooks.slack.com/services/… or https://discord.com/api/webhooks/…"
                className="rounded-lg border border-border bg-background p-2 font-mono text-xs"
                disabled={pending}
              />
              <span className="text-xs leading-5 text-muted-foreground">
                In Slack, add an Incoming Webhook to a channel. In Discord, open the channel&rsquo;s
                settings, then Integrations, then Webhooks. The URL is stored in the Vault and never
                shown again.
              </span>
            </label>
          ) : (
            <div className="grid gap-3">
              <label className="grid gap-2">
                <span className="text-sm font-semibold">
                  {destination?.kind === "telegram" ? "Bot token (leave both blank to keep the current ones)" : "Bot token"}
                </span>
                <input
                  name="telegramToken"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required={destination?.kind !== "telegram"}
                  placeholder="123456789:AA…"
                  className="rounded-lg border border-border bg-background p-2 font-mono text-xs"
                  disabled={pending}
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-semibold">Chat ID</span>
                <input
                  name="telegramChatId"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  required={destination?.kind !== "telegram"}
                  placeholder="-1001234567890 or @yourchannel"
                  className="rounded-lg border border-border bg-background p-2 font-mono text-xs"
                  disabled={pending}
                />
              </label>
              <span className="text-xs leading-5 text-muted-foreground">
                Create a bot with @BotFather and add it to the group or channel (as an admin, for a
                channel). The chat ID of a group or channel starts with -100; a public channel can use
                its @name. The token is stored in the Vault and never shown again. Use a bot made for
                alerts, not one your agents use.
              </span>
            </div>
          )}

          <fieldset className="m-0 grid gap-3 border-0 p-0">
            <legend className="mb-2 p-0 text-sm font-semibold">Send me</legend>
            {KINDS.map((kind) => (
              <label key={kind.value} className="flex items-start gap-3 text-sm">
                <input type="checkbox" name={kind.value} defaultChecked={enabled.has(kind.value)} disabled={pending} />
                <span className="grid gap-0.5">
                  <span className="font-semibold">{kind.label}</span>
                  <span className="text-xs leading-5 text-muted-foreground">{kind.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending}>
              {pending ? "Working…" : "Save"}
            </button>
            {destination ? (
              <>
                <button type="button" className="ghost" disabled={pending} onClick={() => run(sendTestAlert)}>
                  Send test alert
                </button>
                <button type="button" className="ghost" disabled={pending} onClick={() => run(removeAlertDestination)}>
                  Remove
                </button>
              </>
            ) : null}
          </div>

          {result ? (
            <p
              className="m-0 text-sm"
              role="status"
              data-result={result.error ? "error" : "ok"}
              style={result.error ? { color: "var(--warning)" } : undefined}
            >
              {result.error ?? result.message}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
