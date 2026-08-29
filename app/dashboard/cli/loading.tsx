// The approval page is force-dynamic and does a getUser() round trip before it
// renders, so without this the operator stares at the previous route while the
// code in their terminal is already counting down from 600 seconds.
import { DashboardShell } from "@/components/dashboard/DashboardShell";

export default function Loading() {
  return (
    <div className="pc-settings-manager" data-state="loading">
      <div className="pc-settings-form">
        <p className="muted">Loading…</p>
      </div>
    </div>
  );
}
