import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/recap", async () => ({
  ...await vi.importActual<typeof import("@/lib/recap")>("@/lib/recap"),
  readWeeklyRecap: (...args: unknown[]) => h.read(...args),
}));
import { WeeklyRecapCard } from "@/components/dashboard/WeeklyRecapCard";
import type { WeeklyRecap } from "@/lib/recap";

const period = { start: "2026-10-12T00:00:00.000Z", end: "2026-10-19T00:00:00.000Z", previousStart: "2026-10-05T00:00:00.000Z" };
const totals = { spentMicrocents: 350_000_000, previousSpentMicrocents: 200_000_000, calls: 8, refusedCalls: 2, pausedCalls: 1 };
const ready = (): WeeklyRecap => ({
  state: "ready", period, totals, moreAgents: 2, text: "same data, ready for Claude's delivery adapter",
  agents: [{ id: "a1", name: "Scout <script>", ...totals, topModels: [{ provider: "openai", model: "gpt-5-mini", calls: 5 }] }],
});
beforeEach(() => { vi.clearAllMocks(); h.read.mockResolvedValue(ready()); });
const html = async () => renderToStaticMarkup(await WeeklyRecapCard({ userId: "tenant-a", at: new Date("2026-10-22T12:00:00Z") }));

describe("WeeklyRecapCard", () => {
  it("reads once for the signed-in workspace and renders the same period and numbers", async () => {
    const out = await html();
    expect(h.read).toHaveBeenCalledExactlyOnceWith("tenant-a", new Date("2026-10-22T12:00:00Z"));
    expect(out).toContain("Weekly spend recap");
    expect(out).toContain("UTC");
    expect(out).toContain("2026-10-12");
    expect(out).toContain("2026-10-19");
    expect(out).toContain("$3.50");
    expect(out).toContain("$2.00");
    expect(out).toContain("2 refused");
    expect(out).toContain("1 paused");
    expect(out).toContain("gpt-5-mini");
    expect(out).toContain("and 2 more");
    expect(out).toContain('href="/dashboard/agents/a1"');
    expect(out).toContain("Scout &lt;script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("uses a single empty message instead of a zero table", async () => {
    h.read.mockResolvedValue({ state: "empty", period, totals: { ...totals, spentMicrocents: 0, calls: 0 }, agents: [], moreAgents: 0, text: "No activity this week (UTC)." });
    const out = await html();
    expect(out).toContain("No activity this week (UTC).");
    expect(out).not.toContain("$0.00");
    expect(out).not.toContain("<ol");
  });

  it("makes an unavailable read explicit, never an empty week or a dollar zero", async () => {
    h.read.mockResolvedValue({ state: "unavailable", period, text: null });
    const out = await html();
    expect(out).toMatch(/could not.*read/i);
    expect(out).not.toContain("$0.00");
    expect(out).not.toContain("No activity");
  });

  it("places the card on the overview with the authenticated tenant and shared render time", () => {
    const source = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");
    expect(source).toContain('<WeeklyRecapCard userId={user.id} at={renderedAt} />');
  });
});
