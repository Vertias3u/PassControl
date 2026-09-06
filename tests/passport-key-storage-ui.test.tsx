// What the panel is allowed to claim.
//
// Nothing on this surface was checked by anything. The gateway cannot verify a
// key-storage claim — see research/passport-key-protection.md §4 — so every
// state has to read as a report from the agent, and the one state that means
// "we have heard nothing" must never render as the weakest tier.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KeyStoragePanel } from "@/components/KeyStoragePanel";
import { toDeclaredKeyStorageView } from "@/lib/passport-key-storage";

const AT = "2026-09-01T10:00:00.000Z";

const render = (
  declaration: Parameters<typeof toDeclaredKeyStorageView>[0],
  latestActivityAt: string | null = null,
  expectation: string | null = null
) =>
  renderToStaticMarkup(
    <KeyStoragePanel
      view={toDeclaredKeyStorageView(declaration, latestActivityAt)}
      expectation={expectation}
    />
  );

describe("the declared key-storage panel", () => {
  it("marks a tier 1 declaration as declared and unverified", () => {
    const html = render({ store: "os", fallback: false, declaredAt: AT });
    expect(html).toContain('data-key-storage="os"');
    expect(html).toMatch(/Tier 1/);
    expect(html).toMatch(/Declared/i);
    // The exact sentence can change; the claim it makes cannot.
    expect(html).toMatch(/cannot (check|verify)/i);
    expect(html).not.toMatch(/verified/i);
  });

  it("names the command that changes it", () => {
    const html = render({ store: "file", fallback: false, declaredAt: AT });
    expect(html).toContain('data-key-storage="file"');
    expect(html).toMatch(/Tier 0/);
    expect(html).toContain("passcontrol key migrate");
  });

  // The operator configured tier 1 and is not on it.
  it("warns when the agent fell back to the file", () => {
    const html = render({ store: "file", fallback: true, declaredAt: AT });
    expect(html).toContain('data-key-storage="file"');
    expect(html).toMatch(/fell back|fall back/i);
  });

  it("says plainly that it has heard nothing, and does not call that tier 0", () => {
    const html = render(null);
    expect(html).toContain('data-key-storage="undeclared"');
    expect(html).not.toMatch(/Tier 0/);
    expect(html).not.toMatch(/Tier 1/);
    // An operator reading this needs to know silence has several causes.
    expect(html).toMatch(/older|has not|hasn't|no visa|not declared/i);
  });

  it("admits when a store name is newer than this dashboard", () => {
    const html = render({ store: "enclave", fallback: false, declaredAt: AT });
    expect(html).toContain('data-key-storage="unknown"');
    expect(html).toContain("enclave");
    expect(html).not.toMatch(/Tier 0/);
    // And does NOT tell that operator to migrate. The agent is on a tier this
    // build has never heard of; "move your file key into the OS credential
    // store" is a downgrade instruction, confidently given about a state this
    // dashboard has just admitted it cannot read.
    expect(html).not.toContain("passcontrol key migrate");
    expect(html).toContain("passcontrol key status");
  });

  it("says when the agent has authenticated since without declaring", () => {
    const html = render({ store: "os", fallback: false, declaredAt: AT }, "2026-09-01T18:00:00.000Z");
    expect(html).toContain('data-key-storage="os"');
    expect(html).toMatch(/since/i);
  });
});

// The same comparison the fleet table makes, on the page that explains it. Both
// have to agree — one fact with two answers in one product is the defect this
// dashboard has already been bitten by (app/dashboard/page.tsx:119).
describe("the panel against a stated workspace expectation", () => {
  it("says nothing when no expectation was stated", () => {
    const html = render({ store: "file", fallback: false, declaredAt: AT });
    expect(html).not.toMatch(/expectation/i);
  });

  it("says the agent falls short, and says who claimed what", () => {
    const html = render({ store: "file", fallback: false, declaredAt: AT }, null, "os");
    expect(html).toContain('data-expectation-verdict="short"');
    expect(html).toMatch(/below/i);
    // Never an accusation: the thing being compared is a self-report.
    expect(html).not.toMatch(/violation|non-compliant|breach/i);
  });

  it("confirms an agent that meets it without claiming it was checked", () => {
    const html = render({ store: "os", fallback: false, declaredAt: AT }, null, "os");
    expect(html).toContain('data-expectation-verdict="meets"');
    expect(html).toMatch(/declared/i);
    expect(html).not.toMatch(/\bverified\b/i);
  });

  it("refuses to call silence a shortfall", () => {
    const html = render(null, null, "os");
    expect(html).toContain('data-expectation-verdict="unknown"');
    expect(html).not.toMatch(/below/i);
  });
});
