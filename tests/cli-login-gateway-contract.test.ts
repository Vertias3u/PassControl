import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

// Keep the real HTTP handler, body reader, fleet mutation and validators.
// Replace authentication and infrastructure only; no hosted credentials or calls.
// A real insert stand-in, not a thrower. The first version of this test asserted
// the database was NEVER reached, which was a property of the BREAK — validation
// refused the demo scope before any write could happen. With the scope accepted,
// reaching the insert is the correct behaviour, so the stand-in records the row.
const inserted = vi.hoisted(() => [] as Record<string, unknown>[]);
const dbFrom = vi.hoisted(() => vi.fn((table: string) => {
  if (table !== "agents") throw new Error(`unexpected table ${table}`);
  return {
    insert: (row: Record<string, unknown>) => {
      inserted.push(row);
      return {
        select: () => ({
          single: async () => ({
            data: { id: "agent-contract", created_at: "2026-09-06T00:00:00.000Z" },
            error: null,
          }),
        }),
      };
    },
  };
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: async () => ({
  ok: true, userId: "test-tenant", keyId: "test-key", scope: "write",
}) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true }) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ from: dbFrom }) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: vi.fn() }));
vi.mock("@/lib/observability", () => ({ captureError: vi.fn(), captureSecurityEvent: vi.fn() }));
import { POST } from "@/app/api/control/v1/agents/route";

it("the actual login create request is accepted by the gateway before config is written", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-login-contract-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let routeStatus: number | undefined;
  let routeBody: unknown;
  let loginError: unknown;
  let requestBody: any;
  const origin = "http://127.0.0.1:12345";
  const json = (body: unknown) => Response.json(body);
  const fetchImpl = async (url: string, init: RequestInit) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/auth/device/start") return json({
      device_code: "d".repeat(43), user_code: "FKDR8T2W",
      verification_uri: `${origin}/dashboard/cli`, expires_in: 600, interval: 1,
    });
    if (pathname === "/api/auth/device/token") return json({ api_key: `pc_${"k".repeat(43)}` });
    if (pathname === "/api/control/v1/agents" && init.method === "GET") return json({ data: [] });
    if (pathname === "/api/control/v1/agents" && init.method === "POST") {
      requestBody = JSON.parse(String(init.body));
      const response = await POST(new Request(url, init));
      routeStatus = response.status;
      routeBody = await response.clone().json();
      return response;
    }
    throw new Error(`unexpected request: ${pathname}`);
  };
  try {
    const moduleUrl = new URL("../cli/login.mjs", import.meta.url).href;
    const { loginCommand } = await import(/* @vite-ignore */ moduleUrl);
    try {
      await loginCommand({ gateway: origin, name: "contract-test", new: true }, {
        fetch: fetchImpl, openUrl: () => {}, sleep: async () => {},
      });
    } catch (error) { loginError = error; }
    // Pin the reached boundary, not a hand-copied approximation of the payload.
    expect(requestBody.scopes.map((s: any) => s.provider)).toEqual(["demo", "anthropic"]);
    expect(routeStatus, JSON.stringify({ routeBody, loginError: String(loginError) })).toBe(201);
    // The scopes must survive validation INTACT, not merely be tolerated. The
    // demo entry is what the login proof call needs; a validator that quietly
    // dropped it would leave the 201 above green and the proof refused at the
    // scope gate — a second bug wearing this one's clothes.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.allowed_scopes).toEqual([
      { provider: "demo", models: ["*"] },
      { provider: "anthropic", models: ["claude-*"] },
    ]);
    // And login now reaches the step it used to die before: the config write.
    // The proof call that follows hits endpoints this test does not serve, so a
    // `loginError` is expected here — the file on disk is the assertion.
    expect(fs.existsSync(path.join(dir, "passcontrol", "config"))).toBe(true);
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
