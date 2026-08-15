import { afterEach, describe, expect, it, vi } from "vitest";
import { authEmailRedirect, safeAuthDestination } from "@/lib/auth/emailRedirect";
import { inviteSource, signupMode, validateSignupAccess } from "@/lib/invite-code";
import {
  issuePasswordRecoveryTicket,
  verifyPasswordRecoveryTicket,
} from "@/lib/auth/passwordRecovery";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("production signup policy", () => {
  it("defaults invalid and missing configuration to invite-only", () => {
    expect(signupMode(undefined)).toBe("invite");
    expect(signupMode("typo")).toBe("invite");
  });

  it("supports explicit open, invite, and closed modes", () => {
    expect(signupMode(" OPEN ")).toBe("open");
    expect(signupMode("invite")).toBe("invite");
    expect(signupMode("closed")).toBe("closed");
  });

  it("only asks for the shared code in invite mode", () => {
    expect(validateSignupAccess("open", "", "")).toBeNull();
    expect(validateSignupAccess("closed", "correct", "correct")).toBe(
      "Signups are currently closed."
    );
    expect(validateSignupAccess("invite", "wrong", "correct")).toBe("Invalid invite code.");
    expect(validateSignupAccess("invite", "correct", "correct")).toBeNull();
  });

  it("keeps shared-code signup unless database invitations are explicitly enabled", () => {
    expect(inviteSource(undefined)).toBe("shared");
    expect(inviteSource("typo")).toBe("shared");
    expect(inviteSource(" DATABASE ")).toBe("database");
  });
});

describe("authentication email redirects", () => {
  it("uses only the configured canonical issuer", () => {
    vi.stubEnv("PASSCONTROL_ISSUER", "https://cloud.passcontrol.example");
    expect(authEmailRedirect()).toBe("https://cloud.passcontrol.example/auth/callback");
    expect(authEmailRedirect("/login/reset")).toBe(
      "https://cloud.passcontrol.example/auth/callback?next=%2Flogin%2Freset"
    );
  });

  it("refuses an untrusted issuer rather than constructing a recovery link", () => {
    vi.stubEnv("PASSCONTROL_ISSUER", "http://public.example");
    expect(authEmailRedirect("/login/reset")).toBeNull();
  });

  it("rejects arbitrary and cross-origin callback destinations", () => {
    expect(safeAuthDestination("/login/reset")).toBe("/login/reset");
    expect(safeAuthDestination("https://attacker.example")).toBe("/dashboard");
    expect(safeAuthDestination("//attacker.example")).toBe("/dashboard");
    expect(safeAuthDestination("/dashboard?next=https://attacker.example")).toBe("/dashboard");
  });
});

describe("password recovery authorization", () => {
  it("binds a recovery callback ticket to one trusted Supabase user", async () => {
    vi.stubEnv("VISA_SECRET", "test-visa-secret-that-is-long-enough");
    const ticket = await issuePasswordRecoveryTicket("user-a");
    expect(ticket).toBeTruthy();
    await expect(verifyPasswordRecoveryTicket(ticket ?? undefined, "user-a")).resolves.toBe(true);
    await expect(verifyPasswordRecoveryTicket(ticket ?? undefined, "user-b")).resolves.toBe(false);
  });

  it("accepts an in-flight ticket across visa-secret rotation", async () => {
    vi.stubEnv("VISA_SECRET", "old-test-visa-secret-that-is-long-enough");
    const ticket = await issuePasswordRecoveryTicket("user-a");
    vi.stubEnv("VISA_SECRET_PREV", "old-test-visa-secret-that-is-long-enough");
    vi.stubEnv("VISA_SECRET", "new-test-visa-secret-that-is-long-enough");
    await expect(verifyPasswordRecoveryTicket(ticket ?? undefined, "user-a")).resolves.toBe(true);
  });
});
