import { userClient } from "@/lib/supabase/server";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { recordAdminAction } from "@/lib/audit";
import { loadWorkspaceExport, WORKSPACE_EXPORT_SCHEMA_VERSION } from "@/lib/workspace-export";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// The workspace configuration export, for the dashboard. Sibling to
// /api/account/export and gated identically: `mfaAuthorizedUser`, the strict
// check that fails closed — never the softer step-up helper beside it in
// lib/mfa.ts, which is one keystroke away and does not. The payload holds no
// secret, but it is a complete map of a tenant's fleet: every agent, what each
// may reach, and what it may spend. A softer door to that than the one guarding
// the account export would be a door worth walking through.
export async function GET(): Promise<Response> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return Response.json(
      { error: gate.reason === "step_up_required" ? "mfa_required" : "not_authenticated" },
      { status: gate.reason === "step_up_required" ? 403 : 401 }
    );
  }

  try {
    const payload = await loadWorkspaceExport(db, gate.user.id);

    // Written before the response, and deliberately not awaited into the
    // failure path: the Recovery panel reads the newest of these back as "Last
    // export". recordAdminAction swallows its own errors, so a broken audit
    // write costs the operator a stale timestamp, never their export.
    await recordAdminAction({
      userId: gate.user.id,
      action: "workspace.export",
      targetType: "workspace",
      targetId: gate.user.id,
      metadata: {
        via: "dashboard",
        agents: payload.workspace.agents.length,
        schema_version: WORKSPACE_EXPORT_SCHEMA_VERSION,
      },
    });

    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="passcontrol-workspace-${date}.json"`,
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch {
    return Response.json({ error: "export_unavailable" }, { status: 503 });
  }
}
