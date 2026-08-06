// The inspection sequence is the evidence panel on a page whose entire job is to
// let a stranger check a signature. A row saying a check passed is a claim, and
// it has to be exactly as reliable as the verifier's own verdict.
//
// It was not. The component drove these transitions inline, reading a mutable
// counter from inside a React setState updater — which React invokes lazily,
// after the counter has advanced — so every result landed one row late. The
// visible consequence was the worst one available: a receipt with a tampered
// `cost` rendered "Signature matches the contents ✓" against a GREEN rail,
// directly above the red card saying the receipt had been altered.
//
// These tests drive the real verifier and feed its real trace through the
// reducer, so they fail if the rows ever again disagree with the verdict.
import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ALL_FAILURES,
  applyStep,
  describeFailure,
  initialStepRows,
  rowsFailingAt,
  STEP_ORDER,
  totalCheckMs,
  type StepRow,
} from "@/lib/verify/receipt-view";
import { verifyReceipt, type VerifyStep } from "@/sdk/verify";

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const ISSUER = "https://issuer.test";
const SEED = new Uint8Array(32).fill(7);
const PUBLIC_KEY = ed25519.getPublicKey(SEED);

const CLAIMS = {
  iss: ISSUER,
  sub: "kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8",
  jti: "12bbf7f5-068e-4497-9183-88fbef4544a2",
  iat: 1785958835,
  agid: "b5d5014d-5e9a-4836-8a41-16ef9e70d3e8",
  vjti: "3dda94b3-bb54-46ad-bf8d-fc5be98a64f8",
  prov: "demo",
  mdl: "demo-1",
  mth: "POST",
  path: "chat/completions",
  use: { in: 15, out: 46 },
  cost: 61,
  res: { status: "ok", http: 200 },
  t0: 1785958835348,
  lat: 60,
  ver: 1,
};

const HEADER = { alg: "EdDSA", typ: "passcontrol-receipt+jwt", kid: "k1" };

function sign(header: object, claims: object): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  return `${h}.${p}.${b64url(ed25519.sign(new TextEncoder().encode(`${h}.${p}`), SEED))}`;
}

const GOOD = sign(HEADER, CLAIMS);

/** Re-signs nothing: swaps the payload and keeps the original signature. */
function tamper(jws: string, mutate: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = jws.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  mutate(claims);
  return [header, b64url(JSON.stringify(claims)), signature].join(".");
}

const jwksFetch = () =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: b64url(PUBLIC_KEY), kid: "k1" }] }),
        { status: 200 }
      )
  );

async function trace(jws: string): Promise<VerifyStep[]> {
  const steps: VerifyStep[] = [];
  await verifyReceipt(jws, {
    trustedIssuers: [ISSUER],
    fetch: jwksFetch() as unknown as typeof fetch,
    onStep: (s) => steps.push(s),
  });
  return steps;
}

/** Exactly what the component's presenter loop does, minus the pacing. */
function replay(steps: VerifyStep[]): StepRow[] {
  let rows = initialStepRows();
  steps.forEach((step, i) => {
    rows = applyStep(rows, i, step);
  });
  return rows;
}

describe("inspection rows follow the verifier", () => {
  it("a genuine receipt resolves every row, including the first and the last", async () => {
    const rows = replay(await trace(GOOD));

    // The first row is what the mutable-counter bug left permanently "active",
    // and the last is the one whose result was dropped off the end entirely.
    expect(rows[0]!.state).toBe("pass");
    expect(rows.at(-1)!.state).toBe("pass");
    expect(rows.every((r) => r.state === "pass")).toBe(true);
    expect(rows.filter((r) => r.state === "pass" || r.state === "fail")).toHaveLength(8);
  });

  it("attributes each duration to the check that actually took it", async () => {
    const steps = await trace(GOOD);
    const rows = replay(steps);

    // The key fetch is the only step that can be slow. If durations shift by a
    // row, network time gets credited to a synchronous array filter — which is
    // precisely what the page was showing.
    STEP_ORDER.forEach((name, i) => {
      expect(rows[i]!.name).toBe(name);
      expect(rows[i]!.ms).toBe(steps[i]!.ms);
    });
  });

  it("a tampered receipt fails ON the signature row, and the rail can see it", async () => {
    const forged = tamper(GOOD, (c) => {
      c.cost = 999_999_999;
    });
    const rows = replay(await trace(forged));
    const signature = rows.find((r) => r.name === "signature")!;

    // The regression, stated as bluntly as it deserves: this row must never
    // claim a forged signature matched.
    expect(signature.state).toBe("fail");
    expect(signature.state).not.toBe("pass");
    // What the component reads to colour the rail red.
    expect(rows.some((r) => r.state === "fail")).toBe(true);
    // And every earlier check genuinely did pass — that is the whole point of
    // showing the sequence rather than one badge.
    expect(rows.slice(0, -1).every((r) => r.state === "pass")).toBe(true);
  });

  it("marks everything after a failed gate as never attempted", async () => {
    // alg:none — nothing is ever compared, so no later check runs.
    const rows = replay(await trace(sign({ ...HEADER, alg: "none" }, CLAIMS)));

    const at = STEP_ORDER.indexOf("algorithm");
    expect(rows[at]!.state).toBe("fail");
    expect(rows.slice(at + 1).every((r) => r.state === "not-reached")).toBe(true);
    expect(rows.slice(at + 1).every((r) => r.ms === null)).toBe(true);
  });

  it("rowsFailingAt draws the same picture as a replayed trace", async () => {
    const replayed = replay(await trace(sign({ ...HEADER, alg: "none" }, CLAIMS)));

    // preflight() short-circuits before any network call and uses rowsFailingAt;
    // the traced path uses applyStep. The same artifact must not look different
    // depending on which one happened to run.
    expect(replayed.map((r) => r.state)).toEqual(rowsFailingAt("algorithm").map((r) => r.state));
  });

  it("the total is the sum of the rows, not the wall clock", async () => {
    const steps = await trace(GOOD);
    const sum = steps.reduce((n, s) => n + s.ms, 0);

    // A reader who adds the visible rows must land on the visible total. The
    // paced reveal adds ~180 ms per row; if any of that leaked in, this breaks.
    expect(totalCheckMs(replay(steps))).toBeCloseTo(sum, 6);
  });

  // The rail, the marker and the badge all key off `kind`. A throw inside OUR
  // code is our failure, and presenting it as "Do not rely on this" against a
  // red rail accuses a receipt that may be perfectly genuine — the same
  // conflation the forged/unchecked split exists to prevent, arriving by a
  // different door. The component's catch path routes through here.
  it("an unrecognised reason is 'unchecked', never 'forged'", () => {
    expect(describeFailure("unexpected_error" as never).kind).toBe("unchecked");
    expect(describeFailure("something_new_from_a_later_sdk" as never).kind).toBe("unchecked");
    // And every reason the SDK can actually return still has deliberate copy,
    // so this fallback stays a fallback rather than quietly becoming the norm.
    for (const reason of ALL_FAILURES) {
      expect(describeFailure(reason).title).not.toBe(
        describeFailure("unexpected_error" as never).title
      );
    }
  });

  it("applyStep never reads an index it was not given", () => {
    // The guard against reintroducing an implicit counter: called out of order,
    // it touches only the row it was handed and the one after it.
    const jumped = applyStep(initialStepRows(), 5, { ok: true, ms: 4 });
    expect(jumped[5]!.state).toBe("pass");
    expect(jumped[5]!.ms).toBe(4);
    expect(jumped[6]!.state).toBe("active");
    expect(jumped[0]!.state).toBe("active");
    expect(jumped[4]!.state).toBe("waiting");
  });
});
