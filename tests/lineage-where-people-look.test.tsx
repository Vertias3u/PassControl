// Lineage where people look (sprint T5). 1.4.0 signs a call's declared session and
// sub-agent into its receipt (`ctx`) and stores them on the log row (`client_*`),
// but only `passcontrol verify receipt` showed them. The call drawer and the web
// verifier at /verify now show them too, in the CLI's words: the values are
// DECLARED by the client, and every place that shows them says so on the same
// line, so nobody reads them as passport-proven (trust boundary 1).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DepartureRow } from "@/lib/departures";
import { describeLineage } from "@/lib/verify/receipt-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const { CallDetailDrawer } = await import("@/components/dashboard/CallDetailDrawer");

describe("describeLineage", () => {
  it("words a main-agent call as the CLI does", () => {
    expect(describeLineage({ src: "declared", cli: "claude-code", ses: "7b1c-session" })).toEqual({
      session: "7b1c-session",
      who: "main agent",
      note: "declared by the client (claude-code), not verified",
    });
  });

  it("names a sub-agent and the agent that spawned it", () => {
    expect(describeLineage({ src: "declared", cli: "claude-code", ses: "s", agt: "a050", par: "p1" })!.who).toBe(
      "sub-agent a050, spawned by p1"
    );
    expect(describeLineage({ src: "declared", cli: "codex", ses: "s", agt: "a050" })!.who).toBe("sub-agent a050");
  });

  it("says unknown when no client kind was recorded", () => {
    expect(describeLineage({ ses: "s" })!.note).toBe("declared by the client (unknown), not verified");
  });

  it("is nothing for a receipt or row without a session", () => {
    for (const ctx of [undefined, null, {}, { agt: "a" }, { ses: "" }, { ses: 5 }, "ses", []]) {
      expect(describeLineage(ctx as never)).toBeNull();
    }
  });

  it("never passes control characters or long values through", () => {
    const view = describeLineage({ cli: "claude\u001b[31m-code", ses: `s\n${"x".repeat(500)}`, agt: "a\u0000" })!;
    expect(view.session).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(view.session.length).toBeLessThanOrEqual(128);
    expect(view.who).toBe("sub-agent a?");
    expect(view.note).not.toMatch(/\u001b/);
  });
});

const base: DepartureRow = {
  id: "row-1",
  agent_id: "7a000000-0000-4000-8000-0000000055a1",
  user_id: "u1",
  created_at: "2026-10-08T11:17:33.000Z",
  passport_id: "c3RhdHVzLWNoZWNr",
  jti: "jti-status",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  input_tokens: 10,
  output_tokens: 2,
  cost_microcents: 100,
  status: "ok",
  latency_ms: 431,
  receipt: null,
  policy_shadow_would: null,
};
const render = (row: DepartureRow) =>
  renderToStaticMarkup(<CallDetailDrawer row={row} open onOpenChange={() => {}} currentShadowRevision={null} />);

describe("the call drawer", () => {
  it("shows a sub-agent call's session and sub-agent, marked declared", () => {
    const html = render({ ...base, client_kind: "claude-code", client_session: "sess-42", client_agent: "a050", client_parent: null });
    expect(html).toContain("sess-42");
    expect(html).toContain("sub-agent a050");
    expect(html).toContain("declared by the client (claude-code), not verified");
    expect(html).toContain('data-lineage="declared"');
  });

  it("shows a main-agent call as the main agent", () => {
    const html = render({ ...base, client_kind: "codex", client_session: "sess-7" });
    expect(html).toContain("main agent");
  });

  it("renders a call without lineage exactly as before", () => {
    const html = render(base);
    expect(html).not.toContain("data-lineage");
    expect(html).not.toContain("declared by the client");
  });
});

describe("the queries that feed the drawer read the lineage columns", () => {
  it.each(["app/dashboard/page.tsx", "app/dashboard/graph/page.tsx", "components/DeparturesBoard.tsx"])("%s", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/client_kind, client_session, client_agent, client_parent/);
  });
});

describe("the web verifier", () => {
  it("shows a receipt's ctx through describeLineage", () => {
    const src = readFileSync("components/ReceiptVerifier.tsx", "utf8");
    expect(src).toContain("describeLineage(claims.ctx)");
    expect(src).toContain('data-lineage="declared"');
  });
});
