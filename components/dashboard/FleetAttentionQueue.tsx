"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCircle2 } from "lucide-react";
import type { FleetAttentionItem } from "@/lib/dashboard-attention";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";

export function FleetAttentionQueue({ items }: { items: FleetAttentionItem[] }) {
  return (
    <section className="pc-attention-queue" aria-labelledby="fleet-attention-heading" data-state={items.length ? "attention" : "clear"}>
      <div className="pc-attention-queue__heading">
        <div>
          <p className="pc-kicker">Operator queue</p>
          <h3 id="fleet-attention-heading">What needs attention</h3>
        </div>
        <span>{items.length ? `${items.length} ranked` : "All clear"}</span>
      </div>
      {items.length === 0 ? (
        <div className="pc-attention-empty" data-state="empty">
          <CheckCircle2 aria-hidden="true" />
          <div><strong>Nothing needs attention.</strong><span>No loaded agent crosses an operational threshold.</span></div>
        </div>
      ) : (
        <ol className="pc-attention-list">
          {items.map((item, index) => (
            <li key={item.agentId} data-tone={item.reasons.some((reason) => reason.tone === "danger") ? "danger" : "warning"}>
              <span className="pc-attention-rank">{String(index + 1).padStart(2, "0")}</span>
              <div className="pc-attention-main">
                <div className="pc-attention-agent">
                  <Link href={`/dashboard/agents/${item.agentId}`}>{item.agentName}</Link>
                  <span>{Math.round(item.budgetRatio * 100)}% tighter budget used</span>
                </div>
                <div className="pc-attention-reasons">
                  {item.reasons.map((reason) => (
                    <span key={reason.kind} data-tone={reason.tone} title={reason.detail}>
                      {reason.tone === "danger" ? <AlertTriangle aria-hidden="true" /> : null}
                      {reason.label}
                    </span>
                  ))}
                </div>
                <dl>
                  <div>
                    <dt>Projected budget exhaustion</dt>
                    <dd>{item.projectedExhaustionAt ? <DashboardTimestamp value={item.projectedExhaustionAt} kind="short" /> : "No date from recent burn"}</dd>
                  </div>
                  <div>
                    <dt>Last recorded call</dt>
                    <dd>{item.lastSeenAt ? <DashboardTimestamp value={item.lastSeenAt} kind="short" /> : "Outside the 30-day scan"}</dd>
                  </div>
                </dl>
              </div>
              <Link className="pc-attention-open" href={`/dashboard/agents/${item.agentId}`} aria-label={`Open ${item.agentName}`}>
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
