"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { revokeAgent } from "@/app/dashboard/actions-client";

export function AgentRevokeControl({ agentId, status }: { agentId: string; status: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "confirm" | "pending" | "lost" | "revoked">("idle");
  const inFlight = useRef(false);
  const revoked = status === "revoked" || phase === "revoked";
  const busy = phase === "pending";

  const confirm = async () => {
    if (inFlight.current || revoked) return;
    inFlight.current = true;
    setPhase("pending");
    try {
      await revokeAgent(agentId);
      setPhase("revoked");
    } catch {
      // A lost reply can follow an applied revoke. Never claim it was undone.
      setPhase("lost");
    } finally {
      inFlight.current = false;
      router.refresh();
    }
  };

  return (
    <div className="grid max-w-md justify-items-start gap-2" data-state={revoked ? "revoked" : phase} aria-busy={busy}>
      {revoked ? (
        <p className="m-0 text-xs text-muted-foreground" role="status">Revoked. This agent cannot be reactivated.</p>
      ) : phase === "idle" ? (
        <button type="button" className="ghost" style={{ color: "var(--danger)" }} data-action="revoke-agent" onClick={() => setPhase("confirm")}>
          Revoke agent
        </button>
      ) : (
        <>
          <p className="m-0 text-sm text-muted-foreground">
            Revoking is permanent. This agent&apos;s passport, Direct Agent Keys and delegations stop working.
            Its history and receipts stay. A revoked agent no longer counts toward your account&apos;s agent limit,
            but creating a new one still counts toward today&apos;s creation limit.
          </p>
          {phase === "lost" ? (
            <p className="m-0 text-sm text-muted-foreground" role="status">
              Could not confirm revocation. It may or may not have applied. Nothing has been undone.
              You can retry the same revoke.
            </p>
          ) : null}
          <div className="flex gap-2">
            <button type="button" className="ghost" style={{ color: "var(--danger)" }} data-action="confirm-revoke" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Revoking…" : "Revoke agent"}
            </button>
            <button type="button" className="ghost" data-action="cancel-revoke" disabled={busy} onClick={() => setPhase("idle")}>
              Keep it
            </button>
          </div>
        </>
      )}
    </div>
  );
}
