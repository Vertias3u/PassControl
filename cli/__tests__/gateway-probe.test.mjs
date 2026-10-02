// Found in the 2026-10-02 Cloud E2E: a fresh `passcontrol status` reported the
// Cloud gateway "offline or unreachable" while `passcontrol version`, a moment
// later, read it fine. The probe gave every gateway 1.2 s, which suits one on
// this machine and not a remote one paying for DNS, TLS and a cold start on the
// first call; and it called a timeout "offline".
import { describe, expect, it } from "vitest";
import {
  LOCAL_PROBE_TIMEOUT_MS,
  REMOTE_PROBE_TIMEOUT_MS,
  probeGatewayVersion,
  probeTimeoutMs,
} from "../gateway-probe.mjs";

describe("probeTimeoutMs", () => {
  it("keeps the short timeout for a gateway on this machine", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3500", "http://[::1]:3000"]) {
      expect(probeTimeoutMs(origin), origin).toBe(LOCAL_PROBE_TIMEOUT_MS);
    }
  });

  it("gives a remote gateway room for DNS, TLS and a cold start", () => {
    expect(probeTimeoutMs("https://passcontrol.vertias.eu")).toBe(REMOTE_PROBE_TIMEOUT_MS);
    expect(REMOTE_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });
});

describe("probeGatewayVersion", () => {
  const ok = async () => new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 });

  it("reports a version answer as online", async () => {
    await expect(probeGatewayVersion("https://passcontrol.vertias.eu", { fetchImpl: ok })).resolves.toEqual({
      label: "online (200, PassControl 1.1.0)",
      ok: true,
      version: "1.1.0",
    });
  });

  it("waits past the old 1.2 s for a remote gateway", async () => {
    const slow = (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(ok()), 1500);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const result = await probeGatewayVersion("https://passcontrol.vertias.eu", { fetchImpl: slow });
    expect(result.ok).toBe(true);
  });

  it("calls a timeout a timeout, not offline", async () => {
    const never = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
      );
    const result = await probeGatewayVersion("https://passcontrol.vertias.eu", { fetchImpl: never, timeoutMs: 20 });
    expect(result).toEqual({ label: "no answer within 0.02 s", ok: false });
  });

  it("still says offline when the connection itself fails", async () => {
    const refused = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await expect(probeGatewayVersion("http://localhost:3000", { fetchImpl: refused })).resolves.toEqual({
      label: "offline or unreachable",
      ok: false,
    });
  });

  it("keeps the non-version answers it had", async () => {
    const status = (code, body) => async () => new Response(body, { status: code });
    await expect(probeGatewayVersion("http://localhost:3000", { fetchImpl: status(503, "") })).resolves.toEqual({
      label: "unhealthy (503)",
      ok: false,
    });
    await expect(probeGatewayVersion("http://localhost:3000", { fetchImpl: status(200, "<html>") })).resolves.toEqual({
      label: "unhealthy (not a PassControl version response)",
      ok: false,
    });
  });
});
