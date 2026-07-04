import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  alertSeverity,
  shouldAlert,
  formatAlertMessage,
  dispatchSecurityAlert,
} from "../lib/alert";

describe("alert severity classification", () => {
  it("flags lockout and master kill as critical", () => {
    expect(alertSeverity("auth.login.locked")).toBe("critical");
    expect(alertSeverity("killswitch.master")).toBe("critical");
  });
  it("flags rate-limit and suspend as warning", () => {
    expect(alertSeverity("auth.login.ratelimited")).toBe("warning");
    expect(alertSeverity("agent.suspend")).toBe("warning");
  });
  it("treats chatty/benign events as info (never alerts)", () => {
    for (const e of ["auth.login.success", "auth.login.failure", "auth.signup.success", "auth.logout"]) {
      expect(alertSeverity(e)).toBe("info");
      expect(shouldAlert(e)).toBe(false);
    }
  });
});

describe("formatAlertMessage", () => {
  it("renders severity, event, and fields", () => {
    const msg = formatAlertMessage("auth.login.locked", { email: "jo***@x.com", ip: "1.2.3.4" });
    expect(msg).toBe("[PassControl CRITICAL] auth.login.locked — email=jo***@x.com ip=1.2.3.4");
  });
  it("sanitizes CR/LF so an attacker can't forge or split channel lines", () => {
    const msg = formatAlertMessage("agent.suspend", { agentId: "good\r\n[PassControl CRITICAL] fake" });
    expect(msg).not.toContain("\n");
    expect(msg).not.toContain("\r");
  });
});

describe("dispatchSecurityAlert", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SECURITY_ALERT_WEBHOOK;
  });

  it("does nothing when no webhook is configured", async () => {
    delete process.env.SECURITY_ALERT_WEBHOOK;
    await dispatchSecurityAlert("auth.login.locked", { ip: "1.2.3.4" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call the webhook for non-severe events", async () => {
    process.env.SECURITY_ALERT_WEBHOOK = "https://hooks.example.com/x";
    await dispatchSecurityAlert("auth.login.success", { ip: "1.2.3.4" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a Slack+Discord-compatible payload for severe events", async () => {
    process.env.SECURITY_ALERT_WEBHOOK = "https://hooks.example.com/x";
    await dispatchSecurityAlert("killswitch.master", { user: "u1", on: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/x");
    const body = JSON.parse(String(opts.body));
    expect(body.text).toContain("killswitch.master");
    expect(body.text).toBe(body.content); // both fields carry the same line
  });

  it("never throws even if the webhook call rejects", async () => {
    process.env.SECURITY_ALERT_WEBHOOK = "https://hooks.example.com/x";
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(dispatchSecurityAlert("auth.login.locked", {})).resolves.toBeUndefined();
  });
});
