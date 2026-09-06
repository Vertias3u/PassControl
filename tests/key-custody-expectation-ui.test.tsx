// The settings control for the workspace key-custody expectation.
//
// research/passport-key-protection.md §5 says what this may be and what it may
// not: "let the operator state an expectation for the workspace — a stated
// policy people can act on, not an enforced one", and above it, "Do not build a
// toggle that silently does nothing." Those pull in opposite directions, and the
// only thing that reconciles them is the wording. A control that reads like
// enforcement IS the toggle that silently does nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/settings/key-custody-actions", () => ({
  setKeyCustodyExpectation: vi.fn(),
}));

import { AdminAuditTable } from "@/components/AdminAuditTable";
import { KeyCustodyExpectation } from "@/components/KeyCustodyExpectation";

const render = (props: Parameters<typeof KeyCustodyExpectation>[0]) =>
  renderToStaticMarkup(<KeyCustodyExpectation {...props} />);

describe("stating a workspace expectation", () => {
  it("offers the expectation and says plainly that it enforces nothing", () => {
    const html = render({ state: "ready", expectation: null });
    expect(html).toContain('data-panel="key-custody-expectation"');
    expect(html).toContain('data-expectation="none"');
    expect(html).toMatch(/<select/);
    // The two claims that keep this honest: it is not enforced, and the thing
    // it is compared against was never checked.
    expect(html).toMatch(/not enforced|enforces nothing|nothing is blocked/i);
    expect(html).toMatch(/cannot (check|verify)/i);
  });

  it("shows the expectation already stated", () => {
    const html = render({ state: "ready", expectation: "os" });
    expect(html).toContain('data-expectation="os"');
    expect(html).toMatch(/OS credential store/);
  });

  // The owner applies migrations, so a build carrying this code will run for a
  // while against a database without the column. Rendering that as "you have
  // stated no expectation" would invite the operator to state one into a
  // control whose write is guaranteed to fail.
  it("never offers a control it cannot save", () => {
    const unmigrated = render({ state: "unmigrated", expectation: null });
    expect(unmigrated).toContain('data-state="unmigrated"');
    expect(unmigrated).not.toMatch(/<select/);
    expect(unmigrated).toMatch(/0051/);

    const unavailable = render({ state: "unavailable", expectation: null });
    expect(unavailable).toContain('data-state="unavailable"');
    expect(unavailable).not.toMatch(/<select/);
  });

  it("never claims an agent's custody was verified", () => {
    for (const html of [
      render({ state: "ready", expectation: "os" }),
      render({ state: "ready", expectation: null }),
    ]) {
      expect(html).not.toMatch(/\bverified\b/i);
      expect(html).not.toMatch(/\bwill be enforced\b/i);
      expect(html).not.toMatch(/\bcompliant\b/i);
    }
  });
});

// Same posture as every other write to public.users. 0032 revoked client writes
// on that table and 0051 adds no grant back, so the tenant boundary lives in
// this file rather than in RLS — which can only ask who owns a row, never
// whether the session writing it cleared a second factor.
describe("the write path", () => {
  const source = readFileSync(
    join(process.cwd(), "app/dashboard/settings/key-custody-actions.ts"),
    "utf8"
  );

  it("gates on MFA and writes with the service-role client", () => {
    expect(source).toContain('"use server"');
    expect(source).toContain("mfaAuthorizedUser");
    expect(source).toContain("serviceClient()");
  });

  it("takes the user id from the verified session, never from the argument", () => {
    expect(source).toMatch(/gate\.user\.id/);
    expect(source).not.toMatch(/function setKeyCustodyExpectation\([^)]*userId/);
  });

  it("records the change in the admin audit trail", () => {
    expect(source).toContain("recordAdminAction");
    expect(source).toContain("workspace.key_custody_expectation");
  });
});

// The audit row an operator actually reads.
//
// AdminAuditTable's default case renders the raw action slug, which is fine for
// most of the trail but poor for the one row that records a POLICY. It should
// say what was stated, and — because this is the trail people reach for when
// something broke — it should not let anyone read a policy statement as an
// enforcement change.
describe("the audit row", () => {
  it("names the change and the value, rather than falling through to the slug", () => {
    const html = renderToStaticMarkup(
      <AdminAuditTable
        rows={[
          {
            id: "1",
            action: "workspace.key_custody_expectation",
            target_type: null,
            target_id: null,
            metadata: { to: "os", via: "dashboard" },
            created_at: "2026-09-02T10:00:00.000Z",
          },
        ]}
      />
    );
    expect(html).not.toContain("workspace.key_custody_expectation");
    expect(html).toMatch(/key custody expectation/i);
    expect(html).toMatch(/stated/i);
  });

  it("says plainly when the expectation was cleared", () => {
    const html = renderToStaticMarkup(
      <AdminAuditTable
        rows={[
          {
            id: "1",
            action: "workspace.key_custody_expectation",
            target_type: null,
            target_id: null,
            metadata: { to: "none", via: "dashboard" },
            created_at: "2026-09-02T10:00:00.000Z",
          },
        ]}
      />
    );
    expect(html).toMatch(/cleared/i);
  });
});
