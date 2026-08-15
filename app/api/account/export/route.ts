import { userClient } from "@/lib/supabase/server";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { loadAccountExport } from "@/lib/account-lifecycle";
import { serviceClient } from "@/lib/supabase";

export const runtime = "edge";
export const dynamic = "force-dynamic";

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
    const payload = await loadAccountExport(db, gate.user, serviceClient());
    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="passcontrol-account-${date}.json"`,
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch {
    return Response.json({ error: "export_unavailable" }, { status: 503 });
  }
}
