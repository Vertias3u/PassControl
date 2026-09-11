import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { SenderProofPanel } from "@/components/SenderProofPanel";
import { toSenderProofObservations } from "@/lib/sender-proof-observation";

const { purgeMock } = vi.hoisted(() => ({ purgeMock: vi.fn() }));
vi.mock("@/lib/state/redis", () => ({
  purgeAgentPolicy: (...a: unknown[]) => purgeMock(...a),
}));

import { setSenderConstraintMode } from "@/lib/fleet";

let selected: { data: unknown; error: unknown } = { data: null, error: null };
let updated: { data: unknown; error: unknown } = { data: { id: "a1" }, error: null };
const patches: unknown[] = [];
const eqCalls: [string, unknown][] = [];

function db() {
  const b: any = {
    select: () => b,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return b;
    },
    update: (patch: unknown) => {
      patches.push(patch);
      b._writing = true;
      return b;
    },
    maybeSingle: async () => (b._writing ? updated : selected),
  };
  return { from: () => b } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  patches.length = 0;
  eqCalls.length = 0;
  selected = { data: { passport_pubkey: "pk" }, error: null };
  purgeMock.mockResolvedValue(undefined);
  updated = { data: { id: "a1" }, error: null };
});

describe("setting the sender-constraint mode", () => {
  // The mode is READ FROM THE POLICY CACHE on the hot path, so a write that does
  // not purge it leaves the old value deciding for up to a cache TTL: switching
  // an agent to `required` keeps admitting unproven calls for a minute, and
  // switching it to `off` keeps refusing them. shadow-actions.ts already does
  // this for the two other columns in that cache, and tests/policy-shadow-ui
  // asserts it — this is the same invariant, one column over.
  it("purges the policy cache, or the old mode keeps deciding", async () => {
    await setSenderConstraintMode(db(), "u1", "a1", "required");
    expect(purgeMock).toHaveBeenCalledWith("u1", "a1");
  });

  // The database write is the durable thing; the purge is not. A Redis blip must
  // not report failure for a change that was applied — the caller would retry a
  // write that already succeeded, and the only real cost is a stale mode for the
  // rest of the TTL. Same trade lib/owner/manage.ts makes for the owner cache.
  // AUTH-02. This used to assert a flat `ok: true` and nothing else, which
  // encoded the belief that a failed invalidation is a cosmetic delay. It is not,
  // for THIS setting: until the cache is invalidated, outstanding bearer visas
  // keep being admitted on an agent the operator has just switched to `required`.
  // The write is still durable and still must not be retried, so the result stays
  // ok — but it now says whether enforcement is actually live, so the surface
  // above can stop claiming something it does not know.
  it("keeps the durable write but does not claim enforcement when the purge fails", async () => {
    purgeMock.mockRejectedValueOnce(new Error("redis down"));
    await expect(setSenderConstraintMode(db(), "u1", "a1", "required")).resolves.toMatchObject({
      ok: true,
      value: { mode: "required", enforcementLive: false },
    });
  });

  it("says enforcement is live when the invalidation lands", async () => {
    purgeMock.mockResolvedValueOnce(true);
    await expect(setSenderConstraintMode(db(), "u1", "a1", "required")).resolves.toMatchObject({
      ok: true,
      value: { mode: "required", enforcementLive: true },
    });
  });

  it.each(["off", "observe", "required"])("writes %s", async (mode) => {
    const result = await setSenderConstraintMode(db(), "u1", "a1", mode);
    expect(result.ok).toBe(true);
    expect(patches.at(-1)).toEqual({ sender_constraint_mode: mode });
  });

  // The tenant boundary. This runs under service_role, which bypasses RLS, so
  // the user_id filter in the query IS the boundary — not a belt over a brace.
  it("scopes the write to the acting tenant and the named agent", async () => {
    await setSenderConstraintMode(db(), "u1", "a1", "required");
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ["user_id", "u1"],
        ["id", "a1"],
      ])
    );
  });

  it("refuses a mode the database would reject, without writing", async () => {
    const result = await setSenderConstraintMode(db(), "u1", "a1", "paranoid");
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(patches).toHaveLength(0);
  });

  // A Direct Agent Key is a bearer credential BY DESIGN — trust boundary #1
  // says the two assurances are different and must not be homogenised. Asking
  // one for a proof is a setting that can never be satisfied, so it is refused
  // at the point of configuration rather than turning into calls that fail
  // forever with nothing on screen explaining why.
  it("refuses proof modes for an agent that has no passport", async () => {
    selected = { data: { passport_pubkey: null }, error: null };

    for (const mode of ["observe", "required"]) {
      const result = await setSenderConstraintMode(db(), "u1", "a1", mode);
      expect(result, mode).toMatchObject({ ok: false, status: 422 });
    }
    expect(patches).toHaveLength(0);
  });

  // ...but turning it OFF must always work. Making it harder to stop enforcing
  // than to start is the wrong way round, and it is the same rule the MFA gate
  // follows for revocation.
  it("always allows turning it off, whatever the credential is", async () => {
    selected = { data: { passport_pubkey: null }, error: null };
    await expect(setSenderConstraintMode(db(), "u1", "a1", "off")).resolves.toMatchObject({
      ok: true,
    });
    expect(patches.at(-1)).toEqual({ sender_constraint_mode: "off" });
  });

  it("404s for an agent this tenant does not have", async () => {
    selected = { data: null, error: null };
    await expect(setSenderConstraintMode(db(), "u1", "a1", "required")).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("the server action and the control", () => {
  const read = (p: string) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

  it("gates the mode change on MFA step-up, like every other passport action", async () => {
    const actions = await read("app/dashboard/agents/[id]/passport-actions.ts");
    const at = actions.indexOf("export async function setAgentSenderConstraint");
    expect(at, "setAgentSenderConstraint is missing").toBeGreaterThan(-1);

    const rest = actions.slice(at);
    const body = rest.slice(0, Math.max(rest.indexOf("\nexport async function ", 1), 0) || rest.length);
    // The acting tenant comes from the verified session, never from an argument.
    expect(body.slice(0, body.indexOf(")"))).not.toMatch(/userId/);
    expect(body).toMatch(/await actingUser\(\)/);
    expect(body).toMatch(/"error" in acting/);
    expect(body).toMatch(/recordAdminAction/);
    expect(body).toMatch(/revalidatePath/);
  });

  // The wording IS the control here. An operator who turns on `required`
  // without understanding that every non-signing client stops working is an
  // operator who has locked their fleet out, and the dashboard is the last
  // place that can tell them.
  it("says plainly what required breaks, and names the client that signs", async () => {
    const panel = await read("components/SenderProofPanel.tsx");
    // Either name is fine, and the distinction is deliberate: the command is
    // `passcontrol sidecar`, but the thing a user recognises from the docs and
    // the release notes is "the connector". What must not happen is the copy
    // naming neither, leaving an operator to work out which of their clients
    // signs after their fleet has already stopped.
    expect(panel).toMatch(/connector|sidecar/i);
    expect(panel).toMatch(/stop working|refused|locked out/i);
    expect(panel).toMatch(/data-mode=/);
  });

  it("is mounted on the agent page", async () => {
    expect(await read("app/dashboard/agents/[id]/page.tsx")).toMatch(/<SenderProofPanel/);
  });
});

/**
 * Rendered, not grepped. A source check proves a sentence is written down
 * somewhere; only the DOM proves it reaches the page — which is the gap
 * CLAUDE.md's "verify in a browser" rule exists for, after a setState updater
 * shifted every row of the receipt page by one with the suite fully green.
 */
describe("what the panel actually renders", () => {
  const rows = (verdicts: (string | null)[]) =>
    verdicts.map((sender_proof_would) => ({ sender_proof_would }));

  const render = (mode: "off" | "observe" | "required", verdicts: (string | null)[], hasPassport = true) =>
    renderToStaticMarkup(
      <SenderProofPanel
        agentId="8f000000-0000-4000-8000-000000000002"
        mode={mode}
        summary={toSenderProofObservations(mode, rows(verdicts))}
        hasPassport={hasPassport}
      />
    );

  it("marks the current mode on the panel and on its choice", () => {
    const html = render("observe", ["pass"]);
    expect(html).toContain('data-mode="observe"');
    expect(html).toContain('data-choice="observe"');
    expect(html).toMatch(/data-choice="observe"[^>]*data-selected="true"/);
    expect(html).toMatch(/data-choice="required"[^>]*data-selected="false"/);
  });

  it("offers all three modes", () => {
    const html = render("off", []);
    for (const mode of ["off", "observe", "required"]) {
      expect(html).toContain(`data-choice="${mode}"`);
    }
  });

  // The number and the caveat have to arrive together. A count with no bound on
  // it is the half a reader remembers.
  it("shows the count and what it does not cover", () => {
    const html = render("observe", ["pass", "pass"]);
    expect(html).toContain("2");
    expect(html).toMatch(/has not called yet/i);
  });

  it("names each failure in words rather than as a verdict code", () => {
    const html = render("observe", ["pass", "missing", "clock_skew"]);
    expect(html).toMatch(/sent no proof/i);
    expect(html).toMatch(/wrong clock/i);
    expect(html).not.toContain("clock_skew");
  });

  // An empty sample is the dangerous one: it must not read as a pass.
  it("says nothing was observed rather than implying everything passed", () => {
    const html = render("observe", []);
    expect(html).toMatch(/no calls since observing was switched on/i);
    expect(html).not.toMatch(/would have been admitted/i);
  });

  it("refuses to offer the control at all for a Direct Agent Key", () => {
    const html = render("off", [], false);
    expect(html).toMatch(/bearer credential by\s+design/i);
    expect(html).not.toContain('data-choice="required"');
  });
});
