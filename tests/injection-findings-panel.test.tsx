// The agent page's "Injected instructions" section (plans/injection-guard.md Phase 1;
// migration 0089): what the injection guard recorded for this agent.
//
// What must never happen on this panel: a finding reading as a refusal (monitor mode
// refuses nothing), a tell reading as proof, or the page breaking on a database before
// 0089. It has no text of the block to show, and must not pretend to.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/dashboard/agents/[id]/injection-actions", () => ({ clearInjectionTaint: vi.fn() }));

const { InjectionFindingsPanel, familyLabel } = await import("@/components/InjectionFindingsPanel");
const { readInjectionFindings } = await import("@/app/dashboard/agents/[id]/injection-data");

const AGENT = "11111111-1111-4111-8111-111111111111";

const row = (over: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  created_at: "2026-10-27T19:00:00.000Z",
  source: "tool_result",
  path: "messages[2].content[0].content",
  families: ["instruction_override", "exfil_directive"],
  severity: "high",
  detector: "pc-heuristic-1",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  ...over,
});

describe("InjectionFindingsPanel", () => {
  it("lists a finding: when, which block, which tells, how strong, and by which detector", () => {
    const html = renderToStaticMarkup(<InjectionFindingsPanel read={{ state: "ok", rows: [row()] }} enabled />);
    expect(html).toContain('id="agent-injection"');
    expect(html).toContain('data-state="ok"');
    expect(html).toContain("2026-10-27 19:00:00 UTC");
    expect(html).toContain("Tool result");
    expect(html).toContain("messages[2].content[0].content");
    expect(html).toContain(familyLabel("instruction_override"));
    expect(html).toContain(familyLabel("exfil_directive"));
    expect(html).toContain('data-severity="high"');
    expect(html).toContain("pc-heuristic-1");
  });

  it("says plainly that nothing was refused, that a tell is not proof, and that no text was kept", () => {
    const html = renderToStaticMarkup(<InjectionFindingsPanel read={{ state: "ok", rows: [row()] }} enabled />).toLowerCase();
    expect(html).toContain("nothing was refused");
    expect(html).toContain("possible injection tells");
    expect(html).toContain("no finding does not mean the text is safe");
    expect(html).toContain("not proof");
    expect(html).toContain("never stored");
    expect(html).not.toMatch(/blocked|denied/);
  });

  it("guard on, nothing found yet: says so", () => {
    const html = renderToStaticMarkup(<InjectionFindingsPanel read={{ state: "ok", rows: [] }} enabled />);
    expect(html).toContain('data-state="empty"');
  });

  it("guard off and nothing recorded: no section at all", () => {
    expect(renderToStaticMarkup(<InjectionFindingsPanel read={{ state: "ok", rows: [] }} enabled={false} />)).toBe("");
  });

  it("guard off with older rows: still lists them", () => {
    const html = renderToStaticMarkup(<InjectionFindingsPanel read={{ state: "ok", rows: [row()] }} enabled={false} />);
    expect(html).toContain('data-state="ok"');
  });

  it("a database before 0089 with the guard on: says the records are not available", () => {
    const html = renderToStaticMarkup(<InjectionFindingsPanel read={{ state: "unavailable" }} enabled />);
    expect(html).toContain('data-state="unavailable"');
  });

  it("an unknown family or source is shown as itself, not dropped", () => {
    const html = renderToStaticMarkup(
      <InjectionFindingsPanel read={{ state: "ok", rows: [row({ families: ["some_future_family"], source: "new_block" })] }} enabled />
    );
    expect(html).toContain("some_future_family");
    expect(html).toContain("new_block");
  });
});

describe("readInjectionFindings", () => {
  type Call = [string, ...unknown[]];
  function client(result: { data: unknown; error: unknown }) {
    const calls: Call[] = [];
    const q: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["select", "eq", "order"]) q[m] = (...a: unknown[]) => (calls.push([m, ...a]), q);
    q.limit = (...a: unknown[]) => (calls.push(["limit", ...a]), Promise.resolve(result));
    return { db: { from: (t: string) => (calls.push(["from", t]), q) }, calls };
  }

  it("reads this agent's newest findings through the user's own client (RLS)", async () => {
    const { db, calls } = client({ data: [row()], error: null });
    expect(await readInjectionFindings(db, AGENT)).toEqual({ state: "ok", rows: [row()] });
    expect(calls).toContainEqual(["from", "injection_findings"]);
    expect(calls).toContainEqual(["eq", "agent_id", AGENT]);
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(calls.find((c) => c[0] === "select")?.[1]).not.toContain("content_hmac");
  });

  it("any failed read is unavailable, never a thrown page", async () => {
    expect(await readInjectionFindings(client({ data: null, error: { code: "42P01" } }).db, AGENT)).toEqual({ state: "unavailable" });
    const throwing = { from: () => { throw new Error("boom"); } };
    expect(await readInjectionFindings(throwing, AGENT)).toEqual({ state: "unavailable" });
  });
});

// Phase 2 (owner, 2026-10-30): in hold mode the panel shows the hold, and must not
// claim "recorded only": a strong finding does hold the agent's risky actions.
describe("InjectionFindingsPanel in hold mode", () => {
  const AGENT = "11111111-1111-4111-8111-111111111111";
  it("shows the hold and its Clear, and does not say nothing was refused", () => {
    const html = renderToStaticMarkup(
      <InjectionFindingsPanel
        read={{ state: "ok", rows: [row()] }}
        enabled
        hold={{ agentId: AGENT, taint: { state: "tainted", until: "2026-10-30T12:30:00.000Z" } }}
      />
    ).toLowerCase();
    expect(html).toContain('data-taint-state="tainted"');
    expect(html).toContain("clear the hold");
    expect(html).not.toContain("nothing was refused");
    expect(html).toContain("not proof");
    expect(html).toContain("tool hook is installed");
    // 1.7.1 (P8): the local hold is best effort, and says so; a gap holds too.
    expect(html).toMatch(/go ahead with a warning if the sidecar or the dashboard cannot answer in time/);
    expect(html).toMatch(/could not be fully checked/);
  });

  it("monitor mode: no hold box", () => {
    const html = renderToStaticMarkup(<InjectionFindingsPanel read={{ state: "ok", rows: [row()] }} enabled />);
    expect(html).not.toContain("data-taint-state");
  });

  it("names the tool and the sidecar for a row the sidecar reported", () => {
    const html = renderToStaticMarkup(
      <InjectionFindingsPanel read={{ state: "ok", rows: [row({ surface: "sidecar", tool_name: "Read", provider: null, model: null })] }} enabled />
    );
    expect(html).toContain("Read");
    expect(html).toMatch(/on the agent&#x27;s machine|on the agent's machine/);
  });
});

describe("readInjectionFindings and 0090's columns", () => {
  const chain = (results: { data: unknown; error: unknown }[], seen: string[]) => {
    const q: Record<string, unknown> = {};
    q.select = (c: string) => (seen.push(c), q);
    q.eq = () => q;
    q.order = () => q;
    q.limit = async () => results.shift();
    return { from: () => q };
  };

  it("reads the tool and surface", async () => {
    const seen: string[] = [];
    const out = await readInjectionFindings(chain([{ data: [], error: null }], seen), "a");
    expect(out).toEqual({ state: "ok", rows: [] });
    expect(seen[0]).toContain("tool_name");
    expect(seen[0]).toContain("surface");
  });

  it("falls back to 0089's columns on a database before 0090", async () => {
    const seen: string[] = [];
    // It refuses 0091's columns and 0090's before 0089's are read.
    const missing = { data: null, error: { code: "42703" } };
    const out = await readInjectionFindings(chain([missing, missing, { data: [row()], error: null }], seen), "a");
    expect(out.state).toBe("ok");
    expect(seen[2]).not.toContain("tool_name");
  });
});

// 1.7.1: output the guard could not fully check is listed as that, never as a tell, and
// never as clean.
describe("InjectionFindingsPanel and 0091's gaps", () => {
  it.each([
    ["too_large", "Too large to check"],
    ["scan_failed", "The check failed"],
    ["too_many_blocks", "Too many blocks to check"],
    ["too_deep", "Nested too deep to check"],
  ])("a %s row reads as not fully checked, with why", (gap, why) => {
    const html = renderToStaticMarkup(
      <InjectionFindingsPanel read={{ state: "ok", rows: [row({ severity: "incomplete", families: [], gap, source: "request", path: "body" })] }} enabled />
    );
    expect(html).toContain('data-severity="incomplete"');
    expect(html).toContain("Not fully checked");
    expect(html).toContain(why);
    expect(html).not.toContain(">Weak<");
  });

  it("reads the gap, and falls back a column at a time on older databases", async () => {
    const chain = (results: { data: unknown; error: unknown }[], seen: string[]) => {
      const q: Record<string, unknown> = {};
      q.select = (c: string) => (seen.push(c), q);
      q.eq = () => q;
      q.order = () => q;
      q.limit = async () => results.shift();
      return { from: () => q };
    };
    const seen: string[] = [];
    await readInjectionFindings(chain([{ data: [], error: null }], seen), "a");
    expect(seen[0]).toContain("gap");
    const older: string[] = [];
    const out = await readInjectionFindings(
      chain([{ data: null, error: { code: "42703" } }, { data: null, error: { code: "42703" } }, { data: [row()], error: null }], older),
      "a"
    );
    expect(out.state).toBe("ok");
    expect(older[1]).toContain("tool_name");
    expect(older[1]).not.toContain("gap");
    expect(older[2]).not.toContain("tool_name");
  });
});
