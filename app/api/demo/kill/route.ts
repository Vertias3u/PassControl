// POST /api/demo/kill — arm/disarm only the tenant that owns the fixed,
// demo-scoped passport. The caller cannot provide a tenant or agent selector.
export const runtime = "edge";

import { rateLimit } from "@/lib/ratelimit";
import { serviceClient } from "@/lib/supabase";
import { armTenantKill } from "@/lib/state/killswitch";
import { clientIp, demoEnabled, demoPassportId, json } from "../_shared";

const KILL_LIMIT = 12;
const KILL_WINDOW_SECONDS = 60;
const MAX_BODY_BYTES = 512;

interface KillBody {
  armed?: unknown;
}

interface DemoAgent {
  user_id?: unknown;
  status?: unknown;
  allowed_scopes?: unknown;
}

function isDemoOnlyAgent(agent: DemoAgent): agent is DemoAgent & { user_id: string } {
  if (typeof agent.user_id !== "string" || agent.status !== "active") return false;
  if (!Array.isArray(agent.allowed_scopes) || agent.allowed_scopes.length === 0) return false;
  return agent.allowed_scopes.every((scope) => {
    if (!scope || typeof scope !== "object") return false;
    return (scope as { provider?: unknown }).provider === "demo";
  });
}

async function parseBody(request: Request): Promise<KillBody | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return null;
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(raw) as KillBody;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!demoEnabled()) return json({ error: "not_found" }, 404);

  const limited = await rateLimit(
    `demo-kill:${clientIp(request)}`,
    KILL_LIMIT,
    KILL_WINDOW_SECONDS
  );
  if (!limited.success) {
    return json(
      { error: "rate_limited" },
      429,
      { "retry-after": String(KILL_WINDOW_SECONDS) }
    );
  }

  const body = await parseBody(request);
  if (!body || typeof body.armed !== "boolean") {
    return json({ error: "invalid_request" }, 400);
  }

  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("agents")
      .select("user_id, status, allowed_scopes")
      .eq("passport_pubkey", demoPassportId())
      .maybeSingle();
    const agent = data as DemoAgent | null;

    // The fixed passport must still be active and demo-only. If it is missing,
    // broadened to a real provider, or moved away from an optionally pinned
    // tenant, the public switch refuses to mutate any kill state.
    if (error || !agent || !isDemoOnlyAgent(agent)) {
      return json({ error: "demo_unavailable" }, 503);
    }
    const pinnedTenant = process.env.PASSCONTROL_DEMO_TENANT_ID?.trim();
    if (pinnedTenant && agent.user_id !== pinnedTenant) {
      return json({ error: "demo_unavailable" }, 503);
    }

    await armTenantKill(agent.user_id, body.armed);
    return json({ ok: true, armed: body.armed });
  } catch {
    return json({ error: "demo_unavailable" }, 503);
  }
}
