"use client";
// One agent's access to a non-LLM API (any-API: GitHub, Telegram).
//
// Deny by default: an agent with no rules here cannot make a single call to the
// service through PassControl, whatever the workspace's token can do.
//
// Simple mode is a repository and plain-language choices; each choice writes
// rules (lib/services/presets.ts). Advanced is the rule list itself: one method
// and path per rule (`*` one path segment, `**` the rest of the path on a GET
// rule only), or one method name for a call-shaped service. Whatever a saved
// list holds that no choice wrote appears under Advanced, so it survives a save.
// Saving goes through setAgentServiceRules, which validates with the gateway's
// own parser, so this form can never write rules the gateway would refuse.
import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { setAgentServiceRules } from "@/app/dashboard/service-actions";
import { SERVICE_CATALOG, isServiceId } from "@/lib/services/catalog";
import {
  composeServiceRules,
  parseRepoInput,
  presetsFor,
  presetsNeedRepo,
  splitServiceRules,
} from "@/lib/services/presets";
import { DEFAULT_SERVICE_HOURLY_CAP, SERVICE_RULE_METHODS } from "@/lib/services/rules";

type Message = { ok: boolean; text: string } | null;
type Rule = { method: string; path: string };

export function AgentServiceAccess({
  agentId,
  service,
  serviceLabel,
  initialAllow,
  initialCap,
  state,
  tokenStored,
  ruleShape = "http",
}: {
  /** `call`: rules name one API method (Telegram); `http`: a method and a path (GitHub). */
  ruleShape?: "http" | "call";
  agentId: string;
  service: string;
  serviceLabel: string;
  initialAllow: Rule[];
  initialCap: number | null;
  state: "ok" | "malformed" | "unavailable";
  tokenStored: boolean | null;
}) {
  const [initial] = useState(() => splitServiceRules(service, initialAllow));
  const presets = presetsFor(service);
  const needsRepo = presetsNeedRepo(service);
  const [repoText, setRepoText] = useState(initial.repo ?? "");
  const [checked, setChecked] = useState<string[]>(initial.checked);
  const [rules, setRules] = useState<Rule[]>(initial.extra.map((rule) => ({ method: rule.method, path: rule.path })));
  const [advancedOpen, setAdvancedOpen] = useState(initial.extra.length > 0);
  const edit = (index: number, change: Partial<Rule>) =>
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...change } : rule)));
  const toggle = (id: string, on: boolean) =>
    setChecked((current) => (on ? [...current.filter((c) => c !== id), id] : current.filter((c) => c !== id)));
  const [cap, setCap] = useState(initialCap === null ? "" : String(initialCap));
  const [msg, setMsg] = useState<Message>(null);
  const [pending, start] = useTransition();
  // Set after mount: reading window during render makes the server's HTML and
  // the first client render disagree.
  const [base, setBase] = useState("");
  useEffect(() => setBase(window.location.origin), []);

  if (state === "unavailable") {
    return (
      <p className="pc-inline-notice is-danger" role="alert" data-service-access="unavailable">
        This agent&apos;s {serviceLabel} access could not be read. If this deployment has not applied
        migration 0074, apply it; until then every {serviceLabel} call is refused.
      </p>
    );
  }

  const repo = needsRepo ? parseRepoInput(repoText) : null;
  const composed = composeServiceRules(service, { repo, checked, extra: rules });
  const never = isServiceId(service) ? SERVICE_CATALOG[service].neverSummary : null;

  const save = () =>
    start(async () => {
      setMsg(null);
      if (needsRepo && checked.length > 0 && repo === null) {
        setMsg({
          ok: false,
          text: `Enter the repository as owner/name, or paste its github.com link: the choices above apply to one repository.`,
        });
        return;
      }
      const trimmedCap = cap.trim();
      const result = await setAgentServiceRules(agentId, service, {
        allow: composed,
        maxRequestsPerHour: trimmedCap === "" ? null : Number(trimmedCap),
      });
      setMsg(result.error ? { ok: false, text: result.error } : { ok: true, text: result.notice ?? "Saved." });
    });

  return (
    <div className="pc-settings-manager" data-service-access={state} data-service={service}>
      {state === "malformed" ? (
        <p className="pc-inline-notice is-danger" role="alert">
          The stored {serviceLabel} rules for this agent are not valid, so every {serviceLabel} call is
          refused. Saving below replaces them.
        </p>
      ) : null}
      {tokenStored === false ? (
        <p className="pc-inline-notice" role="status" data-service-token="missing">
          No {serviceLabel} token is stored for this workspace yet. Add one in{" "}
          <a href="/dashboard/settings#services">Settings, under Services</a>; until then this agent
          can reach nothing on {serviceLabel}.
        </p>
      ) : null}

      {needsRepo ? (
        <label className="pc-field">
          <span>Repository</span>
          <input
            value={repoText}
            placeholder="owner/repo, or paste its github.com link"
            onChange={(e) => setRepoText(e.target.value)}
            onBlur={() => {
              const parsed = parseRepoInput(repoText);
              if (parsed) setRepoText(parsed);
            }}
            autoComplete="off"
            spellCheck={false}
            data-field="repo"
          />
          <small>
            The choices below apply to this one repository. It is matched exactly as your agent's code writes it, capital letters included.
          </small>
        </label>
      ) : null}

      <fieldset className="grid gap-2" data-service-presets>
        <legend className="mb-1 text-sm font-semibold">This agent can</legend>
        {presets.map((preset) => (
          <label key={preset.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="pc-check mt-0.5 size-4 shrink-0 accent-primary"
              checked={checked.includes(preset.id)}
              onChange={(e) => toggle(preset.id, e.target.checked)}
              disabled={pending}
              data-preset={preset.id}
            />
            <span>
              {preset.label}
              {preset.hint ? <small className="block text-muted-foreground">{preset.hint}</small> : null}
            </span>
          </label>
        ))}
      </fieldset>

      {needsRepo && checked.length > 0 && repo === null ? (
        <p className="pc-inline-notice" role="status" data-service-summary="needs-repo">
          {repoText.trim() === ""
            ? "Name the repository these choices are for."
            : "That is not a repository: use owner/name, or paste its github.com link."}
        </p>
      ) : composed.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-service-summary="none">
          No {serviceLabel} access: every {serviceLabel} call from this agent is refused. Tick what it may do.
        </p>
      ) : null}

      {never ? (
        <p className="text-xs text-muted-foreground" data-service-never>
          {never}
        </p>
      ) : null}

      <details
        className="grid gap-3"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        data-service-advanced={advancedOpen ? "open" : "closed"}
      >
        <summary className="cursor-pointer text-sm font-semibold">
          Advanced: custom rules{rules.length > 0 ? ` (${rules.length})` : ""}
        </summary>

        <ul className="pc-credential-list mt-3" aria-label={`${serviceLabel} custom rules`}>
          {rules.length === 0 ? (
            <li className="pc-credential-list__empty" data-service-rules="none">
              No custom rules. The choices above are usually enough; add a rule here for anything else.
            </li>
          ) : (
            rules.map((rule, index) => (
              <li key={index} className="pc-credential" data-service-rule={index} data-rule-method={rule.method}>
                {ruleShape === "call" ? (
                  <label className="pc-field">
                    <span>{serviceLabel} method</span>
                    <input
                      value={rule.path}
                      placeholder="sendPhoto"
                      onChange={(e) => edit(index, { path: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                      data-field="rule-path"
                    />
                  </label>
                ) : (
                  <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
                    <label className="pc-field">
                      <span>Method</span>
                      <select
                        value={rule.method}
                        onChange={(e) => edit(index, { method: e.target.value })}
                        data-field="rule-method"
                      >
                        {SERVICE_RULE_METHODS.map((method) => (
                          <option key={method} value={method}>
                            {method}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="pc-field">
                      <span>Path</span>
                      <input
                        value={rule.path}
                        placeholder={rule.method === "GET" ? "/repos/acme/*/issues" : "/repos/acme/web/issues"}
                        onChange={(e) => edit(index, { path: e.target.value })}
                        autoComplete="off"
                        spellCheck={false}
                        data-field="rule-path"
                      />
                    </label>
                  </div>
                )}
                <div className="pc-credential__actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={pending}
                    onClick={() => setRules((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 aria-hidden="true" /> Remove
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>

        <button
          type="button"
          className="ghost justify-self-start"
          disabled={pending}
          onClick={() => setRules((current) => [...current, { method: ruleShape === "call" ? "CALL" : "GET", path: "" }])}
          data-action="add-service-rule"
        >
          <Plus aria-hidden="true" /> Add a rule
        </button>

        {ruleShape === "call" ? (
          <p className="text-xs text-muted-foreground">
            Each rule is one {serviceLabel} Bot API method name, such as <code>sendPhoto</code> or{" "}
            <code>getChat</code>, matched in any case, over GET or POST. File downloads and uploads are not
            supported (send a file by URL or <code>file_id</code>). A rule for <code>sendMessage</code> reaches any
            chat the bot is in: the chat is chosen in the request, not the rule. Agents sharing one bot share its{" "}
            <code>getUpdates</code> queue. Point the agent at <code>{base}/api/v1/svc/{service}/&lt;method&gt;</code>{" "}
            with its PassControl credential (as <code>Authorization: Bearer</code> or <code>x-api-key</code>); the
            bot token is added by the gateway.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            A path starts with <code>/</code> (one is added if you leave it out). <code>HEAD</code> follows{" "}
            <code>GET</code>. <code>*</code> matches one path segment; <code>**</code> matches one or more
            segments at the end and is for <code>GET</code> rules only, so a write rule names its path exactly,
            and <code>/repos/acme/web/**</code> does not cover <code>/repos/acme/web</code> itself. Point the
            agent&apos;s {serviceLabel} client at <code>{base}/api/v1/svc/{service}</code>, giving it the
            agent&apos;s PassControl credential in place of a {serviceLabel} token (as{" "}
            <code>Authorization: Bearer</code>, <code>x-api-key</code> or <code>Authorization: token</code>), or
            use <code>passcontrol env {service}</code> through the sidecar.
          </p>
        )}
      </details>

      <label className="pc-field">
        <span>Calls per hour</span>
        <input
          inputMode="numeric"
          value={cap}
          placeholder={String(DEFAULT_SERVICE_HOURLY_CAP)}
          onChange={(e) => setCap(e.target.value)}
        />
        <small>
          Empty uses {DEFAULT_SERVICE_HOURLY_CAP}. Separate from the agent&apos;s dollar limit: a{" "}
          {serviceLabel} call has no price, so its limit is a call count.
        </small>
      </label>

      <div className="pc-settings-form__actions">
        <button type="button" disabled={pending} onClick={save} data-action="save-service-rules">
          {pending ? "Saving…" : `Save ${serviceLabel} access`}
        </button>
      </div>

      {msg ? (
        <p
          className={msg.ok ? "pc-inline-notice is-success" : "pc-inline-notice is-danger"}
          role={msg.ok ? "status" : "alert"}
        >
          {msg.ok ? <CheckCircle2 aria-hidden="true" /> : null}
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
