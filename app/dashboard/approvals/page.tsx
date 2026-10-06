import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { ApprovalsPanel, type PendingApprovalView } from "@/components/ApprovalsPanel";
import { pollTelegramDecisions } from "@/lib/alerts/approvals";
import { needsMfaStepUp } from "@/lib/mfa";
import { SERVICE_CATALOG, isServiceId } from "@/lib/services/catalog";
import { listPendingApprovals } from "@/lib/state/approvals";
import { userClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approvals" };

// "Ask me first": the service calls waiting for this workspace's owner.
//
// The questions live in Redis, minutes at a time (lib/state/approvals.ts), so
// this page reads them there, scoped by the signed-in user's id. Agent names
// come through userClient(), so RLS scopes those. Before reading, it collects
// any Telegram taps nobody has polled for yet, so an answer given on the phone
// while no call was waiting shows here as answered rather than still open.
export default async function ApprovalsPage() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  await pollTelegramDecisions(user.id, 0).catch(() => null);

  let items: PendingApprovalView[] | null = null;
  try {
    const pending = await listPendingApprovals(user.id);
    const ids = [...new Set(pending.map((p) => p.agentId))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { data } = await db.from("agents").select("id, name").in("id", ids);
      for (const row of (data ?? []) as { id: string; name: string }[]) names.set(row.id, row.name);
    }
    items = pending.map((p) => ({
      id: p.id,
      agentId: p.agentId,
      agentName: names.get(p.agentId) ?? "An agent",
      serviceLabel: isServiceId(p.service) ? SERVICE_CATALOG[p.service].label : p.service,
      method: p.method,
      path: p.path,
      preview: p.preview,
      createdAt: p.createdAt,
      onTelegram: p.telegram !== null,
    }));
  } catch {
    items = null;
  }

  return (
    <DashboardShell
      userId={user.id}
      active="approvals"
      eyebrow="Ask me first"
      title="Approvals"
      description="Service calls your agents made under a rule set to “Ask me first”. Each one is held until you answer. Approving sends that exact request once; denying refuses it every time the agent retries."
    >
      <ApprovalsPanel items={items} />
    </DashboardShell>
  );
}
