// Listing one agent publicly.
//
// The property worth testing is the one 0015 spends a paragraph on: an internal
// agent name is customer-identifying, so `acme-prod-billing` must never reach a
// public page. 0033 encodes that as a NOT NULL-ish check constraint; this layer
// has to refuse it first, because a 23514 reaching the operator reads as
// "something went wrong" rather than "give it a public name".
import { beforeEach, describe, expect, it } from "vitest";

import { PUBLIC_LABEL_MAX_LENGTH, setAgentPublished } from "@/lib/profile/publish";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";

let patches: Record<string, unknown>[] = [];
let filters: [string, unknown][] = [];
let result: { data: unknown; error: unknown };

function db() {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    update: (patch: unknown) => {
      patches.push(patch as Record<string, unknown>);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    select: () => builder,
    maybeSingle: async () => result,
  });
  return { from: () => builder } as never;
}

const ROW = { id: AGENT_ID, name: "acme-prod-billing", published: true, public_label: "Research Agent" };

beforeEach(() => {
  patches = [];
  filters = [];
  result = { data: ROW, error: null };
});

describe("publishing", () => {
  it("writes the label and the flag together", async () => {
    const out = await setAgentPublished(db(), USER_ID, AGENT_ID, {
      published: true,
      label: "  Research Agent  ",
    });
    expect(out.ok).toBe(true);
    expect(patches[0]).toEqual({ published: true, public_label: "Research Agent" });
  });

  // The one that matters. Without it the first click is a 23514 that nothing
  // maps, and the obvious "fix" for the resulting blank row is to fall back to
  // agents.name — which is the leak this whole design exists to prevent.
  it("refuses to publish with no label, before the database has to", async () => {
    const out = await setAgentPublished(db(), USER_ID, AGENT_ID, { published: true });
    expect(out).toEqual({ ok: false, status: 400, code: "label_required" });
    expect(patches).toHaveLength(0);
  });

  it("refuses a blank label too", async () => {
    const out = await setAgentPublished(db(), USER_ID, AGENT_ID, { published: true, label: "   " });
    expect(out).toEqual({ ok: false, status: 400, code: "label_required" });
    expect(patches).toHaveLength(0);
  });

  it("refuses a label the column could not hold", async () => {
    const out = await setAgentPublished(db(), USER_ID, AGENT_ID, {
      published: true,
      label: "a".repeat(PUBLIC_LABEL_MAX_LENGTH + 1),
    });
    expect(out).toEqual({ ok: false, status: 400, code: "label_too_long" });
    expect(patches).toHaveLength(0);
  });

  // Backstop for a caller that somehow skipped the guard: the constraint fires
  // and must still read as the same actionable message.
  it("maps the check constraint to the same message, never a raw code", async () => {
    result = { data: null, error: { code: "23514", message: "agents_published_needs_label" } };
    const out = await setAgentPublished(db(), USER_ID, AGENT_ID, { published: true, label: "x" });
    expect(out).toEqual({ ok: false, status: 400, code: "label_required" });
  });

  // The name never enters the patch, under any input.
  it("never writes agents.name into the public label", async () => {
    await setAgentPublished(db(), USER_ID, AGENT_ID, { published: true, label: "Research Agent" });
    expect(JSON.stringify(patches)).not.toContain("acme-prod-billing");
  });
});

describe("the tenant boundary", () => {
  // Service role bypasses RLS, so this filter IS the boundary.
  it("filters on the caller's own user_id, always", async () => {
    await setAgentPublished(db(), USER_ID, AGENT_ID, { published: false });
    expect(filters).toContainEqual(["user_id", USER_ID]);
    expect(filters).toContainEqual(["id", AGENT_ID]);
  });

  // One answer for "not yours" and "does not exist", so this is not a probe for
  // which agent ids are real.
  it("reports no_agent for another tenant's agent and for a missing one alike", async () => {
    result = { data: null, error: null };
    const out = await setAgentPublished(db(), USER_ID, AGENT_ID, { published: false });
    expect(out).toEqual({ ok: false, status: 404, code: "no_agent" });
  });
});

describe("unpublishing", () => {
  it("needs no label", async () => {
    const out = await setAgentPublished(db(), USER_ID, AGENT_ID, { published: false });
    expect(out.ok).toBe(true);
    expect(patches[0]).toEqual({ published: false });
  });

  // Clearing it would silently discard the operator's own wording, and it costs
  // nothing to keep: the RPC filters on `published` regardless.
  it("keeps the label the operator wrote, in case they re-publish", async () => {
    await setAgentPublished(db(), USER_ID, AGENT_ID, { published: false });
    expect(patches[0]).not.toHaveProperty("public_label");
  });
});
