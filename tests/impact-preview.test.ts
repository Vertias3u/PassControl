import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  prospectiveAgentChange,
  prospectiveBreakGlassChange,
  prospectivePassportRotation,
} from "@/lib/impact-preview";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("prospective capability wording", () => {
  it("uses the capability-history scope vocabulary before save", () => {
    const change = prospectiveAgentChange(
      "allowed_scopes",
      [{ provider: "anthropic", models: ["claude-haiku-4-5"] }],
      [{ provider: "anthropic", models: ["claude-*"] }]
    );

    expect(change.summary).toBe("Scope changed.");
    expect(change.detail).toEqual(["anthropic: claude-haiku-4-5 → claude-*"]);
  });

  it("states the fallback order, because sequence changes routing", () => {
    const change = prospectiveAgentChange(
      "fallbacks",
      [
        { provider: "openai", model: "gpt-4.1-mini" },
        { provider: "anthropic", model: "claude-haiku-4-5" },
      ],
      [
        { provider: "anthropic", model: "claude-haiku-4-5" },
        { provider: "openai", model: "gpt-4.1-mini" },
      ]
    );

    expect(change.summary).toBe("Fallbacks changed.");
    expect(change.detail).toEqual([
      "order changed — now anthropic/claude-haiku-4-5, openai/gpt-4.1-mini",
    ]);
  });

  it("describes a shadow promotion as the draft beginning to decide calls", () => {
    const change = prospectiveAgentChange(
      "policy",
      null,
      {
        deny: [{ provider: "anthropic", models: ["claude-opus-*"] }],
        max_requests_per_hour: 20,
      },
      { promoted: true }
    );

    expect(change.summary).toBe("Draft policy promoted — it now decides calls.");
    expect(change.detail).toEqual(["deny rules: 0 → 1", "hourly cap: none → 20"]);
  });

  it("names the temporary scope and deadline of a break-glass grant", () => {
    const change = prospectiveBreakGlassChange(
      [{ provider: "openai", models: ["gpt-4.1-mini"] }],
      "2026-08-08T14:00:00.000Z",
      "incident 412"
    );

    expect(change.summary).toBe(
      "Break-glass elevation taken — this passport was widened beyond its stored capability."
    );
    expect(change.detail).toEqual([
      "openai — gpt-4.1-mini",
      "until 2026-08-08T14:00:00.000Z",
      "reason: incident 412",
    ]);
  });

  it("describes expiry before and after without losing the visa-tail distinction", () => {
    const change = prospectiveAgentChange(
      "expires_at",
      null,
      "2026-08-09T12:30:00.000Z"
    );

    expect(change.summary).toBe("Passport expiry added.");
    expect(change.detail).toEqual(["expiry: never → 09 Aug 2026, 12:30 UTC"]);
  });

  it("describes rotation and the window where both keys authenticate", () => {
    const change = prospectivePassportRotation("PCPUBLICKEY-abcdefghijklmnop", 3600);

    expect(change.summary).toBe("Passport key rotated.");
    expect(change.detail).toEqual([
      "public key: …efghijklmnop → new browser-generated key",
      "grace window: 1 hour — both keys authenticate during this window",
    ]);
  });
});

describe("impact preview placement and preserved security language", () => {
  const surfaces = [
    "components/ScopeEditor.tsx",
    "components/FallbackEditor.tsx",
    "components/PolicyShadowPanel.tsx",
    "components/BreakGlassPanel.tsx",
    "components/PassportLifecycle.tsx",
  ];

  it.each(surfaces)("renders the shared preview on %s", (file) => {
    expect(read(file)).toMatch(/<ImpactPreview/);
  });

  it("routes prospective wording through the capability-history summariser", () => {
    const helper = read("lib/impact-preview.ts");
    expect(helper).toMatch(/import\s*{[\s\S]*summariseChange[\s\S]*}\s*from\s*["']\.\/audit-history["']/);
    expect(helper).toContain("summariseChange(raw)");
  });

  it("keeps the existing warnings instead of replacing them with previews", () => {
    expect(read("components/ScopeEditor.tsx")).toContain(
      "Saving this leaves no scopes — this passport will reach nothing."
    );
    expect(read("components/FallbackEditor.tsx")).toContain("One call can be billed twice.");
    expect(read("components/PolicyShadowPanel.tsx")).toContain(
      "Promoting makes this exact draft the policy that decides calls"
    );
    expect(read("components/BreakGlassPanel.tsx")).toContain(
      "This widens scope. It does not widen anything else."
    );
    const lifecycle = read("components/PassportLifecycle.tsx");
    expect(lifecycle).toContain("Both keys authenticate until the window closes.");
    expect(lifecycle).toContain("I have stored the new private key securely");
  });

  it("places each preview before the warning whose decision it qualifies", () => {
    const before = (file: string, preview: string, warning: string) => {
      const source = read(file);
      expect(source.indexOf(preview)).toBeGreaterThanOrEqual(0);
      expect(source.indexOf(warning)).toBeGreaterThan(source.indexOf(preview));
    };

    before("components/ScopeEditor.tsx", 'title="Scope impact"', "Saving this leaves no scopes");
    before("components/FallbackEditor.tsx", 'title="Fallback-order impact"', "One call can be billed twice");
    before("components/PolicyShadowPanel.tsx", 'title="Live-policy impact"', "Promoting makes this exact draft");
    before("components/BreakGlassPanel.tsx", 'title="Temporary-scope impact"', "This widens scope");
    before("components/PassportLifecycle.tsx", 'title="Expiry impact"', "Checked when a visa is minted");
    before("components/PassportLifecycle.tsx", 'title="Rotation impact"', "Both keys authenticate until the window closes");
  });
});
