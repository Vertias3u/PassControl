// Checking a session seal on the web (sprint T9, owner D10: yes). The page runs
// sdk/verify.ts's verifySession in the visitor's browser; this module turns its
// answer into the four checks, each ✓, ✗ or "not run", and the agent tree, in the
// CLI's words (`passcontrol verify session`). Built on REAL seals and receipts
// signed here, so a check that passes is the verifier passing, not a fixture.
import { beforeEach, describe, expect, it } from "vitest";
import { bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner, publicJwk } from "@/lib/crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws } from "@/lib/crypto/jws";
import { merkleLeaf, merkleRoot } from "@/lib/merkle";
import { verifySession } from "@/sdk/verify";
import { describeSessionCheck, parseJournalText, parseSealDocument, peekSealIssuer } from "@/lib/verify/session-view";

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
type R = { id: string; agt?: string; par?: string; cost?: number; status?: string };
const receipt = (r: R) =>
  sign(RECEIPT_TYP, {
    iss: ISSUER, sub: "passport-id", jti: r.id, iat: FROM + 60, agid: AGENT, prov: "anthropic", mdl: "claude-sonnet-5",
    mth: "POST", path: "/v1/messages", use: { in: 10, out: 5 }, cost: r.cost ?? 1000,
    res: { status: r.status ?? "ok", http: r.status ? 403 : 200 }, t0: (FROM + 60) * 1000, lat: 100, ver: 1,
    ctx: { src: "declared", cli: "claude-code", ses: SES, ...(r.agt ? { agt: r.agt } : {}), ...(r.par ? { par: r.par } : {}) },
  });
const SPECS: R[] = [{ id: "r-main-1" }, { id: "r-sub-1", agt: "a01" }, { id: "r-main-2", status: "blocked_scope", cost: 0 }];
function sealOver(bundle: string[], specs: R[]) {
  const tree = new Map<string, { agt: string | null; par: string | null; n: number; cost: number; refused: number }>();
  for (const r of specs) {
    const key = `${r.agt ?? ""}|${r.par ?? ""}`;
    const node = tree.get(key) ?? { agt: r.agt ?? null, par: r.par ?? null, n: 0, cost: 0, refused: 0 };
    node.n += 1;
    node.cost += r.cost ?? 1000;
    if (r.status?.startsWith("blocked_")) node.refused += 1;
    tree.set(key, node);
  }
  return sign("passcontrol-session+jws", {
    iss: ISSUER, sub: AGENT, jti: "seal-1", iat: TO + 10, fmt: "passcontrol.session", v: 1,
    ses: { id: SES, src: "claude-code" }, per: { from: FROM, to: TO }, n: bundle.length, nr: bundle.length,
    cost: specs.reduce((s, r) => s + (r.cost ?? 1000), 0), unp: 0, unk: 0,
    root: bytesToBase64url(merkleRoot(bundle.map(merkleLeaf))!), tree: [...tree.values()],
    mdl: [{ mdl: "claude-sonnet-5", n: specs.length, cost: specs.reduce((s, r) => s + (r.cost ?? 1000), 0) }],
  });
}
const fetchKeys = (async () => ({ ok: true, json: async () => ({ keys: [publicJwk(loadInstanceSigner()!.publicKey)] }) })) as unknown as typeof fetch;
async function check(input: { seal: string; bundle: string[]; journal?: unknown }) {
  const result = await verifySession(input, { trustedIssuers: [ISSUER], fetch: fetchKeys });
  return describeSessionCheck(result, input.bundle.length);
}
const honest = () => {
  const bundle = SPECS.map(receipt);
  return { seal: sealOver(bundle, SPECS), bundle };
};
const row = (v: Awaited<ReturnType<typeof check>>, name: string) => v.rows.find((r) => r.name === name)!;

describe("describeSessionCheck", () => {
  it("passes all four checks for an honest seal with its journal, and draws the tree", async () => {
    const { seal, bundle } = honest();
    const v = await check({ seal, bundle, journal: SPECS.map((s) => ({ id: s.id, ses: SES })) });
    expect(v.verdict).toBe("valid");
    expect(v.rows.map((r) => [r.name, r.state])).toEqual([
      ["signature", "pass"], ["bundle", "pass"], ["receipts", "pass"], ["journal", "pass"],
    ]);
    expect(v.session).toEqual({ id: SES, note: "declared by the client (claude-code), not verified" });
    expect(v.tree.map((n) => n.who)).toEqual(["main agent", "sub-agent a01"]);
    expect(v.tree[0]).toMatchObject({ calls: 2, refused: 1 });
  });

  it("says a seal checked without a journal proves no more than a statement", async () => {
    const v = await check(honest());
    expect(row(v, "journal").state).toBe("not-run");
    expect(row(v, "journal").detail.join(" ")).toMatch(/no more than a statement/i);
    expect(v.verdict).toBe("valid");
  });

  it("fails the bundle check, by name, when a receipt was dropped from the bundle", async () => {
    const { seal, bundle } = honest();
    const v = await check({ seal, bundle: bundle.slice(0, 2) });
    expect(v.verdict).toBe("failed");
    expect(row(v, "signature").state).toBe("pass");
    expect(row(v, "bundle").state).toBe("fail");
    expect(row(v, "bundle").detail.join(" ")).toMatch(/root|n|cost/);
  });

  it("fails the journal check and lists what the sidecar recorded but the seal lacks", async () => {
    const { seal, bundle } = honest();
    const v = await check({ seal, bundle, journal: [...SPECS.map((s) => s.id), "r-left-out"] });
    expect(row(v, "journal").state).toBe("fail");
    expect(row(v, "journal").detail.join(" ")).toContain("r-left-out");
    expect(row(v, "journal").detail.join(" ")).toMatch(/lost record/i);
  });

  it("fails the receipts check for a receipt from another session", async () => {
    const bundle = SPECS.map(receipt);
    const stranger = sign(RECEIPT_TYP, { ...JSON.parse(Buffer.from(bundle[0]!.split(".")[1]!, "base64url").toString()), jti: "r-x", ctx: { src: "declared", cli: "claude-code", ses: "other" } });
    const all = [...bundle, stranger];
    const v = await check({ seal: sealOver(all, [...SPECS, { id: "r-x" }]), bundle: all });
    expect(row(v, "receipts").state).toBe("fail");
    expect(row(v, "receipts").detail.join(" ")).toMatch(/not from the sealed session/i);
  });

  it("is invalid, with the later checks not run, when the seal itself was altered", async () => {
    const { seal, bundle } = honest();
    const [h, p, s] = seal.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const forged = [h, Buffer.from(JSON.stringify({ ...claims, cost: 1 })).toString("base64url"), s].join(".");
    const v = await check({ seal: forged, bundle });
    expect(v.verdict).toBe("invalid");
    expect(row(v, "signature").state).toBe("fail");
    for (const name of ["bundle", "receipts", "journal"]) expect(row(v, name).state).toBe("not-run");
  });
});

describe("parsing what the visitor pastes", () => {
  it("reads the dashboard's download and the control API's saved response", () => {
    expect(parseSealDocument(JSON.stringify({ seal: "a.b.c", bundle: ["x"] }))).toEqual({ ok: true, seal: "a.b.c", bundle: ["x"] });
    expect(parseSealDocument(JSON.stringify({ data: { seal: "a.b.c", bundle: [] } }))).toEqual({ ok: true, seal: "a.b.c", bundle: [] });
  });

  it.each(["", "not json", "[]", JSON.stringify({ seal: 5, bundle: [] }), JSON.stringify({ seal: "a.b.c", bundle: "x" }), JSON.stringify({ seal: "a.b.c", bundle: [1] })])(
    "refuses what is not a seal file (%j)",
    (text) => {
      expect(parseSealDocument(text).ok).toBe(false);
    }
  );

  it("reads a journal one JSON line at a time, passing an unreadable line through for the verifier to reject", () => {
    expect(parseJournalText('{"id":"a","t":1}\n\n{"id":"b"}\n')).toEqual([{ id: "a", t: 1 }, { id: "b" }]);
    expect(parseJournalText('{"id":"a"}\nnot json')).toEqual([{ id: "a" }, "not json"]);
    expect(parseJournalText("   ")).toBeUndefined();
  });

  it("peeks the issuer a seal names, or null", () => {
    expect(peekSealIssuer(honest().seal)).toBe(ISSUER);
    expect(peekSealIssuer("nope")).toBeNull();
  });
});

describe("the agent tree", () => {
  const result = (tree: unknown[]) =>
    ({
      ok: true,
      checks: { signature: true, bundle: true, receipts: true, journal: null },
      claims: { ses: { id: "s", src: "codex" }, tree },
      mismatched: [], rejected: [], missing: [], unjournaled: [], otherSessions: 0,
    }) as never;

  it("nests each sub-agent under the agent that spawned it", () => {
    const v = describeSessionCheck(
      result([
        { agt: "a2", par: "a1", n: 1, cost: 5, refused: 0 },
        { agt: null, par: null, n: 3, cost: 10, refused: 1 },
        { agt: "a1", par: null, n: 2, cost: 7, refused: 0 },
      ]),
      6
    );
    expect(v.tree.map((r) => [r.who, r.depth])).toEqual([["main agent", 0], ["sub-agent a1", 0], ["sub-agent a2", 1]]);
  });

  it("still shows a sub-agent whose declared parent made no calls, and says so", () => {
    const v = describeSessionCheck(result([{ agt: "a9", par: "ghost", n: 1, cost: 1, refused: 0 }]), 1);
    expect(v.tree[0]!.who).toMatch(/declared parent ghost made no calls/);
  });

  it("cannot be made to loop by a cycle", () => {
    const v = describeSessionCheck(result([{ agt: "x", par: "y", n: 1, cost: 1, refused: 0 }, { agt: "y", par: "x", n: 1, cost: 1, refused: 0 }]), 2);
    expect(v.tree.length).toBeLessThanOrEqual(2);
  });
});
