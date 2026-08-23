import { beforeEach, describe, expect, it, vi } from "vitest";

const mfa = vi.fn();
const sessionDb: any = {};
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: (...args: any[]) => mfa(...args) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => sessionDb }));

import { systemOperatorAllowlist, systemOperatorEmails, systemOperatorForControl, systemOperatorGate } from "@/lib/system-health/operator";

beforeEach(() => { vi.unstubAllEnvs(); mfa.mockReset(); });

describe("system operator authorization", () => {
  it("normalizes only complete email entries, never substrings", () => {
    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", " Admin@Example.COM , ops@example.com ");
    expect(systemOperatorEmails()).toEqual(new Set(["admin@example.com", "ops@example.com"]));
  });

  it("fails closed when the Auth-admin lookup errors", async () => {
    const db: any = { auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: null, error: new Error("down") }) } } };
    await expect(systemOperatorForControl(db, "user-1")).resolves.toEqual({ ok: false, reason: "forbidden" });
  });

  it("requires the key owner returned by Auth admin to have an allowlisted email and verified TOTP", async () => {
    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", "ops@example.com");
    const db: any = {
      auth: {
        admin: {
          getUserById: vi.fn().mockResolvedValue({
            data: { user: { id: "different-user", email: "ops@example.com", factors: [{ factor_type: "totp", status: "verified" }] } },
            error: null,
          }),
        },
      },
    };
    await expect(systemOperatorForControl(db, "user-1")).resolves.toEqual({ ok: false, reason: "forbidden" });

    db.auth.admin.getUserById.mockResolvedValue({
      data: { user: { id: "user-1", email: "ops@example.com", factors: [] } }, error: null,
    });
    await expect(systemOperatorForControl(db, "user-1")).resolves.toEqual({ ok: false, reason: "enrollment_required" });

    db.auth.admin.getUserById.mockResolvedValue({
      data: { user: { id: "user-1", email: "not-ops@example.com", factors: [{ factor_type: "totp", status: "verified" }] } }, error: null,
    });
    await expect(systemOperatorForControl(db, "user-1")).resolves.toEqual({ ok: false, reason: "forbidden" });

    db.auth.admin.getUserById.mockResolvedValue({
      data: { user: { id: "user-1", email: "ops@example.com", factors: [{ factor_type: "totp", status: "verified" }] } }, error: null,
    });
    await expect(systemOperatorForControl(db, "user-1")).resolves.toMatchObject({ ok: true });
  });

  it("browser gate refuses every incomplete assurance state and accepts only verified TOTP allowlisted users", async () => {
    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", "ops@example.com");
    mfa.mockResolvedValueOnce({ ok: false, reason: "unauthenticated" });
    await expect(systemOperatorGate()).resolves.toEqual({ ok: false, reason: "unauthenticated" });
    mfa.mockResolvedValueOnce({ ok: false, reason: "indeterminate" });
    await expect(systemOperatorGate()).resolves.toEqual({ ok: false, reason: "step_up_required" });
    mfa.mockResolvedValueOnce({ ok: false, reason: "step_up_required" });
    await expect(systemOperatorGate()).resolves.toEqual({ ok: false, reason: "step_up_required" });
    mfa.mockResolvedValueOnce({ ok: true, user: { email: "ops@example.com", factors: [{ factor_type: "phone", status: "verified" }] } });
    await expect(systemOperatorGate()).resolves.toMatchObject({ ok: false, reason: "enrollment_required" });
    mfa.mockResolvedValueOnce({ ok: true, user: { email: "ops@example.com", factors: [{ factor_type: "totp", status: "unverified" }] } });
    await expect(systemOperatorGate()).resolves.toMatchObject({ ok: false, reason: "enrollment_required" });
    mfa.mockResolvedValueOnce({ ok: true, user: { email: "other@example.com", factors: [{ factor_type: "totp", status: "verified" }] } });
    await expect(systemOperatorGate()).resolves.toMatchObject({ ok: false, reason: "forbidden" });
    const user = { email: "ops@example.com", factors: [{ factor_type: "totp", status: "verified" }] };
    mfa.mockResolvedValueOnce({ ok: true, user });
    await expect(systemOperatorGate()).resolves.toEqual({ ok: true, user });
  });
});

describe("system operator refusal is specific enough to act on", () => {
  const totp = [{ factor_type: "totp", status: "verified" }];

  it("separates an unreadable allowlist from an absent one", () => {
    expect(systemOperatorAllowlist().state).toBe("unset");
    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", "ops@example.com,not-an-email");
    expect(systemOperatorAllowlist().state).toBe("malformed");
    expect(systemOperatorAllowlist().emails.size).toBe(0);
    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", "ops@example.com");
    expect(systemOperatorAllowlist().state).toBe("configured");
  });

  it("tells an enrolled-nothing operator to enrol rather than sending them to a step-up they cannot complete", async () => {
    // /login/verify bounces a user with no factor straight back to /dashboard,
    // so "mfa_required" was a two-hop dead end for exactly this account.
    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", "ops@example.com");
    mfa.mockResolvedValueOnce({ ok: true, user: { id: "u1", email: "ops@example.com", factors: [] } });
    await expect(systemOperatorGate()).resolves.toMatchObject({ ok: false, reason: "enrollment_required" });
  });

  it("names the deployment state when the instance authorizes nobody", async () => {
    mfa.mockResolvedValueOnce({ ok: true, user: { id: "u1", email: "ops@example.com", factors: totp } });
    await expect(systemOperatorGate()).resolves.toMatchObject({ ok: false, reason: "not_configured" });

    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", "ops@example.com,oops");
    mfa.mockResolvedValueOnce({ ok: true, user: { id: "u1", email: "ops@example.com", factors: totp } });
    await expect(systemOperatorGate()).resolves.toMatchObject({ ok: false, reason: "misconfigured" });
  });

  it("keeps a refused operator's identity so the page can explain without re-authenticating", async () => {
    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", "ops@example.com");
    const user = { id: "u2", email: "other@example.com", factors: totp };
    mfa.mockResolvedValueOnce({ ok: true, user });
    await expect(systemOperatorGate()).resolves.toEqual({ ok: false, reason: "forbidden", user });
  });

  it("reports the same distinctions on the headless key path", async () => {
    const user = { id: "user-1", email: "ops@example.com", factors: [] as any[] };
    const db: any = { auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }) } } };
    await expect(systemOperatorForControl(db, "user-1")).resolves.toMatchObject({ reason: "enrollment_required" });

    user.factors = totp as any;
    await expect(systemOperatorForControl(db, "user-1")).resolves.toMatchObject({ reason: "not_configured" });
    vi.stubEnv("PASSCONTROL_SYSTEM_OPERATOR_EMAILS", "nope");
    await expect(systemOperatorForControl(db, "user-1")).resolves.toMatchObject({ reason: "misconfigured" });
  });
});
