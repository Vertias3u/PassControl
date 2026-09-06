import { describe, expect, it, vi } from "vitest";
import {
  MENU_STATUS_TIMEOUT_MS,
  agentStateArgv,
  collectMenuRemoteStatus,
  integrationPreviewArgv,
  killSwitchArgv,
  logsArgv,
  verificationArgv,
} from "../menu-session.mjs";

describe("guided argv construction", () => {
  it("keeps integration configuration preview-only", () => {
    expect(integrationPreviewArgv("cursor")).toEqual(["configure", "cursor"]);
    expect(integrationPreviewArgv("cursor")).not.toContain("--write");
  });

  it("builds log filters without a shell", () => {
    expect(logsArgv({ agentId: "a-1", callClass: "inference", status: "success", limit: 50 })).toEqual([
      "logs", "--agent-id", "a-1", "--class", "inference", "--status", "success", "--limit", "50",
    ]);
  });

  it("builds receipt and token verification arguments", () => {
    expect(verificationArgv({ type: "receipt", artifact: "signed", issuer: "https://issuer.test" })).toEqual([
      "verify", "receipt", "signed", "--issuer", "https://issuer.test",
    ]);
    expect(verificationArgv({ type: "token", artifact: "jwt", issuer: "https://issuer.test", audience: "service" })).toEqual([
      "verify", "token", "jwt", "--issuer", "https://issuer.test", "--audience", "service",
    ]);
  });

  it("keeps administrative confirmations default-safe", () => {
    expect(agentStateArgv({ suspend: true, id: "a-1" })).toEqual(["agent", "suspend", "a-1"]);
    expect(killSwitchArgv({ armed: true, confirmed: false })).toBeNull();
    expect(killSwitchArgv({ armed: false, typed: "arm" })).toBeNull();
    expect(killSwitchArgv({ armed: false, typed: "ARM" })).toEqual(["kill", "on"]);
  });
});

describe("asynchronous menu status", () => {
  it("bounds every authenticated request and reports a partial 100+ fleet honestly", async () => {
    const records = Array.from({ length: 100 }, (_, index) => ({ status: index < 80 ? "active" : "suspended" }));
    const request = vi.fn(async (path, options) => {
      expect(options.timeoutMs).toBe(MENU_STATUS_TIMEOUT_MS);
      if (path === "/account") return { email: "owner@example.test", control_key_scope: "write" };
      if (path === "/agents?limit=100") return records;
      return { armed: false, platform_kill: true };
    });
    const status = await collectMenuRemoteStatus({
      hasApiKey: true,
      gatewayStatus: vi.fn(async (options) => {
        expect(options.timeoutMs).toBe(MENU_STATUS_TIMEOUT_MS);
        return { label: "online (200)" };
      }),
      request,
      safeText: (value, fallback) => value ?? fallback,
    });
    expect(status.account).toBe("owner@example.test · write key");
    expect(status.fleet).toBe("100+ agents (partial) · 80 active · 20 suspended");
    expect(status.kill).toBe("tenant clear · platform armed");
  });

  it("omits the account row for older 404 gateways and degrades other failures", async () => {
    const status = await collectMenuRemoteStatus({
      hasApiKey: true,
      gatewayStatus: async () => { throw new Error("timeout"); },
      request: async (path) => {
        if (path === "/account") throw new Error("404 not_found");
        throw new Error("timeout");
      },
    });
    expect(status).toMatchObject({ account: null, gateway: "unavailable", fleet: "unavailable", kill: "unavailable" });
  });

  it("does not probe authenticated endpoints without a control key", async () => {
    const request = vi.fn();
    const status = await collectMenuRemoteStatus({ hasApiKey: false, gatewayStatus: vi.fn(), request });
    expect(request).not.toHaveBeenCalled();
    expect(status.gateway).toBe("not authenticated");
  });
});
