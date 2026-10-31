// Injection guard Phase 2: the agent page's hold status and the owner's Clear.
// It says what is held and until when, never what was found (the findings table below
// it has the families, and no text was ever stored).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/dashboard/agents/[id]/injection-actions", () => ({ clearInjectionTaint: vi.fn() }));

import { InjectionTaintControl } from "@/components/InjectionTaintControl";

const AGENT = "11111111-1111-4111-8111-111111111111";
const render = (taint: Parameters<typeof InjectionTaintControl>[0]["taint"]) =>
  renderToStaticMarkup(<InjectionTaintControl agentId={AGENT} taint={taint} />);

describe("InjectionTaintControl", () => {
  it("tainted: says risky actions wait for the owner until when, and offers Clear", () => {
    const html = render({ state: "tainted", until: "2026-10-30T12:30:00.000Z" });
    expect(html).toContain('data-taint-state="tainted"');
    expect(html).toMatch(/wait for you/);
    // Claude Code's tools are held only where the sidecar's tool hook is installed.
    expect(html).toMatch(/service writes/);
    expect(html).toMatch(/tool hook is installed/);
    expect(html).toMatch(/Clear the hold/);
    expect(html).not.toMatch(/instruction_override|exfil/);
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
