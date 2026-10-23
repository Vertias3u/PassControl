// The agent page's soft-pause panel (1.6.0, L4), including the configured switch.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/dashboard/agents/[id]/pause-actions", () => ({ setAgentPauseLift: vi.fn() }));

import { AgentPauseControl } from "@/components/AgentPauseControl";

const AGENT = "11111111-1111-4111-8111-111111111111";
const render = (props: Partial<Parameters<typeof AgentPauseControl>[0]>) =>
  renderToStaticMarkup(
    <AgentPauseControl agentId={AGENT} percent={80} reached={null} liftedUntil={null} liftUnknown={false} {...props} />
  );

describe("AgentPauseControl", () => {
  it("below the line: says where it pauses, and offers nothing to press", () => {
    const html = render({});
    expect(html).toContain('data-pause-state="below"');
    expect(html).toContain("Pauses at 80% of its limits");
    expect(html).not.toContain("<button");
  });

  it("paused: says what was reached, in the calm tone, and offers to let it go on", () => {
    const html = render({ reached: "today's spend is 82% of its limit ($16.40 of $20.00)" });
    expect(html).toContain('data-pause-state="paused"');
    expect(html).toContain("Paused at its 80% line");
    expect(html).toContain("Today&#x27;s spend is 82% of its limit ($16.40 of $20.00). The limit itself still applies.");
    expect(html).toContain("Let it go on for an hour");
    expect(html).toContain("var(--pc-calm");
    expect(html).not.toContain("var(--danger)");
  });

  it("lifted: says until when, and offers to keep it paused", () => {
    const html = render({ reached: "today's spend is 82% of its limit ($16.40 of $20.00)", liftedUntil: "2026-10-22T13:00:00.000Z" });
    expect(html).toContain('data-pause-state="lifted"');
    expect(html).toMatch(/Going on until .+, past its 80% line/);
    expect(html).toContain("Keep paused");
  });

  it("says a pause it could not check holds", () => {
    expect(render({ reached: "today's spend is 82% of its limit ($16.40 of $20.00)", liftUnknown: true })).toContain(
      "could not be checked just now, so it holds"
    );
  });
});

describe("AgentPauseControl with a configured switch (UI-01)", () => {
  const switchTo = { provider: "openai", model: "gpt-5-nano" };
  const reached = "its token use is 85% of its limit (850 of 1,000 tokens)";

  it("past the line: names the continuing provider/model and other-provider pause, calmly", () => {
    const html = render({ reached, switchTo });
    expect(html).toContain('data-pause-state="switched"');
    expect(html).toContain("openai carries on with gpt-5-nano past its 80% line; other providers are paused");
    expect(html).not.toContain("Paused at its 80% line");
    expect(html).toContain("Let it go on for an hour");
    expect(html).toContain("border-color:var(--pc-calm");
    expect(html).toContain("color:var(--pc-calm");
    expect(html).not.toContain("var(--danger)");
  });

  it("an active lift takes precedence over the switch and still offers Keep paused", () => {
    const html = render({ reached, switchTo, liftedUntil: "2026-10-22T13:00:00.000Z" });
    expect(html).toContain('data-pause-state="lifted"');
    expect(html).toMatch(/Going on until .+, past its 80% line/);
    expect(html).toContain("Keep paused");
    expect(html).not.toContain("other providers are paused");
  });

  it("does not claim the switch is active below the line", () => {
    const html = render({ switchTo });
    expect(html).toContain('data-pause-state="below"');
    expect(html).not.toContain("carries on");
    expect(html).not.toContain("<button");
  });

  it("keeps the configured switch state when the lift cannot be read", () => {
    const html = render({ reached, switchTo, liftUnknown: true });
    expect(html).toContain('data-pause-state="switched"');
    expect(html).toContain("other providers are paused");
    expect(html).not.toContain("so it holds");
  });
});
