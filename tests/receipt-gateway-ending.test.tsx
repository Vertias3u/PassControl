import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as receipts from "@/lib/receipt";
import { ReceiptDocument } from "@/components/ReceiptVerifier";
import { bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner, publicJwk } from "@/lib/crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws } from "@/lib/crypto/jws";
import { verifyReceipt, type ReceiptClaims } from "@/sdk/verify";
// @ts-expect-error The standalone CLI is intentionally plain ESM without a TypeScript declaration.
import { verifyReceipt as cliVerify } from "../cli/verify.mjs";

const issuer = "https://gateway.example";
const base = {
  receiptId: "receipt-1", agentId: "agent-1", provider: "svc:github",
  method: "POST", path: "repos/acme/web/actions/runs/42/cancel", rawBody: null,
  inputTokens: 0, outputTokens: 0, costMicrocents: 0, callClass: "svc" as const,
  status: "ok" as const, httpStatus: 202, startedAt: 1700000000000, latencyMs: 25,
};
const ending = { thing: "thing-1", kind: "github_workflow_run", trigger: "kill_switch" as const, stoppedAt: 1700000000 };
const end = { thg: ending.thing, knd: ending.kind, trg: ending.trigger, sat: ending.stoppedAt };
const claims = () => ({
  iss: issuer, sub: "gateway", jti: "receipt-1", iat: 1700000000, agid: "agent-1",
  prov: base.provider, mdl: null, mth: base.method, path: base.path,
  use: { in: 0, out: 0 }, cost: 0, cls: "svc", res: { status: "ok", http: 202 },
  t0: base.startedAt, lat: 25, ver: 4, auth: { kind: "gateway_ending" }, end,
});
function signed(c: Record<string, unknown>) {
  const signer = loadInstanceSigner()!;
  return signCompactJws({ typ: RECEIPT_TYP, kid: signer.kid, seed: signer.seed, claims: c });
}
function fetchJwks() {
  return Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk(loadInstanceSigner()!.publicKey)] })));
}

beforeEach(() => {
  vi.stubEnv("INSTANCE_SIGNING_KEY", bytesToBase64url(new Uint8Array(32).fill(9)));
  vi.stubEnv("PASSCONTROL_ISSUER", issuer);
  vi.spyOn(Date, "now").mockReturnValue(1700000000000);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("gateway ending issuance", () => {
  it("pins v4 and signs only the gateway identity and ending", () => {
    expect((receipts as Record<string, unknown>).GATEWAY_ENDING_RECEIPT_VER).toBe(4);
    expect(receipts.buildReceiptClaims({ ...base, authMethod: "gateway_ending", ending })).toEqual(claims());
  });
  it("always has zero usage, zero cost and the service class", () => {
    const c = receipts.buildReceiptClaims({ ...base, authMethod: "gateway_ending", ending,
      inputTokens: 8, outputTokens: 9, cacheReadTokens: 2, cacheWriteTokens: 3,
      costMicrocents: 99, callClass: undefined });
    expect(c).toMatchObject({ use: { in: 0, out: 0 }, cost: 0, cls: "svc" });
    expect(c.use).toEqual({ in: 0, out: 0 });
  });
  it("keeps the full v1 claim object unchanged", () => {
    const { auth: _auth, end: _end, ...expected } = claims();
    expect(receipts.buildReceiptClaims({ ...base, passportId: "passport-1", visaJti: "visa-1" }))
      .toEqual({ ...expected, ver: 1, sub: "passport-1", vjti: "visa-1" });
  });
  it("signs a receipt the SDK actually accepts", async () => {
    const token = receipts.signReceipt({ ...base, authMethod: "gateway_ending", ending });
    expect(token).toBeTruthy();
    const result = await verifyReceipt(token!, { trustedIssuers: [issuer], fetch: fetchJwks });
    expect(result).toEqual({ ok: true, claims: claims() });
  });
});

for (const [name, verify] of [
  ["SDK", (jws: string) => verifyReceipt(jws, { trustedIssuers: [issuer], fetch: fetchJwks })],
  ["CLI", (jws: string) => cliVerify(jws, { issuer, fetch: fetchJwks })],
] as const) {
  describe(`${name} gateway ending verification`, () => {
    it.each(["kill_switch", "session", "service", "mission_end", "budget_pause"])("exposes its own identity and %s ending", async (trigger) => {
      const c = { ...claims(), end: { ...end, trg: trigger } };
      expect(await verify(signed(c))).toEqual({ ok: true, claims: c });
    });
    it("keeps unknown additive claims readable within v4", async () => {
      const c = { ...claims(), future: "metadata", auth: { kind: "gateway_ending", future: "metadata" } };
      expect(await verify(signed(c))).toEqual({ ok: true, claims: c });
    });
    it.each([
      { vjti: "visa" }, { vjti: null }, { act: "worker" }, { sub: "P".repeat(43) },
      { end: undefined }, { end: null }, { end: {} }, { auth: undefined },
      { auth: { kind: "direct_key", kid: "key", use: "use" } },
      { auth: { kind: "gateway_ending", act: "worker" } },
      { passportId: "passport" }, { agentAccessKeyId: "key" },
      { end: { ...end, trg: "invented" } }, { end: { ...end, sat: -1 } },
      { end: { ...end, sat: 1.5 } }, { end: { ...end, thg: "" } },
    ])("rejects conflicting or missing claims: %j", async (patch) => {
      expect(await verify(signed({ ...claims(), ...patch }))).toEqual({ ok: false, reason: "claims" });
    });
  });
}

it.each([
  ["kill_switch", "kill switch"], ["session", "session stop"],
  ["service", "service stop"], ["mission_end", "mission end"],
  ["budget_pause", "budget pause line"],
])("renders the actual receipt document for %s without agent authentication wording", (trigger, label) => {
  const html = renderToStaticMarkup(<ReceiptDocument claims={{ ...claims(), end: { ...end, trg: trigger } } as ReceiptClaims} />);
  const text = html.replace(/<[^>]*>/g, "").replace(/&#x27;|&#39;|&apos;/g, "'");
  expect(text).toContain(`Ended by PassControl on the owner's stop (${label})`);
  expect(text).toContain("not a call by the agent. No passport or agent key signed it.");
  expect(text).not.toMatch(/passport-signed|agent called|Passport verified|Agent passport|this passport's public key/i);
});
