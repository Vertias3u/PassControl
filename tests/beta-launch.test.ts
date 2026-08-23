import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  betaApplicationIp,
  betaInviteSource,
  betaInviteUrl,
  betaOperatorEmails,
  betaRateLimitSubject,
  hashBetaInviteToken,
  issueBetaInviteToken,
  parseBetaApplication,
} from "@/lib/beta-launch";

const repo = process.cwd();

afterEach(() => vi.unstubAllEnvs());

describe("beta application boundary", () => {
  it("is reachable before login and stays dynamically rendered for nonce CSP", () => {
    const middleware = readFileSync(join(repo, "middleware.ts"), "utf8");
    const page = readFileSync(join(repo, "app/beta/page.tsx"), "utf8");
    const publicPaths = middleware.match(/const PUBLIC_PATHS = \[([\s\S]*?)\]/)?.[1] ?? "";
    expect(publicPaths).toContain('"/beta"');
    expect(page).toContain('export const dynamic = "force-dynamic"');
  });

  it("validates a minimum-data application and normalises email", () => {
    const form = new FormData();
    form.set("email", " Test@Example.COM ");
    form.set("integration", "hermes");
    form.set("provider", "openai");
    form.set("monthly_call_bucket", "under-1000");
    form.set("use_case", "A coding agent running on my own workstation.");
    form.set("contact_consent", "on");
    const parsed = parseBetaApplication(form);
    expect(parsed.ok && parsed.value.email).toBe("test@example.com");
  });

  it("rejects invented choices, short text and missing consent", () => {
    const form = new FormData();
    form.set("email", "test@example.com");
    form.set("integration", "invented");
    form.set("provider", "openai");
    form.set("monthly_call_bucket", "under-1000");
    form.set("use_case", "too short");
    expect(parseBetaApplication(form).ok).toBe(false);
  });

  it("uses only deployment-owned forwarding headers on supported hosts", () => {
    const incoming = new Headers({
      "cf-connecting-ip": "203.0.113.1",
      "x-vercel-forwarded-for": "203.0.113.2",
      "x-forwarded-for": "198.51.100.10, 10.0.0.1",
    });
    expect(betaApplicationIp(incoming, { VERCEL: "1" })).toBe("203.0.113.2");
    expect(betaApplicationIp(incoming, {
      PASSCONTROL_TRUST_CF_CONNECTING_IP: "true",
      VERCEL: "1",
    })).toBe("203.0.113.1");
    expect(betaApplicationIp(incoming, {})).toBe("198.51.100.10");
  });
});

describe("one-time beta invitations", () => {
  it("generates a random reveal value but stores only a sha256 hash", () => {
    const first = issueBetaInviteToken();
    const second = issueBetaInviteToken();
    expect(first.raw).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.hash).toBe(hashBetaInviteToken(first.raw));
    expect(first.raw).not.toBe(second.raw);
  });

  it("puts the raw token in a URL fragment rather than the request path/query", () => {
    vi.stubEnv("PASSCONTROL_ISSUER", "https://passcontrol.example/");
    const url = betaInviteUrl("secret-value");
    expect(url).toBe("https://passcontrol.example/signup#invite=secret-value");
    expect(new URL(url).search).toBe("");
  });

  it("defaults to the dormant shared source", () => {
    expect(betaInviteSource(undefined)).toBe("shared");
    expect(betaInviteSource("database")).toBe("database");
  });
});

describe("operator and privacy boundaries", () => {
  it("normalises the exact operator email allowlist", () => {
    expect([...betaOperatorEmails(" Owner@Example.com,second@example.com ")]).toEqual([
      "owner@example.com",
      "second@example.com",
    ]);
  });

  it("stores only HMAC-derived limiter subjects", () => {
    vi.stubEnv("VISA_SECRET", "v".repeat(48));
    const subject = betaRateLimitSubject("email", "person@example.com");
    expect(subject).toMatch(/^[0-9a-f]{64}$/u);
    expect(subject).not.toContain("person");
    expect(betaRateLimitSubject("ip", "person@example.com")).not.toBe(subject);
  });

  it("keeps operator reads server-only, MFA/TOTP gated, and avoids raw-token export", () => {
    const migration = readFileSync(join(repo, "db/migrations/0025_beta_launch_system.sql"), "utf8");
    const operator = readFileSync(join(repo, "lib/beta-operator.ts"), "utf8");
    const account = readFileSync(join(repo, "lib/account-lifecycle.ts"), "utf8");
    expect(migration).toMatch(/revoke all on public\.beta_applications from public, anon, authenticated/i);
    expect(migration).toMatch(/claim_beta_invite[\s\S]*grant execute[\s\S]*to service_role/i);
    expect(migration).toMatch(/hook_authorize_beta_signup[\s\S]*grant execute[\s\S]*to supabase_auth_admin/i);
    expect(migration).toMatch(/grant usage on schema public to supabase_auth_admin/i);
    expect(migration).toContain("authorized_auth_user_id = p_user_id");
    expect(operator).toContain("mfaAuthorizedUser(db)");
    expect(operator).toContain('factor.factor_type === "totp"');
    expect(account).not.toMatch(/select\([^\n]*token_hash/);
  });

  it("binds Auth creation to the claimed invite and cleans up a failed redemption", () => {
    const auth = readFileSync(join(repo, "app/actions/auth.ts"), "utf8");
    expect(auth).toContain("passcontrol_beta_invite_id: claimedInviteId");
    expect(auth).toContain("auth.admin.deleteUser(data.user!.id)");
    expect(auth).toContain('supabase.auth.signOut({ scope: "global" })');
    expect(auth).toContain("invite_redeem_cleanup_failed");
  });

  it("keeps owner emails text-only and tracking-free", () => {
    const email = readFileSync(join(repo, "lib/beta-email.ts"), "utf8");
    expect(email).toContain("text: email.text");
    expect(email).not.toMatch(/html:\s*email/i);
    expect(email).not.toMatch(/utm_/i);
  });

  it("keeps operator-only lifecycle controls reachable and delivery uncertainty visible", () => {
    const panel = readFileSync(join(repo, "components/dashboard/BetaOperatorPanel.tsx"), "utf8");
    const operatorAction = readFileSync(join(repo, "app/dashboard/beta/actions.ts"), "utf8");
    expect(panel).toContain("Record withdrawal");
    expect(panel).toContain("Delivery state unresolved");
    expect(operatorAction).toContain("withdraw_beta_application");
    for (const page of [
      "app/dashboard/page.tsx",
      "app/dashboard/settings/page.tsx",
      "app/dashboard/agents/[id]/page.tsx",
      "app/dashboard/feedback/page.tsx",
    ]) {
      expect(readFileSync(join(repo, page), "utf8")).toContain("showBetaOperator=");
    }
  });
});

describe("migration lifecycle", () => {
  it("does not alter existing product tables and includes retention plus account cascades", () => {
    const sql = readFileSync(join(repo, "db/migrations/0025_beta_launch_system.sql"), "utf8");
    expect(sql).not.toMatch(/alter table public\.users[\s\S]*add column/i);
    expect(sql).not.toMatch(/alter table public\.agents[\s\S]*add column/i);
    expect(sql).toContain("purge_beta_launch_data");
    expect(sql.match(/references public\.users\(id\) on delete cascade/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("interval '180 days'");
    expect(sql).toContain("interval '30 days'");
  });

  it("serialises invitation activation, decline, and redemption in service-only RPCs", () => {
    const sql = readFileSync(join(repo, "db/migrations/0025_beta_launch_system.sql"), "utf8");
    for (const name of [
      "prepare_beta_invite",
      "activate_beta_invite",
      "fail_beta_invite",
      "decline_beta_application",
      "withdraw_beta_application",
    ]) {
      expect(sql).toContain(`function public.${name}`);
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}[\\s\\S]*to service_role`, "i"));
    }
    expect(sql).toContain("for update of i, a");
    expect(sql).toContain("authorized_auth_user_id is null");
    expect(sql).toContain("v_user_id is null or v_invite_id is null");
    expect(sql).toContain("'nudge.pending'");
    expect(sql).toContain("'feedback_request.pending'");
  });

  it("fails closed when application rate-limit infrastructure is unreadable", () => {
    const action = readFileSync(join(repo, "app/beta/actions.ts"), "utf8");
    expect(action).toContain("rateLimitFailClosed");
    expect(action).toContain("ipLimit.unreadable || emailLimit.unreadable");
    expect(action).toContain("betaApplicationIp(await headers())");
  });

  it("makes non-public function execution the default for later migrations", () => {
    const sql = readFileSync(join(repo, "db/migrations/0025_beta_launch_system.sql"), "utf8");
    expect(sql).toContain(
      "alter default privileges revoke execute on functions from public"
    );
    expect(sql).toMatch(
      /alter default privileges in schema public\s+revoke execute on functions from anon, authenticated/iu
    );
  });
});
