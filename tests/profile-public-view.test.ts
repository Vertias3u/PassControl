// The public operator profile, as a stranger receives it.
//
// The test that earns its keep is the one asserting the rendered shape is
// EXACTLY the public field set — a future edit that widens the view fails here
// rather than shipping an operator's email, plan or timezone to a public URL.
//
// The second one is subtler and is the reason this file does not simply reuse
// tests/public-verification.test.ts: 0033 omits `owner_kind` on purpose, so the
// owner view here must not invent one.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...a: unknown[]) => h.rateLimitMock(...a),
}));

import {
  PUBLIC_PROFILE_AGENT_CAP,
  PUBLIC_PROFILE_AGENT_FIELDS,
  PUBLIC_PROFILE_FIELDS,
  PUBLIC_PROFILE_LIMIT,
  PUBLIC_PROFILE_OWNER_FIELDS,
  PUBLIC_PROFILE_WINDOW_SECONDS,
  buildPublicProfileAgentView,
  buildPublicProfileView,
  lookupPublicProfile,
} from "@/lib/profile/public";

const PASSPORT_ID = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyc28";
const IP = "203.0.113.7";

/** A row exactly as public_operator_profile() returns it. */
function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    username: "vertiasops",
    display_name: "Vertias Ops",
    bio: "We run agents.",
    website_url: "https://vertias.eu/",
    company: "Vertias",
    avatar_key: "aVatArKey123",
    member_since: "2026-01-04T10:00:00.000Z",
    owner_subject: null,
    owner_tier: null,
    owner_verified_at: null,
    published_agent_count: 0,
    ...overrides,
  };
}

/** A row exactly as public_operator_agents() returns it. */
function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    passport_pubkey: PASSPORT_ID,
    label: "Research Agent",
    status: "active",
    created_at: "2026-02-01T09:30:00.000Z",
    ...overrides,
  };
}

/** Answers the two RPCs by name, so a test can fail one without faking order. */
function db(answers: {
  profile?: { data: unknown; error: unknown };
  agents?: { data: unknown; error: unknown };
}) {
  h.rpcMock.mockImplementation(async (fn: string) => {
    if (fn === "public_operator_profile") {
      return answers.profile ?? { data: [profileRow()], error: null };
    }
    if (fn === "public_operator_agents") return answers.agents ?? { data: [], error: null };
    throw new Error(`unexpected rpc: ${fn}`);
  });
  return { rpc: h.rpcMock, from: h.fromMock } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  h.fromMock.mockImplementation(() => {
    throw new Error("the public profile must not select a table directly");
  });
});

describe("the public field set", () => {
  it("exposes exactly the advertised fields and nothing else", () => {
    const view = buildPublicProfileView(profileRow());
    expect(view).not.toBeNull();
    expect(Object.keys(view!).sort()).toEqual([...PUBLIC_PROFILE_FIELDS].sort());
  });

  it("exposes exactly the advertised agent fields", () => {
    const view = buildPublicProfileAgentView(agentRow());
    expect(view).not.toBeNull();
    expect(Object.keys(view!).sort()).toEqual([...PUBLIC_PROFILE_AGENT_FIELDS].sort());
  });

  it("exposes exactly the advertised owner fields, and no `kind`", () => {
    const view = buildPublicProfileView(
      profileRow({ owner_subject: "vertias.eu", owner_tier: "domain", owner_verified_at: "2026-03-01T00:00:00.000Z" })
    );
    expect(Object.keys(view!.owner!).sort()).toEqual([...PUBLIC_PROFILE_OWNER_FIELDS].sort());
  });

  // Building by NAMING every field rather than spreading is what makes a column
  // added to the SQL function later inert instead of leaked.
  it("drops any column the SQL function grows later", () => {
    const view = buildPublicProfileView(
      profileRow({ email: "op@example.test", plan: "pro", timezone: "Europe/Prague", id: "uuid", avatar_path: "u/avatar" })
    );
    const serialized = JSON.stringify(view);
    for (const secret of ["op@example.test", "pro", "Europe/Prague", "uuid", "u/avatar"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("the owner block", () => {
  // 0033 omits owner_kind entirely. Reusing PAVP's builder here would read
  // `undefined` and normalise it to "self_attested", printing a self-attested
  // label beside a domain-verified tier. This is that test.
  it("never invents a `kind` the database does not return", () => {
    const view = buildPublicProfileView(
      profileRow({ owner_subject: "vertias.eu", owner_tier: "domain" })
    );
    expect(view!.owner).not.toHaveProperty("kind");
    expect(JSON.stringify(view!.owner)).not.toContain("self_attested");
  });

  it("is null when no owner is bound, or the owner did not publish one", () => {
    expect(buildPublicProfileView(profileRow())!.owner).toBeNull();
    expect(buildPublicProfileView(profileRow({ owner_subject: "   " }))!.owner).toBeNull();
  });

  // Drift must never render as a stronger claim than was proven.
  it("resolves an unrecognised tier downward, never upward", () => {
    for (const tier of ["superverified", "", null, 7, "DOMAIN"]) {
      const view = buildPublicProfileView(profileRow({ owner_subject: "vertias.eu", owner_tier: tier }));
      expect(view!.owner!.tier, String(tier)).toBe("unverified");
    }
  });

  it("shows no verification date for a tier that proves nothing", () => {
    const view = buildPublicProfileView(
      profileRow({ owner_subject: "vertias.eu", owner_tier: "unverified", owner_verified_at: "2026-03-01T00:00:00.000Z" })
    );
    expect(view!.owner!.verifiedAt).toBeNull();
  });

  it("keeps the date for a tier that was actually proven", () => {
    const view = buildPublicProfileView(
      profileRow({ owner_subject: "vertias.eu", owner_tier: "domain", owner_verified_at: "2026-03-01T00:00:00.000Z" })
    );
    expect(view!.owner!.verifiedAt).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("published agents", () => {
  it("resolves an unrecognised status to unknown, never to active", () => {
    for (const status of ["retired", "", null, 3]) {
      expect(buildPublicProfileAgentView(agentRow({ status }))!.status, String(status)).toBe("unknown");
    }
  });

  // Both are required by 0033's WHERE too. A row missing either is one this
  // page cannot render honestly, so it is dropped rather than patched.
  it("drops a row with no passport or no label", () => {
    expect(buildPublicProfileAgentView(agentRow({ passport_pubkey: null }))).toBeNull();
    expect(buildPublicProfileAgentView(agentRow({ label: "  " }))).toBeNull();
  });

  it("abbreviates the passport id without altering it", () => {
    const view = buildPublicProfileAgentView(agentRow())!;
    expect(view.passportId).toBe(PASSPORT_ID);
    expect(view.displayId).toContain("…");
    expect(view.displayId.length).toBeLessThan(PASSPORT_ID.length);
  });
});

describe("looking a profile up", () => {
  it("returns the profile and its agents", async () => {
    const result = await lookupPublicProfile(
      db({ profile: { data: [profileRow({ published_agent_count: 1 })], error: null }, agents: { data: [agentRow()], error: null } }),
      "vertiasops",
      IP
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.handle).toBe("vertiasops");
    expect(result.agents).toHaveLength(1);
  });

  it("normalises the handle before it reaches the database", async () => {
    await lookupPublicProfile(db({}), "  @VertiasOps ", IP);
    expect(h.rpcMock).toHaveBeenCalledWith("public_operator_profile", { p_handle: "vertiasops" });
  });

  it("bounds the agent list rather than passing the request's own number", async () => {
    await lookupPublicProfile(db({}), "vertiasops", IP);
    expect(h.rpcMock).toHaveBeenCalledWith("public_operator_agents", {
      p_handle: "vertiasops",
      p_limit: PUBLIC_PROFILE_AGENT_CAP,
    });
  });

  // A malformed handle must not cost a limiter token OR a query. This is what
  // stops /@<megabyte> from being a database load generator.
  it("refuses a malformed handle without touching Redis or the database", async () => {
    for (const handle of ["no", "a".repeat(400), "has-hyphen", null, 42, "../../etc/passwd"]) {
      const result = await lookupPublicProfile(db({}), handle, IP);
      expect(result, String(handle)).toEqual({ ok: false, reason: "not_found" });
    }
    expect(h.rateLimitMock).not.toHaveBeenCalled();
    expect(h.rpcMock).not.toHaveBeenCalled();
  });

  // The limiter is inside the function, not at the call site, so a page cannot
  // forget it. One page view is one request no matter how many round trips.
  it("throttles with one token for the whole page view", async () => {
    await lookupPublicProfile(db({ profile: { data: [profileRow()], error: null }, agents: { data: [agentRow()], error: null } }), "vertiasops", IP);
    expect(h.rateLimitMock).toHaveBeenCalledTimes(1);
    expect(h.rateLimitMock).toHaveBeenCalledWith(
      `profile:${IP}`,
      PUBLIC_PROFILE_LIMIT,
      PUBLIC_PROFILE_WINDOW_SECONDS
    );
  });

  it("reports throttled without querying anything", async () => {
    h.rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    const result = await lookupPublicProfile(db({}), "vertiasops", IP);
    expect(result).toEqual({ ok: false, reason: "throttled" });
    expect(h.rpcMock).not.toHaveBeenCalled();
  });

  // A profile that has not opted in is indistinguishable from one that does not
  // exist. The RPC returns nothing for both.
  it("reports not_found for a profile that has not opted in", async () => {
    const result = await lookupPublicProfile(db({ profile: { data: [], error: null } }), "vertiasops", IP);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  // And it must not go on to read that operator's agent list.
  it("does not read the agent list of a profile it could not find", async () => {
    await lookupPublicProfile(db({ profile: { data: [], error: null } }), "vertiasops", IP);
    expect(h.rpcMock).toHaveBeenCalledTimes(1);
    expect(h.rpcMock).not.toHaveBeenCalledWith("public_operator_agents", expect.anything());
  });

  // "No such operator" during an outage is a false statement about somebody's
  // identity, on a page that exists to be quotable.
  it("reports unavailable, never not_found, when the database fails", async () => {
    const result = await lookupPublicProfile(
      db({ profile: { data: null, error: { message: "boom" } } }),
      "vertiasops",
      IP
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  // The subtler half: the profile carries publishedAgentCount, so a silently
  // empty list would render "3 published agents" above nothing at all.
  it("reports unavailable when the agent list fails, rather than showing none", async () => {
    const result = await lookupPublicProfile(
      db({
        profile: { data: [profileRow({ published_agent_count: 3 })], error: null },
        agents: { data: null, error: { message: "boom" } },
      }),
      "vertiasops",
      IP
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("never selects a table directly", async () => {
    await lookupPublicProfile(db({}), "vertiasops", IP);
    expect(h.fromMock).not.toHaveBeenCalled();
  });
});
