export const runtime = "edge";

import { timingSafeEqual } from "@/lib/crypto/constantTime";
import { serviceClient } from "@/lib/supabase";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "");
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  const { data, error } = await serviceClient().rpc("purge_beta_launch_data");
  if (error) return Response.json({ ok: false, error: "retention_unavailable" }, { status: 503 });
  return Response.json({ ok: true, purged: data });
}
