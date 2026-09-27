// "Write a draft policy" starts from the LIVE policy, not from an empty form.
// Owner decision 2026-09-27. An empty start meant a draft written to add one rule
// (say a K2 output ceiling) silently dropped every other live rule when promoted:
// the Session 08 journeys replaced a live `max_requests_per_hour` exactly that way.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { initialDraft, PolicyShadowPanel, toDraft, toPolicy } from "@/components/PolicyShadowPanel";
import { toShadowState } from "@/lib/policy-shadow";

const LIVE = {
  deny: [{ provider: "openai", models: ["gpt-5-pro"] }],
  windows: [{ days: ["mon", "tue"], start: "09:00", end: "17:00", tz: "UTC" }],
  max_requests_per_hour: 1000,
  max_output_tokens: 30,
};

describe("initialDraft", () => {
  it("starts from the live policy when there is no draft", () => {
    expect(initialDraft(null, LIVE, true)).toEqual(toDraft(LIVE));
  });

  it("round-trips the live policy unchanged, so promoting an untouched draft changes nothing", () => {
    expect(toPolicy(initialDraft(null, LIVE, true))).toEqual(LIVE);
  });

  it("keeps an existing draft over the live policy", () => {
    const draft = { max_requests_per_hour: 5 };
    expect(initialDraft(draft, LIVE, true)).toEqual(toDraft(draft));
  });

  it("is empty when there is neither", () => {
    expect(toPolicy(initialDraft(null, null, true))).toBeNull();
  });
});

describe("the panel says where a new draft starts", () => {
  const paint = (livePolicy: unknown, liveConfigured: boolean) =>
    renderToStaticMarkup(
      createElement(PolicyShadowPanel, {
        agentId: "22222222-2222-2222-2222-222222222222",
        shadow: toShadowState(null, [], null),
        liveConfigured,
        liveReadable: liveConfigured,
        livePolicy,
      })
    );

  it("offers to start from the live policy when one is configured", () => {
    expect(paint(LIVE, true)).toContain("Write a draft from the live policy");
  });

  it("keeps the plain label when there is no live policy", () => {
    const html = paint(null, false);
    expect(html).toContain("Write a draft policy");
    expect(html).not.toContain("from the live policy");
  });
});

// A stored policy can be CONFIGURED but not READABLE (an unknown key, a bad
// window): the gateway reads it as policy:malformed and denies every call. The
// form must not claim to start "from the live policy" when it can only copy the
// readable pieces — promoting that partial copy would silently drop the rest.
describe("an unreadable live policy", () => {
  const MALFORMED = { max_requests_per_hour: 10, surprise: true };

  it("does not seed the draft", () => {
    expect(toPolicy(initialDraft(null, MALFORMED, false))).toBeNull();
  });

  it("does not claim to start from it", () => {
    const html = renderToStaticMarkup(
      createElement(PolicyShadowPanel, {
        agentId: "22222222-2222-2222-2222-222222222222",
        shadow: toShadowState(null, [], null),
        liveConfigured: true,
        liveReadable: false,
        livePolicy: MALFORMED,
      })
    );
    expect(html).toContain("Write a draft policy");
    expect(html).not.toContain("from the live policy");
  });
});
