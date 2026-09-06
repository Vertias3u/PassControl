// GET /.well-known/passport-revocations
//
// The contract a stranger relies on: a signed document, or an error. Never an
// empty list that reads as "nothing has been revoked" when the truth is "this
// instance cannot say right now".
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64url } from "@/lib/encoding";

const { fromMock, rateLimitMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ from: fromMock }) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...a: unknown[]) => rateLimitMock(...a) }));

import { GET } from "@/app/.well-known/passport-revocations/route";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { verifyCompactJws } from "@/lib/crypto/jws";
import { REVOCATION_LIST_TYP } from "@/lib/revocation-list";

const SEED = bytesToBase64url(new Uint8Array(32).fill(7));
const ISSUER = "https://gw.example.com";

/**
 * Records every server-side filter, because narrowing these queries is the
 * point: this endpoint is unauthenticated and uncached on a self-hosted
 * instance, so an unbounded scan of admin_audit is a free amplification
 * primitive against the tenant database.
 */
const filters: { table: string; eq: [string, unknown][]; not: unknown[] }[] = [];

function db(audit: { data: unknown; error: unknown }, agents: { data: unknown; error: unknown }) {
  fromMock.mockImplementation((table: string) => {
    const record = { table, eq: [] as [string, unknown][], not: [] as unknown[] };
    filters.push(record);
    const result = table === "agents" ? agents : audit;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        record.eq.push([column, value]);
        return chain;
      },
      not: (...args: unknown[]) => {
        record.not.push(args);
        return chain;
      },
      order: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  });
}

const REVOKED = [
  { action: "agent.revoke", target_id: "a1", created_at: "2026-03-01T00:00:00.000Z", metadata: {} },
];
const AGENTS = [{ id: "a1", passport_pubkey: "key-one" }];

async function payloadOf(res: Response) {
  const signer = loadInstanceSigner();
  const verified = verifyCompactJws(await res.text(), signer!.publicKey, { typ: REVOCATION_LIST_TYP });
  return verified?.claims as Record<string, unknown> | undefined;
}

const request = () => new Request("https://gw.example.com/.well-known/passport-revocations");

beforeEach(() => {
  vi.clearAllMocks();
  filters.length = 0;
  rateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  process.env.INSTANCE_SIGNING_KEY = SEED;
  process.env.PASSCONTROL_ISSUER = ISSUER;
  delete process.env.REVOCATION_LIST_MAX_AGE_SECONDS;
  db({ data: REVOKED, error: null }, { data: AGENTS, error: null });
});

describe("the published document", () => {
  it("serves a JWS this instance's own key verifies, under its own typ", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jose");
    const claims = await payloadOf(res);
    expect(claims?.iss).toBe(ISSUER);
    expect(claims?.entries).toEqual([{ id: "key-one", notValidAfter: "2026-03-01T00:00:00.000Z" }]);
  });

  // A revocation list is only useful to somebody on another origin.
  it("is fetchable cross-origin and cached briefly", async () => {
    const res = await GET(request());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("cache-control")).toMatch(/max-age=300/);
  });

  // A verifier must not be able to check a revocation list as though it were a
  // receipt, or the reverse. Pinned because both are signed by the same key.
  it("cannot be verified as a receipt", async () => {
    const signer = loadInstanceSigner();
    const body = await (await GET(request())).text();
    expect(verifyCompactJws(body, signer!.publicKey, { typ: "passcontrol-receipt+jws" })).toBeNull();
  });
});

describe("what it does when it cannot answer", () => {
  // The whole point of the document is that it is signed. An unsigned one, or
  // one from an instance with no key, could be served by anyone with the entry
  // that matters left out.
  it("refuses to publish a list it cannot sign", async () => {
    delete process.env.INSTANCE_SIGNING_KEY;
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "signing_not_configured" } });
  });

  it("refuses when it has no verifiable issuer to name", async () => {
    delete process.env.PASSCONTROL_ISSUER;
    expect((await GET(request())).status).toBe(503);
  });

  // THE ONE THAT MATTERS. An empty list is not "we cannot say" — it is the
  // positive claim "nothing has been revoked". Serving it during an outage
  // tells a verifier that a passport we know to be dead is fine.
  it("errors rather than serving an empty list when the read fails", async () => {
    db({ data: null, error: { code: "57014" } }, { data: AGENTS, error: null });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "revocation_list_unavailable" } });

    db({ data: REVOKED, error: null }, { data: null, error: { code: "57014" } });
    expect((await GET(request())).status).toBe(503);
  });

  // A genuinely empty list is a different thing from a failed one, and it is a
  // statement this instance is entitled to make.
  it("publishes an empty list when nothing has actually been revoked", async () => {
    db({ data: [], error: null }, { data: AGENTS, error: null });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await payloadOf(res))?.entries).toEqual([]);
  });

  it("never caches an error", async () => {
    delete process.env.INSTANCE_SIGNING_KEY;
    expect((await GET(request())).headers.get("cache-control")).toBe("no-store");
  });
});

// Every other unauthenticated public read in this codebase is throttled, and
// lookupPublicPassport puts the limiter INSIDE the lookup so a caller cannot
// forget it. Same pattern here, for a stronger reason: each request runs
// queries against admin_audit and agents, and on a self-hosted instance there
// is no CDN in front to absorb repeats.
describe("cost of being asked", () => {
  it("throttles per caller, and says so distinctly from an outage", async () => {
    rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    const res = await GET(request());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: { code: "rate_limited" } });
  });

  it("never reaches the database when throttled", async () => {
    rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    await GET(request());
    expect(fromMock).not.toHaveBeenCalled();
  });

  // The queries are narrowed SERVER-side. Pulling every agent.update row to
  // keep the handful that are rotations would scan a table that grows with
  // every budget, scope and expiry change a tenant makes.
  it("asks the database only for the rows it can publish", async () => {
    await GET(request());
    const audit = filters.filter((f) => f.table === "admin_audit");
    expect(audit).toHaveLength(2);
    expect(audit[0]?.eq).toContainEqual(["action", "agent.revoke"]);
    expect(audit[0]?.eq).toContainEqual(["target_type", "agent"]);
    expect(audit[1]?.eq).toContainEqual(["action", "agent.update"]);
    expect(audit[1]?.eq).toContainEqual(["metadata->>rotated", "true"]);

    // Only revoked agents can contribute a passport id, so the cross-tenant
    // read is bounded to them rather than to the whole fleet.
    const agents = filters.find((f) => f.table === "agents");
    expect(agents?.eq).toContainEqual(["status", "revoked"]);
    expect(agents?.not).toHaveLength(1);
  });
});
