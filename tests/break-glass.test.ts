// Break-glass elevation.
//
// This is a deliberate hole in the capability model, so these tests are less
// about "does it work" than about "how small is the hole". Four properties, in
// order of what it would cost to lose them:
//
//  1. IT WIDENS SCOPE AND NOTHING ELSE. The kill switch, per-agent suspend,
//     policy deny rules and budgets all still apply. The obvious next request
//     is to make break-glass override policy too, so this is pinned rather than
//     documented.
//  2. IT CANNOT LEAK INTO AN IDENTITY ASSERTION. /api/auth/agent-token shares
//     the passport lookup with the challenge route and deliberately carries no
//     scope. A token handed to a third party must never be elevated — they have
//     no way to know it was temporary.
//  3. A FAILED READ MEANS NO ELEVATION. For this feature, closed is the
//     opposite reflex from the rest of the codebase: never error the challenge
//     (an unreachable grants table would be an outage for every agent), never
//     assume a grant (a database blip would be a privilege escalation).
//  4. NOBODY CAN TAKE ONE QUIETLY. Mandatory reason, audit row, critical alert.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";

const h = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  claimNonceMock: vi.fn(),
  touchLastSeenMock: vi.fn(),
  readCurrentOwnerMock: vi.fn(),
  agentRow: null as Record<string, unknown> | null,
  grantRow: null as Record<string, unknown> | null,
  grantThrows: false,
  grantError: null as unknown,
  grantFilters: [] as [string, unknown][],
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...a: unknown[]) => h.rateLimitMock(...a) }));
vi.mock("@/lib/state/redis", () => ({
  claimNonce: (...a: unknown[]) => h.claimNonceMock(...a),
  touchLastSeen: (...a: unknown[]) => h.touchLastSeenMock(...a),
}));
vi.mock("@/lib/owner/current", () => ({
  readCurrentOwner: (...a: unknown[]) => h.readCurrentOwnerMock(...a),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "break_glass_grants" && h.grantThrows) {
        throw new Error("grants table unreachable");
      }
      const filters: [string, unknown][] = [];
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain,
        order: chain,
        limit: chain,
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return b;
        },
        is: (c: string, v: unknown) => {
          filters.push([c, v]);
          return b;
        },
        gt: (c: string, v: unknown) => {
          filters.push([c, v]);
          return b;
        },
        maybeSingle: async () => {
          if (table === "break_glass_grants") {
            h.grantFilters = [...filters];
            return { data: h.grantRow, error: h.grantError };
          }
          return { data: h.agentRow, error: null };
        },
      });
      return b;
    },
  }),
}));

import { POST as challenge } from "@/app/api/auth/challenge/route";
import { POST as agentToken } from "@/app/api/auth/agent-token/route";
import { verifyVisa } from "@/lib/auth/visa";
import {
  parseGrantScopes,
  unionScopes,
  scopeUnionExceedsBounds,
  MAX_BREAK_GLASS_TTL_S,
  MIN_BREAK_GLASS_TTL_S,
  MAX_SCOPE_CLAIM_BYTES,
} from "@/lib/break-glass";
import { LIMITS } from "@/lib/validate";
import { AUDIT_ACTIONS, buildAuditRecord } from "@/lib/audit";
import { alertSeverity } from "@/lib/alert";
import { verifyCompactJws } from "@/lib/crypto/jws";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";

const SEED = ed25519.utils.randomPrivateKey();
const PASSPORT = bytesToBase64url(ed25519.getPublicKey(SEED));
const AGENT_ID = "55555555-5555-5555-5555-555555555555";
const USER_ID = "66666666-6666-6666-6666-666666666666";

const STORED_SCOPES = [{ provider: "openai", models: ["gpt-4o-mini"] }];
const GRANTED_SCOPES = [{ provider: "anthropic", models: ["claude-opus-*"] }];

const agent = (over: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  user_id: USER_ID,
  status: "active",
  allowed_scopes: STORED_SCOPES,
  budget_tokens: null,
  budget_cents: null,
  spent_tokens: 0,
  spent_microcents: 0,
  expires_at: null,
  previous_valid_until: null,
  ...over,
});

const grant = (over: Record<string, unknown> = {}) => ({
  id: "77777777-7777-7777-7777-777777777777",
  scopes: GRANTED_SCOPES,
  reason: "incident 412 — reprocessing the backlog",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  created_at: new Date().toISOString(),
  ...over,
});

function signed(extra: Record<string, unknown> = {}) {
  const payload = { passport_id: PASSPORT, ts: Date.now(), nonce: crypto.randomUUID(), ...extra };
  const bytes = utf8ToBytes(JSON.stringify(payload));
  return {
    payload: bytesToBase64url(bytes),
    signature: bytesToBase64url(ed25519.sign(bytes, SEED)),
  };
}

const request = (path: string, body: unknown) =>
  new Request(`https://gw.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const mintVisaClaims = async () => {
  const res = await challenge(request("/api/auth/challenge", signed()));
  expect(res.status).toBe(200);
  const { visa } = await res.json();
  const claims = await verifyVisa(visa);
  expect(claims).not.toBeNull();
  return claims!;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.agentRow = agent();
  h.grantRow = null;
  h.grantThrows = false;
  h.grantError = null;
  h.grantFilters = [];
  process.env.VISA_SECRET = "y".repeat(48);
  process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(9));
  process.env.PASSCONTROL_ISSUER = "https://gw.example.com";
  h.rateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  h.claimNonceMock.mockResolvedValue(true);
  h.touchLastSeenMock.mockResolvedValue(undefined);
  h.readCurrentOwnerMock.mockResolvedValue(null);
});

describe("the visa mint", () => {
  it("carries only the stored scope when there is no grant", async () => {
    const claims = await mintVisaClaims();
    expect(claims.scope).toEqual(STORED_SCOPES);
  });

  it("unions a live grant into the scope snapshot", async () => {
    h.grantRow = grant();
    const claims = await mintVisaClaims();
    expect(claims.scope).toEqual([...STORED_SCOPES, ...GRANTED_SCOPES]);
  });

  /**
   * "Live" is decided in code — revoked_at is null AND expires_at in the future
   * — not by the unique index, whose predicate can only be `revoked_at is null`
   * because Postgres refuses a STABLE function there. So the query must carry
   * both conditions, or a lapsed-but-unswept grant would keep elevating.
   */
  it("asks the database for an unrevoked, unexpired grant, scoped to the tenant", async () => {
    h.grantRow = grant();
    await mintVisaClaims();
    const columns = h.grantFilters.map(([c]) => c);
    expect(columns).toContain("revoked_at");
    expect(columns).toContain("expires_at");
    expect(h.grantFilters).toContainEqual(["user_id", USER_ID]);
    expect(h.grantFilters).toContainEqual(["agent_id", AGENT_ID]);
  });

  // ── 3. Closed means NO ELEVATION ──────────────────────────────────────────

  it("mints the normal scope when the grants table cannot be reached", async () => {
    h.grantThrows = true;
    const claims = await mintVisaClaims();
    expect(claims.scope).toEqual(STORED_SCOPES);
  });

  it("mints the normal scope when the grant query errors", async () => {
    h.grantError = { code: "42P01" };
    const claims = await mintVisaClaims();
    expect(claims.scope).toEqual(STORED_SCOPES);
  });

  it.each([
    ["a malformed scopes column", { scopes: "everything" }],
    ["scopes that are not entries", { scopes: [1, 2, 3] }],
    ["an entry with no models", { scopes: [{ provider: "anthropic" }] }],
    ["an entry with an empty model list", { scopes: [{ provider: "anthropic", models: [] }] }],
  ])("mints the normal scope for a grant with %s", async (_label, over) => {
    h.grantRow = grant(over);
    const claims = await mintVisaClaims();
    expect(claims.scope).toEqual(STORED_SCOPES);
  });

  // ── One claim, one shape ──────────────────────────────────────────────────

  /**
   * The visa's `scope` claim must have the same SHAPE whether or not an
   * elevation happened to be live at mint. It used to be the one field where
   * that was not true: the grant path went through unionScopes (merged by
   * provider, models deduped) and the no-grant path — the overwhelmingly common
   * one — snapshotted the raw jsonb column.
   *
   * validateScopes permits `[openai:[a], openai:[b]]`, so this is reachable
   * without a malformed row. It does not change what the visa PERMITS —
   * scopeRuleMatch honours any matching row — but it is observable: a consumer
   * that reads one row per provider (buildAlternatives takes models from the
   * FIRST matching entry) reports a narrower model list on the no-grant path
   * than on the elevated one, for an agent whose capability never changed.
   * A claim that changes shape depending on an unrelated feature is a claim
   * every future consumer has to be defensive about.
   */
  it("mints one row per provider whether or not a grant is live", async () => {
    const duplicated = [
      { provider: "openai", models: ["gpt-4o-mini"] },
      { provider: "openai", models: ["gpt-4o"] },
    ];
    const merged = [{ provider: "openai", models: ["gpt-4o-mini", "gpt-4o"] }];

    h.agentRow = agent({ allowed_scopes: duplicated });
    expect((await mintVisaClaims()).scope).toEqual(merged);

    h.grantRow = grant();
    expect((await mintVisaClaims()).scope).toEqual([...merged, ...GRANTED_SCOPES]);
  });

  /**
   * `allowed_scopes` is `jsonb not null default '[]'` with no CHECK that it is
   * an ARRAY, and the service-role client bypasses RLS — so a non-array value
   * is not impossible, just unwritable through the dashboard. lib/fleet.ts
   * already guards it with Array.isArray at the grant door; the mint door only
   * had `?? []`, which catches null and nothing else.
   *
   * The two paths then failed differently: with no grant the visa was minted
   * carrying a non-array `scope` and every later call 401'd at verifyVisa's
   * Array.isArray check, and with a grant `unionScopes` threw on spreading a
   * non-iterable and the challenge 500'd. Both fail closed — this is
   * robustness, not escalation — but "no readable capability" should mean an
   * empty scope at both doors, not two different outages.
   */
  it.each([
    ["an object", {}],
    ["a string", "openai:*"],
    ["a number", 7],
  ])("mints an empty scope when allowed_scopes is %s", async (_label, stored) => {
    h.agentRow = agent({ allowed_scopes: stored });
    expect((await mintVisaClaims()).scope).toEqual([]);

    h.grantRow = grant();
    expect((await mintVisaClaims()).scope).toEqual(GRANTED_SCOPES);
  });

  /**
   * The twin of the grant-side cases above, for the STORED document.
   *
   * Sending both paths through unionScopes means the common path now iterates
   * `allowed_scopes` on every mint, where before it only copied the reference.
   * A malformed ENTRY inside an otherwise valid array must therefore degrade
   * the same way a malformed grant does — the bad entry is dropped or emptied —
   * and must never throw. A throw here is not one denied provider: it is a 500
   * on the challenge, so the agent cannot authenticate at all.
   */
  it.each([
    ["an entry that is not an object", [null], []],
    ["an entry with no models", [{ provider: "openai" }], [{ provider: "openai", models: [] }]],
    [
      "an entry whose models are not a list",
      [{ provider: "openai", models: "gpt-4o" }],
      [{ provider: "openai", models: [] }],
    ],
    [
      "one bad entry beside a good one",
      [{ provider: "openai", models: ["gpt-4o"] }, 7],
      [{ provider: "openai", models: ["gpt-4o"] }],
    ],
  ])("still mints for a stored scope with %s", async (_label, stored, expected) => {
    h.agentRow = agent({ allowed_scopes: stored });
    expect((await mintVisaClaims()).scope).toEqual(expected);
  });

  // ── 2. It must not reach a third party ────────────────────────────────────

  /**
   * agent-token shares the passport lookup with the challenge route. It asserts
   * this agent's identity to someone else, verified offline against the JWKS,
   * with no callback here — so an elevation baked into one would be a temporary
   * grant that reads as a permanent fact to a party who cannot tell.
   */
  it("never reaches an agent token, even while a grant is live", async () => {
    h.grantRow = grant();
    const res = await agentToken(
      request("/api/auth/agent-token", signed({ aud: "billing-service" }))
    );
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const signer = loadInstanceSigner()!;
    const verified = verifyCompactJws(token, signer.publicKey);
    expect(verified).not.toBeNull();
    // Not "does not contain the granted provider" — the claim is absent entirely.
    expect(verified?.claims).not.toHaveProperty("scope");
  });
});

// ── 1. Scope, and nothing else ──────────────────────────────────────────────
describe("what break-glass does NOT widen", () => {
  const routeSource = readFileSync(
    resolve(process.cwd(), "app/api/v1/[provider]/[...path]/route.ts"),
    "utf8"
  );

  /**
   * The proxy is where kill, suspend, policy and budget are enforced. If it
   * never learns break-glass exists, none of them can be widened by it — which
   * is a stronger guarantee than testing each gate individually, because it also
   * covers gates nobody has written yet.
   */
  it("is invisible to the proxy, so every gate above scope is untouched", () => {
    expect(routeSource).not.toMatch(/break.?glass/i);
    expect(routeSource).not.toMatch(/break_glass_grants/);
  });

  it("does not appear in the killswitch, budget or policy modules either", () => {
    for (const path of ["lib/state/killswitch.ts", "lib/gate.ts", "lib/state/policy.ts"]) {
      expect(readFileSync(resolve(process.cwd(), path), "utf8"), path).not.toMatch(/break.?glass/i);
    }
  });

  it("is refused for an agent that is not active", async () => {
    // A suspended agent cannot even authenticate, so an elevation on one would
    // be inert — but it must be refused at the grant, not silently accepted.
    const fleet = readFileSync(resolve(process.cwd(), "lib/fleet.ts"), "utf8");
    const at = fleet.indexOf("export async function grantBreakGlass");
    const body = fleet.slice(at, fleet.indexOf("\nexport async function ", at + 1));
    expect(body).toMatch(/status !== "active"/);
  });
});

describe("unionScopes", () => {
  it("keeps the agent's own capability first", () => {
    expect(unionScopes(STORED_SCOPES, GRANTED_SCOPES)[0]).toEqual(STORED_SCOPES[0]);
  });

  /**
   * Merged by provider rather than concatenated. Two entries for one provider
   * are both honoured by scopeAllows, so concatenating is not WRONG — but the
   * visa would grow across repeated elevations, and the minted scope is what a
   * decision trace shows someone trying to understand why a call went through.
   */
  it("merges model lists for a provider the agent already has", () => {
    const merged = unionScopes(
      [{ provider: "openai", models: ["gpt-4o-mini"] }],
      [{ provider: "openai", models: ["gpt-4o", "gpt-4o-mini"] }]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.models).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("does not mutate either input", () => {
    const base = [{ provider: "openai", models: ["a"] }];
    const granted = [{ provider: "openai", models: ["b"] }];
    unionScopes(base, granted);
    expect(base[0]?.models).toEqual(["a"]);
    expect(granted[0]?.models).toEqual(["b"]);
  });

  it("returns the base unchanged when nothing is granted", () => {
    expect(unionScopes(STORED_SCOPES, [])).toEqual(STORED_SCOPES);
  });

  /**
   * Duplicate providers are merged in the BASE too, not only between base and
   * grant. validateScopes permits `[openai:[a], openai:[b]]`, and the old merge
   * kept both rows while folding every granted model into the FIRST of them —
   * so the row count stayed flat while one row grew without limit. One row per
   * provider is what makes a row count mean something again, and it is what the
   * visa should have carried all along: scopeAllows honours any matching row,
   * so this changes what the claim LOOKS like, never what it permits.
   */
  it("collapses duplicate provider rows in the base", () => {
    const merged = unionScopes(
      [
        { provider: "openai", models: ["gpt-4o"] },
        { provider: "openai", models: ["gpt-4o-mini"] },
      ],
      [{ provider: "openai", models: ["o3"] }]
    );
    expect(merged).toEqual([{ provider: "openai", models: ["gpt-4o", "gpt-4o-mini", "o3"] }]);
  });

  it("keeps the first appearance of a provider's position", () => {
    const merged = unionScopes(
      [
        { provider: "openai", models: ["a"] },
        { provider: "anthropic", models: ["b"] },
        { provider: "openai", models: ["c"] },
      ],
      []
    );
    expect(merged.map((m) => m.provider)).toEqual(["openai", "anthropic"]);
  });
});

/**
 * A row count is not a size.
 *
 * validateScopes bounds ONE document — 20 entries, 50 models each — and the
 * whole point of an elevation is that two documents get merged into a claim
 * that is then base64url'd into a bearer token and sent on every proxied call.
 * So the union has to be bounded on the axes that decide whether that token can
 * be sent at all.
 */
describe("scopeUnionExceedsBounds", () => {
  const models = (tag: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${tag}-${i}`);

  it("passes a normal union", () => {
    expect(scopeUnionExceedsBounds(unionScopes(STORED_SCOPES, GRANTED_SCOPES))).toBeNull();
  });

  it("catches too many providers", () => {
    const union = Array.from({ length: LIMITS.scopes + 1 }, (_, i) => ({
      provider: `p${i}`,
      models: ["m"],
    }));
    expect(scopeUnionExceedsBounds(union)?.limit).toBe(LIMITS.scopes);
  });

  it("catches one provider carrying more models than a scope entry may", () => {
    const union = [{ provider: "openai", models: models("m", LIMITS.models + 1) }];
    expect(scopeUnionExceedsBounds(union)?.limit).toBe(LIMITS.models);
  });

  /**
   * The bound the 400 KB grant actually trips. Every model here is short and
   * every provider is inside its own limit; it is the total serialized claim
   * that would not fit an Authorization header.
   */
  it("catches a claim too large to carry, even when every count is legal", () => {
    const union = [
      { provider: "openai", models: [ "x".repeat(MAX_SCOPE_CLAIM_BYTES) ] },
    ];
    const over = scopeUnionExceedsBounds(union);
    expect(over?.limit).toBe(MAX_SCOPE_CLAIM_BYTES);
    expect(over?.actual).toBeGreaterThan(MAX_SCOPE_CLAIM_BYTES);
  });

  /** Measured in BYTES: modelPattern bounds length, not the charset. */
  it("measures the claim in bytes rather than characters", () => {
    const union = [{ provider: "openai", models: ["€".repeat(10)] }];
    expect(scopeUnionExceedsBounds(union)).toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(union)).length).toBeGreaterThan(
      JSON.stringify(union).length
    );
  });
});

describe("parseGrantScopes", () => {
  it.each([null, undefined, "nope", 7, {}, [null], [{}]])(
    "returns nothing for junk (%s) rather than throwing",
    (input) => {
      expect(() => parseGrantScopes(input)).not.toThrow();
      expect(parseGrantScopes(input)).toEqual([]);
    }
  );

  /**
   * Entries are dropped INDIVIDUALLY rather than failing the whole grant. This
   * is read mid-incident, and discarding an operator's working elevation
   * because one entry is malformed is the wrong failure at the wrong moment.
   * (The write path validates, so a bad entry means a hand-edited row.)
   */
  it("keeps the good entries alongside a bad one", () => {
    const parsed = parseGrantScopes([
      { provider: "anthropic", models: ["claude-*"] },
      { provider: "", models: ["x"] },
    ]);
    expect(parsed).toEqual([{ provider: "anthropic", models: ["claude-*"] }]);
  });
});

// ── 4. Nobody takes one quietly ─────────────────────────────────────────────
describe("the record", () => {
  it("allowlists the audit action", () => {
    expect(AUDIT_ACTIONS).toContain("agent.break_glass");
    expect(() =>
      buildAuditRecord({ userId: "u1", action: "agent.break_glass" })
    ).not.toThrow();
  });

  it("pages, at the same severity as the master kill switch", () => {
    expect(alertSeverity("agent.break_glass")).toBe("critical");
    expect(alertSeverity("agent.break_glass")).toBe(alertSeverity("killswitch.master"));
  });

  it("records every visa minted under an elevation, not just the grant", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/api/auth/challenge/route.ts"),
      "utf8"
    );
    expect(source).toMatch(/break_glass_minted/);
  });
});

describe("migration 0022", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "db/migrations/0022_break_glass_grants.sql"),
    "utf8"
  ).replace(/--[^\n]*/g, "");

  it("makes a reason mandatory, and not satisfiable with whitespace", () => {
    expect(sql).toMatch(/reason\s+text not null/i);
    expect(sql).toMatch(/check \(length\(btrim\(reason\)\)/i);
  });

  it("bounds every grant in time at the schema level", () => {
    expect(sql).toMatch(/expires_at\s+timestamptz not null/i);
  });

  /**
   * A client that could write its own grant would make the mechanism
   * decorative: it would be a way for a tenant to hand themselves any scope
   * they liked, which is exactly what allowed_scopes exists to prevent.
   */
  it("gives the client no way to write one", () => {
    expect(sql).toMatch(/for select to authenticated/);
    expect(sql).toMatch(/revoke insert, update, delete on public\.break_glass_grants/);
    expect(sql).not.toMatch(/for insert to authenticated/);
    expect(sql).not.toMatch(/for update to authenticated/);
  });

  it("enables row level security", () => {
    expect(sql).toMatch(/alter table public\.break_glass_grants enable row level security/);
  });

  /**
   * Postgres refuses a STABLE function in an index predicate, verified against
   * this database rather than assumed. So the index can only enforce "one
   * UNREVOKED grant"; the liveness rule lives in code and the sweep frees the
   * slot afterwards.
   */
  it("enforces one live grant with a predicate Postgres will actually accept", () => {
    const index = sql.slice(sql.indexOf("create unique index"));
    expect(index).toMatch(/where revoked_at is null/);
    expect(index.slice(0, index.indexOf(";"))).not.toMatch(/now\(\)/);
  });
});

describe("the TTL cap", () => {
  const fleet = readFileSync(resolve(process.cwd(), "lib/fleet.ts"), "utf8");
  const body = (() => {
    const at = fleet.indexOf("export async function grantBreakGlass");
    return fleet.slice(at, fleet.indexOf("\nexport async function ", at + 1));
  })();

  it("is an hour — long enough to work an incident, not to forget about", () => {
    expect(MAX_BREAK_GLASS_TTL_S).toBe(3600);
  });

  /** A form-only limit is not a limit. Migration 0022 gives the client no insert
   *  path precisely so this function is the only way in. */
  it("is enforced server-side, alongside the scope validation", () => {
    expect(body).toMatch(/MAX_BREAK_GLASS_TTL_S/);
    expect(body).toMatch(/MIN_BREAK_GLASS_TTL_S/);
    expect(body).toMatch(/validateScopes/);
  });

  /**
   * The union is what lands in the visa, so the union is what must be bounded —
   * and bounded on every axis that decides whether the token can be sent, not
   * just on how many rows it has. Pinned as "the shared check runs on the union
   * that will be minted", so the bounds can be tightened in one place.
   */
  it("bounds the union rather than only the grant", () => {
    expect(body).toMatch(/const union = unionScopes\(stored, scopes\)/);
    expect(body).toMatch(/scopeUnionExceedsBounds\(union\)/);
  });
});

// ── The dashboard surface ───────────────────────────────────────────────────
describe("the server actions and panel", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const actions = read("app/dashboard/agents/[id]/break-glass-actions.ts");
  const ui = read("components/BreakGlassPanel.tsx");

  const fn = (name: string) => {
    const at = actions.indexOf(`export async function ${name}`);
    expect(at, `${name} is missing`).toBeGreaterThan(-1);
    const rest = actions.slice(at);
    const next = rest.indexOf("\nexport async function ", 1);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it.each(["takeBreakGlass", "endBreakGlass"])(
    "%s derives the acting user from the session, never from an argument",
    (name) => {
      const body = fn(name);
      expect(body.slice(0, body.indexOf(")"))).not.toMatch(/userId/);
      expect(body).toMatch(/await actingUser\(\)/);
    }
  );

  it("gates on MFA step-up", () => {
    const helper = actions.slice(actions.indexOf("async function actingUser"));
    const body = helper.slice(0, helper.indexOf("\n}\n"));
    expect(body).toMatch(/mfaAuthorizedUser/);
    expect(body).not.toMatch(/needsMfaStepUp/);
  });

  /**
   * Migration 0022 gives the client no insert path, so fleet is the only way
   * in — which is only worth anything if the bounds live there rather than
   * being re-implemented, more loosely, at this layer.
   */
  it("delegates every bound to lib/fleet rather than re-checking here", () => {
    expect(fn("takeBreakGlass")).toMatch(/grantBreakGlass/);
    expect(actions).not.toMatch(/from\("break_glass_grants"\)/);
    expect(actions).not.toMatch(/MAX_BREAK_GLASS_TTL_S/);
  });

  it("raises a critical alert and records the reason", () => {
    const body = fn("takeBreakGlass");
    expect(body).toMatch(/dispatchSecurityAlert/);
    expect(body).toMatch(/action: "agent\.break_glass"/);
    expect(body).toMatch(/reason:/);
  });

  /**
   * The audit row must state the elevation that was GRANTED.
   *
   * fleet stores what validateScopes produced — trimmed, with anything it was
   * not asked for dropped — so recording the request value here would describe a
   * document that was never granted, on the one surface built to be reviewed
   * afterwards. Same defect as a rotation audit naming a key that is not on the
   * row, and the capability history now renders these rows.
   */
  it("audits the scope document fleet stored, not the one submitted", () => {
    const body = fn("takeBreakGlass");
    expect(body).toMatch(/scopes: JSON\.stringify\(result\.value\.scopes\)/);
    expect(body).not.toMatch(/JSON\.stringify\(input\.scopes/);
  });

  /** Same rule on the way out: the count comes from the write, not the caller. */
  it("records how many grants the end actually revoked", () => {
    expect(fn("endBreakGlass")).toMatch(/revoked: result\.value\.revoked/);
  });

  it("is rendered on the agent page", () => {
    expect(read("app/dashboard/agents/[id]/page.tsx")).toMatch(/<BreakGlassPanel/);
  });

  // The single most important sentence on the panel: someone reaching for this
  // because a policy is blocking them needs to know it will not help.
  it("says plainly that it widens scope and nothing else", () => {
    expect(ui).toMatch(/This widens scope\. It does not widen anything else\./);
    expect(ui).toMatch(/kill switch/i);
    expect(ui).toMatch(/budgets/i);
    expect(ui).toMatch(/change the policy/i);
  });

  /**
   * The proxy gates on the scope snapshot inside the visa and never re-reads
   * the grant — the property that keeps this feature off the credential path.
   * A revoke control that reads as instant when it is not is the failure this
   * feature can least afford.
   */
  it("says ending it early is not instant, and gives the bound", () => {
    expect(ui).toMatch(/one already issued keeps it until it/i);
    expect(ui).toMatch(/visaTtlSeconds/);
    expect(ui).toMatch(/suspend it/i);
  });

  it("says it lapses on its own", () => {
    expect(ui).toMatch(/lapses on its own/);
    expect(ui).toMatch(/no job has to run/i);
  });

  it("requires a reason in the form, as the database does in the row", () => {
    expect(ui).toMatch(/required, and recorded/i);
    expect(ui).toMatch(/reason\.trim\(\)\.length > 0/);
    expect(ui).toMatch(/BREAK_GLASS_REASON_MAX/);
  });

  it("distinguishes an elevated agent from a quiet one", () => {
    expect(ui).toMatch(/data-state=\{grant \? "elevated" : "closed"\}/);
    expect(ui).toMatch(/This agent is elevated for another/);
  });

  // Same rule as every other form here: offering a duration the server refuses
  // is a failure the operator meets at the moment they try to use it.
  it("offers no duration outside what the server accepts", () => {
    const durations = ui.slice(ui.indexOf("const DURATIONS"), ui.indexOf("] as const"));
    const literals = [...durations.matchAll(/seconds:\s*(\d+)\s*\*\s*(\d+)/g)].map(
      (m) => Number(m[1]) * Number(m[2])
    );
    // The longest option is the constant itself, so it is exact by construction
    // and the numeric ones are what need checking.
    expect(durations).toMatch(/MAX_BREAK_GLASS_TTL_S/);
    expect(literals.length).toBeGreaterThan(0);
    for (const value of literals) {
      expect(value).toBeLessThanOrEqual(MAX_BREAK_GLASS_TTL_S);
      expect(value).toBeGreaterThanOrEqual(MIN_BREAK_GLASS_TTL_S);
    }
  });
});

/**
 * The simulator on the same page reads allowed_scopes off the row, while the
 * proxy gates on the visa's snapshot. During an elevation those differ — so an
 * untouched trace would report "denied by scope" for calls that actually
 * succeed, exactly when someone is most likely to consult it.
 */
describe("the decision trace during an elevation", () => {
  const trace = readFileSync(
    resolve(process.cwd(), "app/api/control/v1/agents/[id]/trace/decision-trace.ts"),
    "utf8"
  );

  it("evaluates against the scope a visa would actually carry", () => {
    expect(trace).toMatch(/readLiveGrant/);
    expect(trace).toMatch(/unionScopes\(scopes\(agent\.allowed_scopes\), grant\.scopes\)/);
  });

  it("declares the elevation rather than silently agreeing with it", () => {
    expect(trace).toMatch(/break_glass\?: \{ expires_at: string; reason: string \}/);
    expect(trace).toMatch(/break_glass: \{ expires_at: grant\.expiresAt/);
    expect(
      readFileSync(
        resolve(process.cwd(), "app/dashboard/agents/[id]/DecisionTracePanel.tsx"),
        "utf8"
      )
    ).toMatch(/data-state="break-glass"/);
  });
});
