// What the shadow panel actually RENDERS, not what its source contains.
//
// The rest of the panel's coverage greps the file. That catches a deleted guard
// and nothing else: this repo has already shipped a receipt page whose source
// was correct and whose DOM showed "Signature matches the contents ✓" against a
// FORGED receipt, with the suite green throughout. The panel's job is to tell an
// operator which draft a number describes, and that is a statement made in the
// DOM, not in the source.
//
// Rendered with renderToStaticMarkup and createElement — no jsdom, no JSX
// pipeline to configure, no new dependency. The panel is a client component, but
// its first paint is the whole surface under test.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The server action module pulls in Supabase, MFA and the audit writer. The
// panel only needs the two functions to exist in order to render.
vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { PolicyShadowPanel } from "@/components/PolicyShadowPanel";
import { shadowRevision, stampShadowVerdict, toShadowState } from "@/lib/policy-shadow";

const AGENT = "22222222-2222-2222-2222-222222222222";
const DRAFT = { deny: [{ provider: "openai", models: ["*"] }] };
const OTHER = { deny: [{ provider: "groq", models: ["*"] }] };

const stamped = (verdict: string, draft: unknown, at = "2026-08-07T11:00:00Z") => ({
  policy_shadow_would: stampShadowVerdict(verdict, shadowRevision(draft)),
  status: "ok",
  created_at: at,
});

function paint(draft: unknown, rows: unknown[], since: string | null = "2026-08-07T10:00:00Z") {
  return renderToStaticMarkup(
    createElement(PolicyShadowPanel, {
      agentId: AGENT,
      shadow: toShadowState(draft, rows, since),
      liveConfigured: false,
    })
  );
}

const render = (rows: unknown[], since: string | null = "2026-08-07T10:00:00Z") =>
  paint(DRAFT, rows, since);

/** The text of the count tile with this data-state, digits included. */
function tile(html: string, state: string): string {
  const at = html.indexOf(`data-state="${state}"`);
  expect(at, `no tile for ${state}`).toBeGreaterThan(-1);
  return html.slice(at, at + 600).replace(/<[^>]*>/g, " ");
}

describe("the panel counts only what it can attribute", () => {
  it("counts a verdict stamped by the draft on display", () => {
    const html = render([stamped("deny:policy", DRAFT)]);

    expect(html).toContain('data-state="observed"');
    expect(tile(html, "would-block")).toMatch(/\b1\b/);
    // Attribution is stated, and it names the revision rather than only a date.
    expect(html).toContain('data-state="dated"');
    expect(html).toContain(shadowRevision(DRAFT)!.slice(0, 8));
  });

  /**
   * Finding 11, at the surface an operator promotes from. A verdict computed
   * from a DIFFERENT draft landed after this draft's save — a long stream, or a
   * policy-cache miss that began before the purge. Counting it puts another
   * draft's blocks under this one's name, and that is the number someone acts on.
   */
  it("does not show another draft's verdict as this draft's block", () => {
    const html = render([stamped("deny:policy", OTHER)]);

    expect(html).toContain('data-state="no-observations"');
    expect(html).not.toContain('data-state="would-block"');
  });

  it("does not show a verdict that carries no revision at all", () => {
    const html = render([
      { policy_shadow_would: "deny:policy", status: "ok", created_at: "2026-08-07T11:00:00Z" },
    ]);

    expect(html).toContain('data-state="no-observations"');
  });

  // Excluded is not the same as agreed, and the panel has to say which.
  it("says out loud when it excluded recorded attempts", () => {
    const html = render([stamped("allow", DRAFT), stamped("deny:policy", OTHER)]);

    expect(tile(html, "agreed")).toMatch(/\b1\b/);
    expect(html).toContain('data-state="unattributed"');
    expect(html).toMatch(/not counted above/i);
  });

  it("claims nothing was excluded only when nothing was", () => {
    const html = render([stamped("allow", DRAFT)]);
    expect(html).not.toContain('data-state="unattributed"');
  });

  // A malformed draft records "would block" on everything, which by the numbers
  // alone reads exactly like a draft that is working and blocking everything.
  it("suppresses the counts entirely while the draft is unreadable", () => {
    const html = paint("deny everything", [stamped("deny:policy", "deny everything")], null);

    expect(html).toContain('data-state="malformed"');
    expect(html).not.toContain('data-state="would-block"');
    // And offers no Promote button, because promoting it would deny every call.
    expect(html).not.toMatch(/Promote to live policy/);
  });

  it("renders shadow mode off as off, with nothing to promote", () => {
    const html = paint(null, [], null);

    expect(html).toContain('data-state="off"');
    expect(html).not.toMatch(/Promote to live policy/);
  });
});
