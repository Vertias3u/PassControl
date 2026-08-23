import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
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

    const buildSource = fs.readFileSync("scripts/build-cloudflare.mjs", "utf8");
    expect(buildSource).toContain('"db/migrations"');
    expect(buildSource).not.toContain('copy("db")');
  });

  it("injects an Edge-safe manifest that includes the checked-out migration head", async () => {
    const config = (await import("../next.config.mjs")).default;
    const manifest = JSON.parse(config.env.PASSCONTROL_INTERNAL_MIGRATION_MANIFEST);
    const migrationsDir = path.join(process.cwd(), "db", "migrations");
    const entries = fs.readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((version) => ({
        version,
        checksum: createHash("sha256").update(fs.readFileSync(path.join(migrationsDir, version))).digest("hex"),
      }));
    expect(manifest.entries).toEqual(entries);
    expect(manifest.head).toBe(entries.at(-1).version);
    expect(manifest.fingerprint).toBe(createHash("sha256").update(JSON.stringify(entries)).digest("hex"));
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
