import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemHealthSnapshot } from "@/lib/system-health";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { SystemHealthSnapshotView } = await import("@/components/dashboard/SystemHealthSnapshot");
const { SystemHealthRestricted } = await import("@/components/dashboard/SystemHealthRestricted");

const snapshot: SystemHealthSnapshot = {
  format_version: 1,
  generated_at: "2026-08-22T12:00:00.000Z",
  overall: "attention",
  build: {
    version: "0.6.1",
    commit: "0123456789abcdef0123456789abcdef01234567",
    channel: "development",
  },
  migrations: {
    state: "behind",
    expected_head: "0036_system_health.sql",
    applied_head: "0035_passport_key_namespace.sql",
    missing_count: 1,
    extra_count: 0,
    action: "Apply the expected migration.",
  },
  protocols: { control_api: { minimum: 1, maximum: 1 }, gateway_api: { minimum: 1, maximum: 1 }, receipt: { minimum: 1, maximum: 2 }, agent_token: { minimum: 1, maximum: 1 }, workspace_export: { minimum: 1, maximum: 1 } },
  checks: [
    { id: "build_identity", category: "application", label: "Release identity", state: "ready", summary: "Available.", action: null },
    { id: "database", category: "database", label: "Migration ledger", state: "attention", summary: "Migration ledger needs attention.", action: "Apply the expected migration." },
    {
      id: "redis",
      category: "runtime",
      label: "Runtime dependency",
      state: "degraded",
      summary: "Functionality is partial.",
      action: "Restore Redis connectivity.",
      impact: {
        functionality: { state: "partial", summary: "Redis-backed functionality is unavailable." },
        security: { state: "degraded", summary: "Revocation guarantees are weakened; Direct Agent Key verification remains fail-closed." },
      },
    },
    { id: "receipt_signing", category: "trust", label: "Signing material", state: "ready", summary: "Configured locally.", action: null },
  ],
};

describe("System Health dashboard surface", () => {
  it("renders four safe, text-labelled health areas and no hidden diagnostic payload", () => {
    const html = renderToStaticMarkup(<SystemHealthSnapshotView snapshot={snapshot} />);
    for (const title of ["Application identity", "Database & migrations", "Runtime dependencies", "Trust & signing"]) {
      expect(html).toContain(title.replace("&", "&amp;"));
    }
    expect(html).toContain("Needs attention");
    expect(html).toContain("Functionality: Partial");
    expect(html).toContain("Security: Degraded");
    expect(html).toContain("Direct Agent Key verification remains fail-closed.");
    expect(html).toContain("Migration ledger: Behind");
    expect(html).toContain("Release version");
    expect(html).toContain("0.6.1");
    expect(html).toContain("0123456");
    expect(html).toContain("0036_system_health.sql");
    expect(html).toContain("Diagnostics do not contact model providers or verify public signing routes.");
    expect(html).not.toContain("expected_head");
  });

  it("keeps refresh manual and makes the privileged route authoritative", () => {
    const page = readFileSync(resolve(process.cwd(), "app/dashboard/system/page.tsx"), "utf8");
    const refresh = readFileSync(resolve(process.cwd(), "components/dashboard/SystemHealthRefresh.tsx"), "utf8");
    expect(page).toContain("export const dynamic = \"force-dynamic\"");
    expect(page).toContain("systemOperatorGate()");
    expect(page).toContain("getCachedSystemHealthSnapshot()");
    expect(page).toMatch(/refresh[\s\S]*getSystemHealthSnapshot\(\)/);
    expect(page).toContain("migrationHealth={snapshot.migrations}");
    expect(page).toContain('redirect("/login/verify")');
    // A refused operator is explained to, not bounced to /dashboard.
    expect(page).toContain("SystemHealthRestricted");
    expect(refresh).toContain("router.replace(");
    expect(refresh).toContain("?refresh=");
    expect(refresh).toContain("useTransition");
    expect(refresh).not.toMatch(/setInterval|setTimeout|fetch\s*\(|router\.refresh\(\)/);
  });

  it("only offers the navigation entry to the configured operator address", () => {
    const shell = readFileSync(resolve(process.cwd(), "components/dashboard/DashboardShell.tsx"), "utf8");
    const commands = readFileSync(resolve(process.cwd(), "components/dashboard/DashboardCommandPalette.tsx"), "utf8");
    expect(shell).toContain("showSystemHealth");
    expect(shell).toContain('href: "/dashboard/system"');
    expect(shell).toContain("mfaAuthorizedUser(db)");
    expect(shell).toMatch(/mfa\.ok[\s\S]*systemOperatorEmails\(\)\.has/);
    expect(shell).toContain('factor.factor_type === "totp" && factor.status === "verified"');
    expect(commands).toContain("showSystemHealth");
    expect(commands).toContain('href: "/dashboard/system"');
  });
});

describe("a refused operator is told why", () => {
  it("gives each refusal its own next step and never leaks diagnostics", () => {
    const cases = {
      enrollment_required: "authenticator",
      not_configured: "PASSCONTROL_SYSTEM_OPERATOR_EMAILS",
      misconfigured: "PASSCONTROL_SYSTEM_OPERATOR_EMAILS",
      forbidden: "not one of them",
    } as const;
    const seen = new Set<string>();
    for (const [reason, expected] of Object.entries(cases)) {
      const html = renderToStaticMarkup(<SystemHealthRestricted reason={reason as any} />);
      expect(html).toContain(expected);
      expect(html).not.toContain("Migration ledger");
      expect(html).not.toContain("Vault");
      seen.add(html);
    }
    expect(seen.size).toBe(Object.keys(cases).length);
  });

  it("names the deployment variable only for a deployment state, never to an unauthorized account", () => {
    const html = renderToStaticMarkup(<SystemHealthRestricted reason="forbidden" />);
    expect(html).not.toContain("PASSCONTROL_SYSTEM_OPERATOR_EMAILS");
  });
});
