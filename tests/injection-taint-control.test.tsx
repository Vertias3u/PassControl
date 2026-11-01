// Injection guard Phase 2: the agent page's hold status and the owner's Clear.
// It says what is held and until when, never what was found (the findings table below
// it has the families, and no text was ever stored).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/dashboard/agents/[id]/injection-actions", () => ({ clearInjectionTaint: vi.fn() }));

const taintRead = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/state/taint", () => ({ readTaint: async () => taintRead.value }));

import { InjectionTaintControl } from "@/components/InjectionTaintControl";
import { readInjectionTaintView } from "@/app/dashboard/agents/[id]/injection-data";

const AGENT = "11111111-1111-4111-8111-111111111111";
const render = (taint: Parameters<typeof InjectionTaintControl>[0]["taint"]) =>
  renderToStaticMarkup(<InjectionTaintControl agentId={AGENT} taint={taint} />);

describe("InjectionTaintControl", () => {
  // Clear must wait for React to attach its handler so an early click is not lost (F4).
  it("disables Clear in the server-rendered markup until mounted", () => {
    const html = render({ state: "tainted", until: "2026-10-30T12:30:00.000Z" });
    expect(html).toMatch(/<button\b[^>]*\bdisabled=""[^>]*>Clear the hold<\/button>/);
  });

  it("tainted: says risky actions wait for the owner until when, and offers Clear", () => {
    const html = render({ state: "tainted", until: "2026-10-30T12:30:00.000Z" });
    expect(html).toContain('data-taint-state="tainted"');
    expect(html).toMatch(/wait for you/);
    // Claude Code's tools are held only where the sidecar's tool hook is installed.
    expect(html).toMatch(/service writes/);
    expect(html).toMatch(/tool hook is installed/);
    // 1.7.1 (P8): the local hold is best effort, and says so.
    expect(html).toMatch(/go ahead with a warning if the sidecar or the dashboard cannot answer in time/);
    expect(html).toMatch(/Clear the hold/);
    expect(html).not.toMatch(/instruction_override|exfil/);
  });

  // 1.7.1: a hold only for output that could not be fully checked must not claim a tell.
  it("tainted, unchecked only: says the output could not be fully checked, and offers Clear", () => {
    const html = render({ state: "tainted", until: "2026-10-30T12:30:00.000Z", unchecked: true });
    expect(html).toMatch(/could not fully check/);
    expect(html).not.toMatch(/prompt injection/);
    expect(html).toMatch(/Clear the hold/);
  });

  // The server's clock zone is not the owner's: a time formatted on the server failed
  // hydration in the browser, and Clear stayed dead until React rebuilt the tree.
  it("tainted: the server markup does not depend on the server's time zone", () => {
    const taint = { state: "tainted", until: "2026-10-30T12:30:00.000Z" } as const;
    const was = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utc = render(taint);
      process.env.TZ = "Asia/Tokyo";
      const tokyo = render(taint);
      expect(tokyo).toBe(utc);
      expect(utc).toContain('dateTime="2026-10-30T12:30:00.000Z"');
    } finally {
      process.env.TZ = was;
    }
  });

  it("clear: says what would happen, and offers nothing to press", () => {
    const html = render({ state: "clear" });
    expect(html).toContain('data-taint-state="clear"');
    expect(html).toMatch(/strong finding/);
    expect(html).not.toMatch(/<button/);
  });

  it("unknown: says the hold could not be checked, so the gateway holds writes", () => {
    const html = render({ state: "unknown" });
    expect(html).toContain('data-taint-state="unknown"');
    expect(html).toMatch(/could not be checked/);
    expect(html).not.toMatch(/<button/);
  });
});

describe("readInjectionTaintView", () => {
  it("marks a hold with no tell as unchecked, and a hold with one as not", async () => {
    const until = Date.UTC(2026, 9, 31, 13);
    taintRead.value = { since: until - 1, until, families: [], incomplete: true, surface: "sidecar" };
    expect(await readInjectionTaintView(AGENT, until - 1)).toEqual({ state: "tainted", until: new Date(until).toISOString(), unchecked: true });
    taintRead.value = { since: until - 1, until, families: ["role_markup"], incomplete: true, surface: "sidecar" };
    expect(await readInjectionTaintView(AGENT, until - 1)).toEqual({ state: "tainted", until: new Date(until).toISOString() });
  });
});
