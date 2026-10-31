// Injection guard Phase 2, `hold`: the taint (plans/injection-guard.md §4).
//
// A new high finding in hold mode marks the agent tainted for 30 minutes. While it is,
// reading goes on (model calls, Read, Grep) and acting waits for the owner: a /svc write
// and the sidecar's risky tools go through "Ask me first". One key per agent with a TTL,
// so a taint ends on its own; keyed on the agent, never on a declared session id, which
// the client chooses.
//
// Only a NEW block taints or extends it (taintFromFindings). "New" is decided by the
// findings table, not by this key: a re-sent block, or one the owner already cleared,
// already has its row, so the owner's Clear sticks without a list of its own.
//
// Reads THROW when Redis cannot answer or the value is not ours. Each surface then
// applies its own declared posture: a /svc write holds (closed), the sidecar goes on
// with a warning (open). There is deliberately no shared answer here.
import { INJECTION_FAMILIES, type InjectionFamily } from "@/cli/injection-scan.mjs";
import type { RecordOutcome } from "@/lib/injection-findings";
import { redis } from "./redis";

export const TAINT_TTL_S = 30 * 60;

export const taintKey = (agentId: string) => `taint:${agentId}`;

export interface Taint {
  /** When the current taint began (ms since epoch). */
  since: number;
  /** When it ends unless a new high finding extends it. */
  until: number;
  /** Every family that tainted it since `since`, in INJECTION_FAMILIES order. */
  families: InjectionFamily[];
  /** Where the latest tainting block was seen. */
  surface: "proxy" | "sidecar";
}

function parse(raw: unknown): Taint {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") throw new Error("unreadable taint");
  const t = value as Record<string, unknown>;
  if (
    typeof t.since !== "number" ||
    typeof t.until !== "number" ||
    !Array.isArray(t.families) ||
    !t.families.every((f) => INJECTION_FAMILIES.includes(f as InjectionFamily)) ||
    (t.surface !== "proxy" && t.surface !== "sidecar")
  ) {
    throw new Error("unreadable taint");
  }
  return { since: t.since, until: t.until, families: t.families as InjectionFamily[], surface: t.surface };
}

/** The agent's taint, or null. Throws when Redis cannot answer or the value is not ours. */
export async function readTaint(agentId: string, nowMs: number): Promise<Taint | null> {
  const raw = await redis().get(taintKey(agentId));
  if (raw === null || raw === undefined) return null;
  const taint = parse(raw);
  return taint.until > nowMs ? taint : null;
}

/** Taint (or extend) for TAINT_TTL_S from now. Keeps the start and adds the families. */
export async function taintAgent(
  agentId: string,
  found: { families: readonly InjectionFamily[]; surface: "proxy" | "sidecar" },
  nowMs: number
): Promise<Taint> {
  let current: Taint | null = null;
  try {
    current = await readTaint(agentId, nowMs);
  } catch {
    // A value we cannot read is overwritten by a good one.
  }
  const families = new Set<InjectionFamily>([...(current?.families ?? []), ...found.families]);
  const taint: Taint = {
    since: current?.since ?? nowMs,
    until: nowMs + TAINT_TTL_S * 1000,
    families: INJECTION_FAMILIES.filter((f) => families.has(f)),
    surface: found.surface,
  };
  await redis().set(taintKey(agentId), JSON.stringify(taint), { ex: TAINT_TTL_S });
  return taint;
}

/** The owner's Clear. True when there was a taint to clear. */
export async function clearTaint(agentId: string): Promise<boolean> {
  return Number(await redis().del(taintKey(agentId))) > 0;
}

/**
 * The step after recordInjectionFindings: in hold mode, a new high finding taints.
 * Returns the taint it set, or null. A write the table could not take still taints on
 * its findings, so a database fault does not switch the hold off; the cost is that the
 * same block, retried while the table is down, can taint again after a Clear.
 * Throws when Redis cannot be written; the caller logs it.
 */
export async function taintFromFindings(input: {
  agentId: string;
  mode: "monitor" | "hold";
  outcome: RecordOutcome;
  surface: "proxy" | "sidecar";
  now: number;
}): Promise<Taint | null> {
  if (input.mode !== "hold") return null;
  const { outcome } = input;
  const candidates =
    outcome.state === "recorded" ? outcome.recorded : outcome.state === "failed" || outcome.state === "unavailable" ? outcome.unrecorded : [];
  const high = candidates.filter((f) => f.severity === "high");
  if (high.length === 0) return null;
  return taintAgent(input.agentId, { families: high.flatMap((f) => f.families), surface: input.surface }, input.now);
}
