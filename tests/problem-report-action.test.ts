/**
 * The submit path, pinned at the level the defect would actually appear.
 *
 * The behavioural half runs the action against mocked clients. The source half
 * asserts a shape that a passing behavioural test would not notice being
 * broken: that the action DERIVES the diagnostic artifact rather than accepting
 * one. A refactor that "simplifies" by passing the form's rendered preview back
 * through would keep every behavioural test green and would hand a tenant a
 * writable jsonb column with the word "diagnostics" on it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mfaAuthorizedUser: vi.fn(),
  rateLimit: vi.fn(),
  recordAdminAction: vi.fn(),
  buildProblemDiagnostics: vi.fn(),
  readInstanceStamp: vi.fn(),
  insert: vi.fn(),
  countRecent: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({}) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: mocks.mfaAuthorizedUser }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: mocks.recordAdminAction }));
vi.mock("@/lib/problem-diagnostics", () => ({
  buildProblemDiagnostics: mocks.buildProblemDiagnostics,
  readInstanceStamp: mocks.readInstanceStamp,
  withinDiagnosticSizeLimit: () => true,
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ gte: () => mocks.countRecent() }) }),
      insert: (row: unknown) => ({ select: () => ({ single: () => mocks.insert(row) }) }),
    }),
  }),
}));

import { submitProblemReport } from "@/app/dashboard/report/actions";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const GOOD = { kind: "bug", message: "The kill switch page returns a 500 with two agents suspended." };

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.mfaAuthorizedUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  mocks.rateLimit.mockResolvedValue({ success: true, remaining: 4 });
  mocks.countRecent.mockResolvedValue({ count: 0, error: null });
  mocks.insert.mockResolvedValue({ data: { id: "report-1" }, error: null });
  mocks.readInstanceStamp.mockResolvedValue({
    app_version: "0.6.1",
    release_channel: "beta",
    build_commit: null,
    schema_head: "0038_problem_reports.sql",
    schema_state: "current",
  });
  mocks.buildProblemDiagnostics.mockResolvedValue({ artifact_version: 1, source: "problem_report" });
});

describe("submitProblemReport", () => {
  it("stores a report and stamps which build it was filed against", async () => {
    const state = await submitProblemReport(undefined, form(GOOD));
    expect(state?.ok).toBe(true);
    const row = mocks.insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.user_id).toBe("user-1");
    expect(row.kind).toBe("bug");
    expect(row.app_version).toBe("0.6.1");
    expect(row.schema_head).toBe("0038_problem_reports.sql");
  });

  it("takes user_id from the verified session, not from the form", async () => {
    await submitProblemReport(undefined, form({ ...GOOD, user_id: "someone-else" }));
    expect((mocks.insert.mock.calls[0]![0] as Record<string, unknown>).user_id).toBe("user-1");
  });

  /** The reason lib/redact.ts exists. */
  it("scrubs a provider key out of the body before it reaches the table", async () => {
    await submitProblemReport(
      undefined,
      form({ kind: "bug", message: "auth fails, my key is sk-ant-api03-LeakedRightHere12345 ok" })
    );
    const row = mocks.insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(row.message)).not.toContain("sk-ant-api03-LeakedRightHere12345");
    expect(String(row.message)).toContain("[redacted]");
  });

  it("attaches diagnostics only when the box was ticked", async () => {
    await submitProblemReport(undefined, form(GOOD));
    expect((mocks.insert.mock.calls[0]![0] as Record<string, unknown>).diagnostics).toBeNull();
    expect(mocks.buildProblemDiagnostics).not.toHaveBeenCalled();

    mocks.insert.mockClear();
    await submitProblemReport(undefined, form({ ...GOOD, attach_diagnostics: "on" }));
    expect((mocks.insert.mock.calls[0]![0] as Record<string, unknown>).diagnostics).not.toBeNull();
  });

  /** The words are the point; the artifact is a convenience. */
  it("still files the report when the diagnostics collector fails", async () => {
    mocks.buildProblemDiagnostics.mockRejectedValue(new Error("timeout"));
    const state = await submitProblemReport(undefined, form({ ...GOOD, attach_diagnostics: "on" }));
    expect(state?.ok).toBe(true);
    expect((mocks.insert.mock.calls[0]![0] as Record<string, unknown>).diagnostics).toBeNull();
    expect(state?.message).toMatch(/without them/i);
  });

  it("refuses an unknown kind and an out-of-range body", async () => {
    expect((await submitProblemReport(undefined, form({ ...GOOD, kind: "urgent" })))?.ok).toBe(false);
    expect((await submitProblemReport(undefined, form({ kind: "bug", message: "too short" })))?.ok).toBe(false);
    expect((await submitProblemReport(undefined, form({ kind: "bug", message: "x".repeat(4_001) })))?.ok).toBe(false);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses before the gate is cleared", async () => {
    mocks.mfaAuthorizedUser.mockResolvedValue({ ok: false, reason: "step_up_required" });
    const state = await submitProblemReport(undefined, form(GOOD));
    expect(state?.ok).toBe(false);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("holds the daily ceiling even though the Redis limiter admitted the call", async () => {
    mocks.countRecent.mockResolvedValue({ count: 20, error: null });
    const state = await submitProblemReport(undefined, form(GOOD));
    expect(state?.ok).toBe(false);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("records the audit row without the body in it", async () => {
    await submitProblemReport(undefined, form(GOOD));
    const audit = mocks.recordAdminAction.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(audit.metadata.kind).toBe("bug");
    expect(JSON.stringify(audit)).not.toContain("kill switch page");
  });
});

describe("submitProblemReport — source invariants", () => {
  const source = readFileSync(resolve(process.cwd(), "app/dashboard/report/actions.ts"), "utf8");

  /**
   * The invariant a behavioural test cannot see. If the action ever reads a
   * diagnostics payload off the form, the artifact stops being allowlist-built
   * and becomes whatever the browser posted.
   */
  it("derives the artifact and never reads one from the request", () => {
    expect(source).toMatch(/buildProblemDiagnostics\(/);
    expect(source).not.toMatch(/formData\.get\(\s*["'](diagnostics|bundle|artifact)/);
    expect(source).not.toMatch(/JSON\.parse\([^)]*formData/);
  });

  it("writes through the service client, never the cookie-bound one", () => {
    expect(source).toMatch(/serviceClient\(\)/);
    expect(source).not.toMatch(/\bdb\s*\.from\([^)]*\)\s*\.insert/);
  });

  it("keeps the burst limiter fail-open and the ceiling fail-closed", () => {
    expect(source).toMatch(/rateLimit\(`problem-report:/);
    expect(source).not.toMatch(/rateLimitFailClosed/);
    expect(source).toMatch(/count: "exact", head: true/);
  });
});
