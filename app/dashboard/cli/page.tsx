// Approve a device — the browser half of `passcontrol login`.
//
// The operator arrives here with an 8-character code their terminal produced,
// pastes it, and approves once. What they approve is a WRITE-SCOPED
// control-plane key on their own tenant, so the screen says exactly that rather
// than "allow access".
//
// The code is NEVER read from the URL. Not from a query, not from a fragment.
// The human carrying it across from the terminal is the only evidence that the
// person at this browser is the person at that terminal, and a pre-filled link
// removes precisely that: an attacker starts a login on their own machine,
// keeps the device_code, sends this page's link to a signed-in victim, and one
// click hands them a key that can create agents, rotate passports, move budgets
// and arm the kill switch on the victim's workspace.
//
// tests/cli-login-shape.test.ts fails the build if this component ever learns to
// read location.hash, location.search or searchParams.
import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { needsMfaStepUp } from "@/lib/mfa";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { CliDeviceApproval } from "@/components/CliDeviceApproval";

export const dynamic = "force-dynamic";

export const metadata = { title: "Approve a device" };

export default async function CliApprovalPage() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  // Navigation-level step-up, same as Settings. This is a hint, not the
  // authorization: the Server Action re-checks with the strict helper, because
  // needsMfaStepUp reads unsigned cookie state and fails open.
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  return (
    <DashboardShell
      userId={user.id}
      active="settings"
      title="Approve a device"
      description="Enter the code shown by passcontrol login in your terminal."
    >
      <CliDeviceApproval />
    </DashboardShell>
  );
}
