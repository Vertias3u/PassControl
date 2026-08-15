import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BETA_RETENTION_CRON,
  createReconcileRequest,
  createRetentionRequest,
  runBetaRetention,
  runReconcile,
} from "../cloudflare/reconcile.mjs";

describe("Cloudflare deployment contract", () => {
  it("keeps the adapter additive and schedules reconciliation every five minutes", () => {
    const config = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
    expect(config.main).toBe("cloudflare/worker.mjs");
    expect(config.compatibility_flags).toContain("nodejs_compat");
    expect(config.triggers.crons).toEqual(["*/5 * * * *", "15 0 * * *"]);
    expect(config.triggers.crons).toContain(BETA_RETENTION_CRON);
    expect(fs.readFileSync("cloudflare/worker.mjs", "utf8")).toContain(
      "controller.cron === BETA_RETENTION_CRON"
    );
    expect(config.vars.PASSCONTROL_TRUST_CF_CONNECTING_IP).toBe("true");

    const sourceRoute = fs.readFileSync("app/api/auth/challenge/route.ts", "utf8");
    expect(sourceRoute).toContain('export const runtime = "edge"');
  });

  it("calls the authenticated beta-retention route only from its daily trigger", async () => {
    const env = {
      PASSCONTROL_ISSUER: "https://cloud.passcontrol.example",
      CRON_SECRET: "cron-test-secret",
    };
    expect(createRetentionRequest(env).url).toBe("https://cloud.passcontrol.example/api/cron/beta-retention");
    const fetchHandler = vi.fn(async () => new Response(null, { status: 200 }));
    await runBetaRetention(fetchHandler, env, {});
    expect(fetchHandler).toHaveBeenCalledOnce();
  });

  it("calls the existing authenticated reconcile route without exposing its secret", async () => {
    const env = {
      PASSCONTROL_ISSUER: "https://cloud.passcontrol.example",
      CRON_SECRET: "cron-test-secret",
    };
    const request = createReconcileRequest(env);
    expect(request.url).toBe("https://cloud.passcontrol.example/api/cron/reconcile");
    expect(request.headers.get("authorization")).toBe("Bearer cron-test-secret");

    const fetchHandler = vi.fn(async () => new Response(null, { status: 204 }));
    await runReconcile(fetchHandler, env, {});
    expect(fetchHandler).toHaveBeenCalledOnce();
  });

  it("fails closed when the cron secret or canonical origin is missing", () => {
    expect(() => createReconcileRequest({ PASSCONTROL_ISSUER: "https://cloud.example" })).toThrow(
      "CRON_SECRET"
    );
    expect(() => createReconcileRequest({ CRON_SECRET: "secret" })).toThrow(
      "PASSCONTROL_ISSUER"
    );
    expect(() =>
      createReconcileRequest({ PASSCONTROL_ISSUER: "http://public.example", CRON_SECRET: "secret" })
    ).toThrow("HTTPS");
  });
});
