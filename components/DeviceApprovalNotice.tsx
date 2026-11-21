// What the approval screen says about the key it is about to mint. The kind comes from
// the server's record of the request (`oneCommand`), never from the device name, which
// the requester chose: an agent that runs the device flow itself can name its own
// machine login anything, including "one command - kill off - <host>" (review
// 2026-11-21, finding 5). tests/device-approval-kind.test.tsx pins the wording.
import { ShieldAlert } from "lucide-react";

export function DeviceApprovalNotice({ oneCommand, oneCommandMinutes }: { oneCommand: boolean; oneCommandMinutes?: number }) {
  if (oneCommand) {
    return (
      <div className="pc-secret-warning" data-kind="one-command">
        <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden />
        <div>
          <strong>One command. Check this code matches your terminal.</strong> Approving gives that
          one command a write-scoped control-plane key. It expires after {oneCommandMinutes ?? 15} minutes
          whatever happens, and the CLI revokes it as soon as the command ends. If you did not just
          run a <span className="mono">passcontrol</span> command that asked for approval, refuse this.
        </div>
      </div>
    );
  }
  return (
    <div className="pc-secret-warning" data-kind="machine-login">
      <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden />
      <div>
        <strong>Machine login. Check this code matches your terminal.</strong> Approving mints a
        write-scoped control-plane key: it can create and revoke agents, rotate passports, change
        budgets and scopes, and arm the kill switch. It is valid until you revoke it. This is not a
        one-command approval, whatever the device name says. If you did not just run{" "}
        <span className="mono">passcontrol login</span>, refuse this.
      </div>
    </div>
  );
}
