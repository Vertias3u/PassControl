"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  Gauge,
  KeyRound,
  RadioTower,
  ShieldCheck,
} from "lucide-react";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";
import type { CloudBetaQuotaSnapshot } from "@/lib/cloud-beta-quota";
import {
  CLOUD_FAILURE_GUIDE,
  cloudOperationsNeedsAttention,
  type CloudOperationsSignals,
  type CloudSupportBundle,
  type ConfigurationSignal,
} from "@/lib/cloud-operations";

type BundleState = "ready" | "preparing" | "downloaded" | "failed";

function signalLabel(signal: ConfigurationSignal): string {
  if (signal === "configured") return "Configured";
  if (signal === "missing") return "Not configured";
  if (signal === "available") return "Available";
  return "Unavailable";
}

function quotaCopy(quota: CloudBetaQuotaSnapshot) {
  if (quota.state === "unavailable") {
    return {
      title: "Usage counter unavailable",
      detail: "PassControl could not read the Cloud counter. This is not shown as zero usage.",
    };
  }
  if (quota.state === "disabled") {
    return {
      title: "Cloud allowance not configured",
      detail: "This deployment has no temporary Cloud beta cap enabled.",
    };
  }
  if (quota.workspace.limit === null) {
    return {
      title: "Workspace cap not configured",
      detail: "Only the shared Cloud beta capacity is enabled for this deployment.",
    };
  }
  return {
    title: `${(quota.workspace.used ?? 0).toLocaleString("en-US")} of ${quota.workspace.limit.toLocaleString("en-US")} calls`,
    detail: `${(quota.workspace.remaining ?? 0).toLocaleString("en-US")} workspace calls remain in this UTC month.`,
  };
}

function globalCapacityLabel(value: CloudBetaQuotaSnapshot["globalCapacity"]): string {
  if (value === "not-configured") return "Shared cap not configured";
  if (value === "unavailable") return "Shared capacity unavailable";
  if (value === "near-limit") return "Shared capacity near limit";
  if (value === "exhausted") return "Shared capacity exhausted";
  return "Shared capacity available";
}

export function CloudBetaOperations({
  quota,
  signals,
  supportBundle,
}: {
  quota: CloudBetaQuotaSnapshot;
  signals: CloudOperationsSignals;
  supportBundle: CloudSupportBundle;
}) {
  const [bundleState, setBundleState] = useState<BundleState>("ready");
  const copy = quotaCopy(quota);
  const percent = Math.round((quota.workspace.utilization ?? 0) * 100);
  const needsAttention = cloudOperationsNeedsAttention(quota, signals);
  const [expanded, setExpanded] = useState(needsAttention);

  useEffect(() => {
    if (needsAttention) setExpanded(true);
  }, [needsAttention]);

  const downloadBundle = () => {
    setBundleState("preparing");
    window.setTimeout(() => {
      try {
        const blob = new Blob([`${JSON.stringify(supportBundle, null, 2)}\n`], {
          type: "application/json;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `passcontrol-support-${supportBundle.generated_at.slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setBundleState("downloaded");
      } catch {
        setBundleState("failed");
      }
    }, 0);
  };

  return (
    <details
      id="operations"
      className="pc-section pc-operations scroll-mt-28"
      data-state="loaded"
      data-attention={needsAttention ? "required" : "clear"}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="pc-operations-summary">
        <span>
          <span className="pc-kicker">Cloud beta appendix</span>
          <strong>Operations and refusal reference</strong>
          <small>Capacity, deployment signals, support bundle, and exact refusal meanings.</small>
        </span>
        <span className={needsAttention ? "is-attention" : "is-ready"}>
          {needsAttention ? <AlertTriangle aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
          {needsAttention ? "Needs review" : "Ready to inspect"}
          <ChevronDown className="pc-operations-summary__chevron" aria-hidden="true" />
        </span>
      </summary>
      <div className="pc-section__body pc-operations__body">
        <div className="pc-operations__topline">
          <article className="pc-operations-quota" data-quota-state={quota.state}>
            <div className="pc-operations-card__icon"><Gauge aria-hidden="true" /></div>
            <div className="pc-operations-card__content">
              <p className="pc-kicker">Workspace allowance</p>
              <h3>{copy.title}</h3>
              <p>{copy.detail}</p>
              {quota.state === "available" && quota.workspace.limit !== null ? (
                <div className="pc-operations-meter" aria-label={`${percent}% of monthly workspace allowance used`}>
                  <span style={{ width: `${percent}%` }} />
                </div>
              ) : null}
              <dl>
                <div>
                  <dt>UTC reset</dt>
                  <dd><DashboardTimestamp value={quota.resetAt} kind="short" /></dd>
                </div>
                <div>
                  <dt>Shared beta</dt>
                  <dd data-capacity-state={quota.globalCapacity}>{globalCapacityLabel(quota.globalCapacity)}</dd>
                </div>
              </dl>
            </div>
          </article>

          <article className="pc-operations-support" data-bundle-state={bundleState}>
            <div className="pc-operations-card__icon"><ShieldCheck aria-hidden="true" /></div>
            <div className="pc-operations-card__content">
              <p className="pc-kicker">Support artifact</p>
              <h3>Redacted diagnostic bundle</h3>
              <p>Includes service signals, safe agent configuration summaries, and recent failure codes.</p>
              <p className="pc-operations-support__guard">Never includes prompts, receipts, provider keys, or raw credentials.</p>
              <button
                type="button"
                className="pc-operations-download"
                onClick={downloadBundle}
                disabled={bundleState === "preparing"}
              >
                <Download aria-hidden="true" />
                {bundleState === "preparing"
                  ? "Preparing…"
                  : bundleState === "downloaded"
                    ? "Download again"
                    : "Download redacted bundle"}
              </button>
              <span className="sr-only" aria-live="polite">
                {bundleState === "downloaded" ? "Redacted support bundle downloaded." : null}
                {bundleState === "failed" ? "Support bundle download failed." : null}
              </span>
              {bundleState === "failed" ? <p className="pc-operations-error">Download failed. Nothing was sent anywhere.</p> : null}
            </div>
          </article>
        </div>

        <div className="pc-operations-signals" aria-label="Deployment signals">
          <div className="pc-operations-subhead">
            <div>
              <p className="pc-kicker">Deployment signals</p>
              <h3>Configuration and read health</h3>
            </div>
            <span>Local state only · not active provider probes</span>
          </div>
          <ul>
            <li data-signal={signals.providerCredentials}>
              <KeyRound aria-hidden="true" /><span><strong>Provider custody</strong>{signalLabel(signals.providerCredentials)}</span>
            </li>
            <li data-signal={signals.receiptSigning}>
              <ShieldCheck aria-hidden="true" /><span><strong>Signed receipts</strong>{signalLabel(signals.receiptSigning)}</span>
            </li>
            <li data-signal={signals.observability}>
              <RadioTower aria-hidden="true" /><span><strong>Error telemetry</strong>{signalLabel(signals.observability)}</span>
            </li>
            <li data-signal={signals.agentRegistry}>
              <CheckCircle2 aria-hidden="true" /><span><strong>Agent registry read</strong>{signalLabel(signals.agentRegistry)}</span>
            </li>
            <li data-signal={signals.activityLog}>
              <Activity aria-hidden="true" /><span><strong>Activity record read</strong>{signalLabel(signals.activityLog)}</span>
            </li>
          </ul>
        </div>

        <div className="pc-operations-failures">
          <div className="pc-operations-subhead">
            <div>
              <p className="pc-kicker">Refusal guide</p>
              <h3>Same symptom, different gate</h3>
            </div>
            <span>Match the exact error code</span>
          </div>
          <div className="pc-operations-failure-grid">
            {CLOUD_FAILURE_GUIDE.map((item) => (
              <details key={item.title} data-failure-code={item.codes.join(" ")}>
                <summary>
                  <AlertTriangle aria-hidden="true" />
                  <span><strong>{item.title}</strong><code>{item.codes.join(" · ")}</code></span>
                </summary>
                <div>
                  <p>{item.meaning}</p>
                  <p><strong>Do this:</strong> {item.action}</p>
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}
