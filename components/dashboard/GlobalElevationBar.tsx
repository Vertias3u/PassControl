"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";

export interface ActiveElevation {
  id: string;
  agentId: string;
  agentName: string;
  expiresAt: string;
}

function remaining(until: string, now: number): string {
  const ms = Date.parse(until) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "closing now";
  const seconds = Math.ceil(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const tail = seconds % 60;
  return `${hours ? `${hours}h ` : ""}${minutes ? `${minutes}m ` : ""}${tail}s`;
}

export function GlobalElevationBar({
  elevations,
  unavailable = false,
  initialNow,
}: {
  elevations: ActiveElevation[];
  unavailable?: boolean;
  initialNow: number;
}) {
  const [now, setNow] = useState(initialNow);
  const hasFutureGrant = elevations.some((grant) => Date.parse(grant.expiresAt) > now);
  useEffect(() => {
    if (!hasFutureGrant) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasFutureGrant]);

  const active = useMemo(
    () => elevations.filter((grant) => Date.parse(grant.expiresAt) > now),
    [elevations, now]
  );

  if (unavailable) {
    return (
      <div className="pc-elevation-bar" data-state="unavailable" role="status">
        <AlertTriangle aria-hidden="true" />
        <strong>Temporary-elevation state is unavailable.</strong>
        <span>Confirm break-glass state on the affected agent before relying on normal scope.</span>
      </div>
    );
  }
  if (!active.length) return null;

  return (
    <aside className="pc-elevation-bar" data-state="elevated" aria-label="Live break-glass grants">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>{active.length === 1 ? "Break glass is open" : `${active.length} break-glass grants are open`}</strong>
        <ul>
          {active.map((grant) => (
            <li key={grant.id}>
              <Link href={`/dashboard/agents/${grant.agentId}#agent-emergency`}>
                {grant.agentName} <ArrowUpRight aria-hidden="true" />
              </Link>
              <span className="pc-elevation-bar__countdown">{remaining(grant.expiresAt, now)}</span>
              <span>until <DashboardTimestamp value={grant.expiresAt} kind="short" /></span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
