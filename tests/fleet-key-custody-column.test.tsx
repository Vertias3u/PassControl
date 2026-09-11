// The custody line on the fleet table.
//
// Same rule as the agent panel, under harder conditions: a table is scanned,
// not read, so every state has to survive being reduced to a few words. The two
// that must not blur into each other are "this agent has declared nothing" and
// "this agent has no passport private key at all" — one is silence, the other is
// a question that was never asked.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/actions", () => ({
  setAgentSuspended: vi.fn(),
  updateAgentBudgets: vi.fn(),
  updateAgentScopes: vi.fn(),
}));

import { AgentFleetTable } from "@/components/AgentFleetTable";
import { toDeclaredKeyStorageView } from "@/lib/passport-key-storage";

const AT = "2026-09-01T10:00:00.000Z";

function agent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `agent-${id}`,
    passport_pubkey: `pk_${id}`,
    status: "active",
    budget_tokens: null,
    budget_cents: null,
    spent_tokens: 0,
    spent_microcents: 0,
    last_seen_at: AT,
    allowed_scopes: [],
    ...overrides,
  };
}

const view = (store: string | null, fallback = false) =>
  toDeclaredKeyStorageView(store ? { store, fallback, declaredAt: AT } : null, null);

function render(
  agents: ReturnType<typeof agent>[],
  keyCustody: Record<string, ReturnType<typeof view>>,
  expectation: string | null = null
) {
  return renderToStaticMarkup(
    <AgentFleetTable
      agents={agents as never}
      visaTtlSeconds={900}
      keyCustody={keyCustody}
      keyCustodyExpectation={expectation}
      logsAvailable
    />
  );
}

describe("the fleet table's declared custody column", () => {
  it("labels the column as declared, so no cell has to carry the caveat alone", () => {
    const html = render([agent("a")], { a: view("os") });
    expect(html).toMatch(/Key custody \(declared\)/);
  });

  it("names the tier for each store it knows", () => {
    const html = render([agent("a"), agent("b")], { a: view("os"), b: view("file") });
    expect(html).toContain('data-key-storage="os"');
    expect(html).toContain('data-key-storage="file"');
    expect(html).toMatch(/Tier 1/);
    expect(html).toMatch(/Tier 0/);
  });

  // Silence is not tier 0. It is the state the whole feature exists to keep
  // separate from tier 0.
  it("shows an agent that has declared nothing as having declared nothing", () => {
    const html = render([agent("a")], { a: view(null) });
    expect(html).toContain('data-key-storage="undeclared"');
    expect(html).toMatch(/Not declared/);
    expect(html).not.toMatch(/Tier 0/);
  });

  // A Direct Agent Key is a bearer credential. There is no passport private key
  // to keep anywhere, so "no custody claim recorded" would be an answer to a
  // question nobody asked.
  it("does not ask a Direct Agent Key where it keeps a key it has not got", () => {
    const html = render([agent("a", { passport_pubkey: null })], {});
    expect(html).toContain('data-key-storage="not-applicable"');
    expect(html).not.toMatch(/Not declared/);
  });

  it("surfaces the agent that meant to be on tier 1 and is not", () => {
    const html = render([agent("a")], { a: view("file", true) });
    expect(html).toMatch(/fell back/i);
  });

  // The panel already carries the long explanation; the table must not repeat a
  // tier claim it cannot name.
  it("keeps an unrecognised store unrecognised", () => {
    const html = render([agent("a")], { a: view("enclave") });
    expect(html).toContain('data-key-storage="unknown"');
    expect(html).toMatch(/Unrecognised/i);
    expect(html).not.toMatch(/Tier 0/);
  });
});

describe("the workspace expectation, seen from the fleet table", () => {
  it("says nothing about an expectation nobody stated", () => {
    const html = render([agent("a")], { a: view("file") }, null);
    expect(html).not.toMatch(/expectation/i);
  });

  it("marks the agent that falls short of the stated expectation", () => {
    const html = render([agent("a")], { a: view("file") }, "os");
    expect(html).toMatch(/below the workspace expectation/i);
  });

  it("says nothing about an agent that meets it", () => {
    const html = render([agent("a")], { a: view("os") }, "os");
    expect(html).not.toMatch(/below the workspace expectation/i);
  });

  // Undeclared is not a violation, and a tier newer than this build is not one
  // either. Marking either would turn "we have not heard" into an accusation.
  it("never marks silence or a newer tier as a shortfall", () => {
    expect(render([agent("a")], { a: view(null) }, "os")).not.toMatch(
      /below the workspace expectation/i
    );
    expect(render([agent("a")], { a: view("enclave") }, "os")).not.toMatch(
      /below the workspace expectation/i
    );
  });

  // The cell has room for one secondary line. A fallback is a live
  // misconfiguration on that machine; the shortfall is its consequence.
  it("leads with the fallback rather than repeating it as a shortfall", () => {
    const html = render([agent("a")], { a: view("file", true) }, "os");
    expect(html).toMatch(/fell back/i);
    expect(html).not.toMatch(/below the workspace expectation/i);
  });
});
