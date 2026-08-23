// GET /api/control/v1/workspace/export — the workspace configuration export
// (read scope). Tenant-scoped. Same document the dashboard hands back at
// /api/workspace/export; this is the surface `passcontrol export` talks to, so
// an operator can put a recovery snapshot in a cron job.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { recordAdminAction } from "@/lib/audit";
import { loadWorkspaceExport, WORKSPACE_EXPORT_SCHEMA_VERSION } from "@/lib/workspace-export";

const handler = control("read", async ({ userId, db, requestId }) => {
  let payload;
  try {
    // `db` here is the service client, which bypasses RLS — so the builder's own
    // `.eq("user_id", userId)` on every read is not a second belt over RLS's
    // braces, it is the only tenant boundary on this path.
    payload = await loadWorkspaceExport(db, userId);
  } catch {
    return errorResponse(503, "export_unavailable", requestId);
  }

  // The dashboard route writes this row too. Both must, or the Recovery panel's
  // "Last export" would read "never" for an operator who exports on a schedule
  // through the CLI and never touches the page.
  await recordAdminAction({
    userId,
    action: "workspace.export",
    targetType: "workspace",
    targetId: userId,
    metadata: {
      via: "api",
      agents: payload.workspace.agents.length,
      schema_version: WORKSPACE_EXPORT_SCHEMA_VERSION,
    },
  });

  return jsonResponse({ data: payload }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
