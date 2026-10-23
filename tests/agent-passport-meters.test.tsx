import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentPassport, type PassportAccent } from "@/components/AgentPassport";
import { buildAgentPassportView } from "@/app/dashboard/agents/[id]/passport-data";

vi.mock("@/components/ScopeEditor", () => ({ ScopeEditor: () => null }));
vi.mock("@/components/FallbackEditor", () => ({ FallbackEditor: () => null }));
vi.mock("@/components/CapabilityHistory", () => ({ CapabilityHistory: () => null }));
vi.mock("@/components/DirectAgentIdentity", () => ({ DirectAgentIdentity: () => null }));

const palettes: Array<[PassportAccent, string]> = [["sky", "#939ba0"]];

function passportSvg(used: number, cap: number | null, accent: PassportAccent): string {
  const passport = buildAgentPassportView({
    id: "a0000000-0000-4000-8000-000000000001", name: "Meter sample",
    passport_pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "active",
    budget_tokens: cap, budget_cents: cap, spent_tokens: used,
    spent_microcents: used * 1_000_000, allowed_scopes: [],
    created_at: "2026-10-01T00:00:00Z", last_seen_at: null,
  }, []);
  const html = renderToStaticMarkup(<AgentPassport passport={passport} visaTtlSeconds={300} accent={accent} />);
  const svg = html.match(/<svg[^>]*data-passport-svg="export"[\s\S]*?<\/svg>/)?.[0];
  expect(svg).toBeDefined();
  return svg!;
}

const gauges = (svg: string) => [...svg.matchAll(/<g><text[^>]*>(?:TOKEN|COST) CAP · CUMULATIVE<\/text>[\s\S]*?<\/g>/g)].map((match) => match[0]);

for (const [accent, neutral] of palettes) describe(`${accent} exported passport budget meters`, () => {
  it.each([[74, neutral], [75, "#f59e0b"], [100, "#8b93d9"], [125, "#8b93d9"]] as const)("uses the C3 colour at %i%% with export-safe literal fills", (used, color) => {
    const groups = gauges(passportSvg(used, 100, accent));
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const rects = [...group.matchAll(/<rect[^>]*fill="([^"]+)"/g)];
      expect(rects).toHaveLength(2);
      expect(rects[1]?.[1]).toBe(color);
      expect(group).toContain(`text-anchor="end" fill="${color}"`);
      expect(group).not.toMatch(/var\(--/);
    }
  });

  it("keeps unlimited meters without any track or coloured fill", () => {
    const groups = gauges(passportSvg(150, null, accent));
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).toContain("UNLIMITED");
      expect(group).not.toContain("<rect");
    }
  });
});
