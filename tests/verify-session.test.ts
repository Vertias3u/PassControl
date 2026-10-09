// Session receipts (sprint Bet B, D4): one signed seal over every receipt in one
// working session, checkable against the user's OWN record of their calls.
//
// Four checks, in this order, identical in both verifiers (sdk/verify.ts for apps,
// cli/verify.mjs for `passcontrol verify session`), pinned here to agree case by case:
//   1. signature   the seal verifies against the issuer's published key
//   2. bundle      the root and every total recompute from the bundle
//   3. receipts    every receipt in the bundle verifies and belongs to the session
//   4. journal     every receipt id the user's sidecar journaled is in the bundle
//
// Check 4 is the new guarantee. A missing journaled id is reported as MISSING, never as
// tampering: the gateway's log write is best-effort, so a lost row and an omission look
// the same from here. The reverse (in the bundle, not in the journal) is reported and
// never fails: failover predecessors, direct calls, calls from another machine.
import { beforeEach, describe, expect, it } from "vitest";

import { bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner, publicJwk } from "@/lib/crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws } from "@/lib/crypto/jws";
import { merkleLeaf, merkleRoot } from "@/lib/merkle";
import { STATEMENT_TYP } from "@/lib/statement";
import { SESSION_PROTOCOL } from "@/cli/protocols.mjs";
import * as sdk from "@/sdk/verify";
// @ts-expect-error CLI is intentionally plain ESM; its exports are pinned by this test.
import * as cli from "../cli/verify.mjs";

const SEED = bytesToBase64url(new Uint8Array(32).fill(9));
const ISSUER = "https://gw.example.com";
const AGENT = "f9de697b-6b2f-4d29-9978-0ff9547f15f3";
const SES = "00000000-0000-4000-8000-000000000001";
const FROM = Math.floor(Date.UTC(2026, 9, 8, 1, 0) / 1000);
const TO = FROM + 3600;

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = SEED;
  process.env.PASSCONTROL_ISSUER = ISSUER;
});

const sign = (typ: string, claims: Record<string, unknown>) => {
  const s = loadInstanceSigner()!;
  return signCompactJws({ typ, kid: s.kid, claims, seed: s.seed });
};

type R = { id: string; agt?: string | null; par?: string | null; cost?: number; mdl?: string; status?: string; unp?: boolean; prev?: string; ses?: string | null; agid?: string; t0?: number; iss?: string };
const receipt = (r: R) =>
  sign(RECEIPT_TYP, {
    iss: r.iss ?? ISSUER,
    sub: "passport-id",
    jti: r.id,
    iat: FROM + 60,
    agid: r.agid ?? AGENT,
    prov: "anthropic",
    mdl: r.mdl ?? "claude-sonnet-5",
    mth: "POST",
    path: "/v1/messages",
    use: { in: 10, out: 5 },
    cost: r.cost ?? 1000,
    ...(r.unp ? { unp: true } : {}),
    res: { status: r.status ?? "ok", http: r.status && r.status !== "ok" ? 403 : 200 },
    t0: r.t0 ?? (FROM + 60) * 1000,
    lat: 100,
    ver: 1,
    ...(r.prev ? { prev: r.prev } : {}),
    ...(r.ses === null ? {} : { ctx: { src: "declared", cli: "claude-code", ses: r.ses ?? SES, ...(r.agt ? { agt: r.agt } : {}), ...(r.par ? { par: r.par } : {}) } }),
  });

type Node = { agt: string | null; par: string | null; n: number; cost: number; refused: number };
/** The seal the issuer WOULD sign over this bundle, derived independently of the verifiers. */
function honestClaims(bundle: string[], specs: R[]) {
  const root = merkleRoot(bundle.map(merkleLeaf));
  const tree = new Map<string, Node>();
  const mdl = new Map<string, { mdl: string; n: number; cost: number }>();
  for (const r of specs) {
    const key = `${r.agt ?? ""}|${r.par ?? ""}`;
    const node = tree.get(key) ?? { agt: r.agt ?? null, par: r.par ?? null, n: 0, cost: 0, refused: 0 };
    node.n += 1;
    node.cost += r.cost ?? 1000;
    if ((r.status ?? "ok").startsWith("blocked_")) node.refused += 1;
    tree.set(key, node);
    const m = mdl.get(r.mdl ?? "claude-sonnet-5") ?? { mdl: r.mdl ?? "claude-sonnet-5", n: 0, cost: 0 };
    m.n += 1;
    m.cost += r.cost ?? 1000;
    mdl.set(m.mdl, m);
  }
  return {
    iss: ISSUER,
    sub: AGENT,
    jti: "seal-1",
    iat: TO + 10,
    fmt: "passcontrol.session",
    v: 1,
    ses: { id: SES, src: "claude-code" },
    per: { from: FROM, to: TO },
    n: bundle.length,
    nr: bundle.length,
    cost: specs.reduce((s, r) => s + (r.cost ?? 1000), 0),
    unp: specs.filter((r) => r.unp).length,
    unk: 0,
    root: root ? bytesToBase64url(root) : null,
    tree: [...tree.values()],
    mdl: [...mdl.values()],
  };
}
const seal = (claims: Record<string, unknown>, typ = "passcontrol-session+jws") => sign(typ, claims);

const SPECS: R[] = [
  { id: "r-main-1" },
  { id: "r-sub-1", agt: "a0000000000000001" },
  { id: "r-nested-1", agt: "a0000000000000002", par: "a0000000000000001", mdl: "claude-haiku-4-5", cost: 200 },
  { id: "r-main-2", status: "blocked_scope", cost: 0 },
];
const build = (specs = SPECS) => {
  const bundle = specs.map(receipt);
  return { bundle, claims: honestClaims(bundle, specs) };
};

const jwks = () => {
  const s = loadInstanceSigner()!;
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    return { ok: true, json: async () => ({ keys: [publicJwk(s.publicKey)] }) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
};

const VERIFIERS = [
  ["sdk/verify.ts", (input: unknown, f: typeof fetch) => sdk.verifySession(input as never, { trustedIssuers: [ISSUER], fetch: f })],
  ["cli/verify.mjs", (input: unknown, f: typeof fetch) => cli.verifySession(input, { issuer: ISSUER, fetch: f })],
] as const;

/** Run one case through BOTH verifiers and require the same answer from each. */
async function both(input: { seal: string; bundle: string[]; journal?: unknown }) {
  const out = [];
  for (const [, run] of VERIFIERS) out.push(await run(input, jwks().fetch));
  const strip = (r: Record<string, unknown>) => ({ ...r, claims: r.claims ? "present" : "absent" });
  expect(strip(out[1] as Record<string, unknown>)).toEqual(strip(out[0] as Record<string, unknown>));
  return out[0] as Awaited<ReturnType<typeof sdk.verifySession>>;
}

describe("a genuine session", () => {
  it("passes all four checks when the journal matches the bundle exactly", async () => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal(claims), bundle, journal: SPECS.map((s) => ({ id: s.id, t: 1, s: 200 })) });
    expect(r).toMatchObject({
      ok: true,
      checks: { signature: true, bundle: true, receipts: true, journal: true },
      mismatched: [],
      rejected: [],
      missing: [],
      unjournaled: [],
    });
    expect(r.claims?.ses.id).toBe(SES);
  });

  it("accepts plain string ids as a journal", async () => {
    const { bundle, claims } = build();
    expect((await both({ seal: seal(claims), bundle, journal: SPECS.map((s) => s.id) })).ok).toBe(true);
  });

  it("without a journal: three checks, and the result says the fourth was not run", async () => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal(claims), bundle });
    expect(r.ok).toBe(true);
    expect(r.checks.journal).toBeNull();
  });

  it("an empty session: no receipts, a null root", async () => {
    const { bundle, claims } = build([]);
    expect(claims.root).toBeNull();
    expect((await both({ seal: seal(claims), bundle, journal: [] })).ok).toBe(true);
  });

  it("fetches the issuer's keys once, not once per receipt", async () => {
    const { bundle, claims } = build();
    for (const [, run] of VERIFIERS) {
      const j = jwks();
      await run({ seal: seal(claims), bundle }, j.fetch);
      expect(j.calls()).toBe(1);
    }
  });
});

// One sidecar run serves many sessions (2026-10-08 E2E: a day-long sidecar's journal
// made every seal report the other sessions' calls as "missing"). The sidecar now writes
// each call's declared session (`ses`); a seal is checked against its own session's lines.
describe("check 4 with a journal several sessions share", () => {
  it("ignores other sessions' calls, and says how many", async () => {
    const { bundle, claims } = build();
    const journal = [
      ...SPECS.map((s) => ({ id: s.id, t: 1, s: 200, ses: SES })),
      { id: "r-other-1", t: 1, s: 200, ses: "another-session" },
      { id: "r-other-2", t: 1, s: 403, ses: "another-session" },
    ];
    const r = await both({ seal: seal(claims), bundle, journal });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.otherSessions).toBe(2);
  });

  it("still catches a call of THIS session that the seal left out", async () => {
    const { bundle, claims } = build();
    const journal = [...SPECS.map((s) => ({ id: s.id, t: 1, s: 200, ses: SES })), { id: "r-left-out", t: 1, s: 200, ses: SES }];
    const r = await both({ seal: seal(claims), bundle, journal });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["r-left-out"]);
  });

  it("checks a line that names no session, as before", async () => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal(claims), bundle, journal: [...SPECS.map((s) => ({ id: s.id })), { id: "r-left-out" }] });
    expect(r.missing).toEqual(["r-left-out"]);
    expect(r.otherSessions).toBe(0);
  });
});

describe("check 4: the journal", () => {
  it("a journaled id the seal left out is MISSING, and fails the session", async () => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal(claims), bundle, journal: [...SPECS.map((s) => s.id), "r-left-out"] });
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual({ signature: true, bundle: true, receipts: true, journal: false });
    expect(r.missing).toEqual(["r-left-out"]);
  });

  it("a bundle receipt the journal never saw is reported, never a failure", async () => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal(claims), bundle, journal: ["r-main-1", "r-sub-1", "r-nested-1"] });
    expect(r.ok).toBe(true);
    expect(r.unjournaled).toEqual([{ id: "r-main-2", why: "not_in_journal" }]);
  });

  it("failover: the journal holds the final attempt; its predecessor is named as such", async () => {
    const specs: R[] = [{ id: "r-first", status: "upstream_error", cost: 0 }, { id: "r-final", prev: "r-first" }];
    const { bundle, claims } = build(specs);
    const r = await both({ seal: seal(claims), bundle, journal: ["r-final"] });
    expect(r.ok).toBe(true);
    expect(r.unjournaled).toEqual([{ id: "r-first", why: "failover_predecessor" }]);
  });

  it("a journaled id reached only through a bundle receipt's prev link counts as present", async () => {
    const specs: R[] = [{ id: "r-final", prev: "r-first-lost" }];
    const { bundle, claims } = build(specs);
    const r = await both({ seal: seal(claims), bundle, journal: ["r-first-lost", "r-final"] });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("an unreadable journal fails check 4 rather than being half-read", async () => {
    const { bundle, claims } = build();
    for (const journal of [[{ id: 42 }], [null], "r-main-1", [{}]]) {
      const r = await both({ seal: seal(claims), bundle, journal });
      expect(r.ok).toBe(false);
      expect(r.checks.journal).toBe(false);
      expect(r.reason).toBe("malformed_journal");
    }
  });
});

describe("check 2: the bundle", () => {
  it("a receipt dropped from the bundle no longer recomputes the root", async () => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal(claims), bundle: bundle.slice(1) });
    expect(r.ok).toBe(false);
    expect(r.checks.bundle).toBe(false);
    expect(r.mismatched).toContain("root");
  });

  it.each([
    ["cost", { cost: 1 }],
    ["n", { n: 99 }],
    ["unp", { unp: 3 }],
    ["tree", { tree: [{ agt: null, par: null, n: 4, cost: 2200, refused: 0 }] }],
    ["mdl", { mdl: [{ mdl: "claude-sonnet-5", n: 4, cost: 2200 }] }],
  ])("a seal whose %s disagrees with its own bundle is caught", async (field, over) => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal({ ...claims, ...over }), bundle });
    expect(r.ok).toBe(false);
    expect(r.checks.bundle).toBe(false);
    expect(r.mismatched).toContain(field);
  });

  it("tree and model lists are compared as sets, in any order", async () => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal({ ...claims, tree: [...claims.tree].reverse(), mdl: [...claims.mdl].reverse() }), bundle });
    expect(r.ok).toBe(true);
  });

  it("unpriced calls count in unp; their cost is the issuer's zero, not a price", async () => {
    const specs: R[] = [{ id: "r-1" }, { id: "r-2", unp: true, cost: 0 }];
    const { bundle, claims } = build(specs);
    expect(claims.unp).toBe(1);
    expect((await both({ seal: seal(claims), bundle })).ok).toBe(true);
  });
});

describe("check 3: every receipt verifies and belongs", () => {
  it.each([
    ["other_session", { ses: "00000000-0000-4000-8000-000000000999" }],
    ["other_session", { ses: null }],
    ["other_agent", { agid: "11111111-1111-4111-8111-111111111111" }],
    ["outside_period", { t0: (TO + 1) * 1000 }],
    ["outside_period", { t0: (FROM - 1) * 1000 }],
    ["untrusted_issuer", { iss: "https://evil.example.com" }],
  ] as const)("refuses a receipt with %s", async (reason, over) => {
    const specs: R[] = [{ id: "r-1" }, { id: "r-odd", ...over }];
    const { bundle, claims } = build(specs);
    const r = await both({ seal: seal(claims), bundle });
    expect(r.ok).toBe(false);
    expect(r.checks.receipts).toBe(false);
    expect(r.rejected).toEqual([{ index: 1, id: "r-odd", reason }]);
  });

  it("refuses a receipt whose contents were changed after signing", async () => {
    const { bundle } = build();
    const [h, p, s] = bundle[0]!.split(".");
    const original = JSON.parse(Buffer.from(p!, "base64url").toString());
    const forgedPayload = Buffer.from(JSON.stringify({ ...original, cost: 0 })).toString("base64url");
    const forged = [`${h}.${forgedPayload}.${s}`, ...bundle.slice(1)];
    const specs = [{ ...SPECS[0]!, cost: 0 }, ...SPECS.slice(1)];
    const r = await both({ seal: seal(honestClaims(forged, specs)), bundle: forged });
    expect(r.checks.receipts).toBe(false);
    expect(r.rejected[0]).toMatchObject({ index: 0, reason: "bad_signature" });
  });

  it("refuses the same receipt twice", async () => {
    const specs: R[] = [{ id: "r-1" }, { id: "r-1" }];
    const { bundle, claims } = build(specs);
    const r = await both({ seal: seal(claims), bundle });
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual([{ index: 1, id: "r-1", reason: "duplicate" }]);
  });

  it("refuses a seal presented as a receipt inside the bundle", async () => {
    const { bundle, claims } = build([{ id: "r-1" }]);
    const intruder = seal(claims);
    const withIntruder = [...bundle, intruder];
    const r = await both({ seal: seal({ ...claims, n: 2, nr: 2, root: bytesToBase64url(merkleRoot(withIntruder.map(merkleLeaf))!) }), bundle: withIntruder });
    expect(r.rejected.find((x) => x.index === 1)?.reason).toBe("wrong_type");
  });
});

describe("check 1: the seal itself", () => {
  it("refuses a statement or a receipt presented as a session seal", async () => {
    const { bundle, claims } = build();
    for (const typ of [STATEMENT_TYP, RECEIPT_TYP]) {
      const r = await both({ seal: seal(claims, typ), bundle });
      expect(r).toMatchObject({ ok: false, reason: "wrong_type", checks: { signature: false, bundle: null, receipts: null, journal: null } });
    }
  });

  it("refuses a seal newer than it understands, on the session's own version line", async () => {
    const { bundle, claims } = build();
    const r = await both({ seal: seal({ ...claims, v: SESSION_PROTOCOL.maximum + 1 }), bundle });
    expect(r.reason).toBe("unsupported_version");
  });

  it("refuses a seal altered after signing", async () => {
    const { bundle, claims } = build();
    const [h, , s] = seal(claims).split(".");
    const r = await both({ seal: `${h}.${Buffer.from(JSON.stringify({ ...claims, cost: 0 })).toString("base64url")}.${s}`, bundle });
    expect(r.reason).toBe("bad_signature");
  });

  it("refuses garbage without throwing", async () => {
    for (const bad of ["", "a.b", "not.a.jws"]) {
      expect((await both({ seal: bad, bundle: [] })).reason).toBe("malformed");
    }
  });
});

describe("protocol", () => {
  it("both verifiers gate on SESSION_PROTOCOL", () => {
    expect(sdk.SESSION_SUPPORTED_VER).toBe(SESSION_PROTOCOL.maximum);
    expect(cli.SESSION_SUPPORTED_VER).toBe(SESSION_PROTOCOL.maximum);
    expect(sdk.SESSION_TYP).toBe("passcontrol-session+jws");
    expect(cli.SESSION_TYP).toBe("passcontrol-session+jws");
  });

  it("both verifiers word the session failures the same way", () => {
    for (const k of ["malformed_journal", "other_session", "other_agent", "outside_period", "duplicate"]) {
      expect(typeof cli.FAILURE_REASONS[k]).toBe("string");
    }
  });
});
