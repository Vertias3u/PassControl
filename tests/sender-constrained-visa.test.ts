import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";

const {
  verifyVisaMock,
  currentPolicyMock,
  claimNonceMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  signReceiptMock,
  rateLimitMock,
} = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
  currentPolicyMock: vi.fn(),
  claimNonceMock: vi.fn(),
  serviceClientMock: vi.fn(),
  openHoldMock: vi.fn(),
  settleHoldMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  signReceiptMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: (promise: unknown) => promise }));
vi.mock("@/lib/auth/visa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/visa")>()),
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicyAndShadow: (...args: unknown[]) => currentPolicyMock(...args),
}));
vi.mock("@/lib/state/killswitch", () => ({
  readKillState: (...args: unknown[]) => readKillStateMock(...args),
}));
vi.mock("@/lib/state/redis", () => ({
  purgeAgentPolicy: vi.fn(),
  // The proxy reads this before the endpoint row and again before dispatch.
  // Omitted, it is undefined, the call throws, and the route 500s.
  readCredentialFence: vi.fn(async () => null),
  claimNonce: (...args: unknown[]) => claimNonceMock(...args),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: vi.fn(async () => null),
  setCachedKey: vi.fn(async () => undefined),
  touchLastSeen: vi.fn(),
}));
/**
 * The attempt-lifecycle boundary, mocked as a MODULE rather than re-implemented.
 *
 * tests/reserve-id.test.ts used to hand-copy the reserve Lua into TypeScript and
 * the copy drifted — it collapsed the -1/-2 return codes, so one whole branch of
 * the money boundary was covered by a test that could not fail on it. Mocking
 * the boundary removes that hazard: what the real scripts DO is Tier A's job
 * (tests/holds.redis.test.ts, real Lua on real Redis); what this file asserts is
 * WHICH transition the route chooses and with WHAT arguments.
 *
 * The three settle entry points funnel into one spy carrying an `outcome` tag,
 * because the choice between them IS the behaviour under test.
 */
vi.mock("@/lib/state/holds", () => {
  const settle = async (outcome: string, p: Record<string, unknown>) => {
    const r = await settleHoldMock({ ...p, outcome });
    // A test that does not care about the applied figures gets a realistic
    // settlement rather than `undefined`, which the route would then read
    // fields off. Tests that DO care override the return.
    return (
      r ?? {
        applied: true,
        appliedTokens: Number(p.tokens ?? 0),
        appliedMicrocents: Number(p.microcents ?? 0),
      }
    );
  };
  return {
    openHold: (...args: unknown[]) => openHoldMock(...args),
    // Always granted here: these suites assert what the proxy does AROUND the
    // dispatch boundary, not the boundary itself (tests/proxy-dispatch-permission.test.ts).
    consumeDispatchPermission: async () => ({ granted: true }),
    settleKnown: (p: Record<string, unknown>) => settle("complete", p),
    settleUnknown: (p: Record<string, unknown>) => settle("usage_unknown", p),
    releaseUndispatched: (p: Record<string, unknown>) => settle("not_dispatched", p),
    establishBudgetState: (...args: unknown[]) => establishBudgetStateMock(...args),
  };
});
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/receipt")>()),
  signReceipt: (...args: unknown[]) => signReceiptMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
  rateLimitFailClosed: vi.fn(async () => ({ success: true, remaining: 1 })),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: vi.fn(async () => undefined),
  logFailOpen: vi.fn(),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const GATEWAY = "https://gateway.test";
const PATH = "/api/v1/demo/chat/completions";
const SEED = new Uint8Array(32).fill(7);
const OTHER_SEED = new Uint8Array(32).fill(9);
const PASSPORT_ID = bytesToBase64url(ed25519.getPublicKey(SEED));

function claims(jti: string) {
  return {
    sub: PASSPORT_ID,
    agid: "agent-id",
    uid: "user-id",
    jti,
    bt: null,
    bc: null,
    st: 0,
    sc: 0,
    ver: 2,
    scope: [{ provider: "demo", models: ["*"] }],
  };
}

function proof({
  visa,
  seed = SEED,
  method = "POST",
  path = PATH,
  iat = Math.floor(Date.now() / 1000),
  jti = crypto.randomUUID(),
}: {
  visa: string;
  seed?: Uint8Array;
  method?: string;
  path?: string;
  iat?: number;
  jti?: string;
}) {
  const payload = utf8ToBytes(
    JSON.stringify({
      htm: method,
      htu: `${GATEWAY}${path}`,
      iat,
      jti,
      vh: bytesToBase64url(sha256(utf8ToBytes(visa))),
    })
  );
  return `${bytesToBase64url(payload)}.${bytesToBase64url(ed25519.sign(payload, seed))}`;
}

function request(visa: string, senderProof?: string) {
  return new Request(`${GATEWAY}${PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${visa}`,
      "content-type": "application/json",
      ...(senderProof ? { "x-passcontrol-proof": senderProof } : {}),
    },
    body: JSON.stringify({ model: "demo-1", messages: [{ role: "user", content: "hi" }] }),
  });
}

async function call(visa: string, senderProof?: string) {
  return POST(request(visa, senderProof), {
    params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PASSCONTROL_DEMO = "1";
  verifyVisaMock.mockImplementation(async (visa: string) =>
    visa === "visa-a" ? claims("visa-jti-a") : visa === "visa-b" ? claims("visa-jti-b") : null
  );
  currentPolicyMock.mockResolvedValue({
    policy: {},
    shadow: null,
    senderConstraintMode: "required",
    budget: { known: false },
  });
  claimNonceMock.mockResolvedValue(true);
  serviceClientMock.mockReturnValue({ rpc: vi.fn() });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  signReceiptMock.mockReturnValue("header.payload.signature");
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
});

afterEach(() => {
  delete process.env.PASSCONTROL_DEMO;
});

describe("sender-constrained passport visas", () => {
  it("records the proof actually enforced, not merely the agent's configured flag", async () => {
    const proofed = await call("visa-a", proof({ visa: "visa-a" }));
    expect(proofed.status).toBe(200);
    await vi.waitFor(() => expect(signReceiptMock).toHaveBeenCalled());

    const proofedReceipt = signReceiptMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const proofedLog = writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(proofedReceipt.authMethod).toBe("passport_proof_per_request");
    expect(proofedLog.authMethod).toBe("passport_proof_per_request");

    signReceiptMock.mockClear();
    writeLogMock.mockClear();
    currentPolicyMock.mockResolvedValue({
      policy: {},
      shadow: null,
      senderConstraintMode: "off",
      budget: { known: false },
    });

    // The caller still supplies a valid proof. Because the gateway did not
    // REQUIRE or verify it on this path, the receipt must not upgrade the call.
    const bearerVisa = await call("visa-a", proof({ visa: "visa-a" }));
    expect(bearerVisa.status).toBe(200);
    await vi.waitFor(() => expect(signReceiptMock).toHaveBeenCalled());

    const bearerReceipt = signReceiptMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const bearerLog = writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(bearerReceipt.authMethod).toBe("passport");
    expect(bearerLog.authMethod).toBe("passport");
  });

  it("refuses a captured visa without its passport proof while the legitimate next call succeeds", async () => {
    const stolenReplay = await call("visa-a");
    const legitimateNextCall = await call("visa-a", proof({ visa: "visa-a" }));

    expect(stolenReplay.status).toBe(401);
    expect(await stolenReplay.json()).toMatchObject({ error: "missing_sender_proof" });
    expect(legitimateNextCall.status).toBe(200);
  });

  it.each([
    ["wrong method", { method: "GET" }],
    ["wrong path", { path: "/api/v1/demo/models" }],
  ])("refuses a proof with the %s", async (_label, changed) => {
    const res = await call("visa-a", proof({ visa: "visa-a", ...changed }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_sender_proof" });
  });

  it("refuses a proof paired with a different valid visa for the same agent", async () => {
    const proofForA = proof({ visa: "visa-a" });

    const res = await call("visa-b", proofForA);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_sender_proof" });
  });

  it("burns the proof jti so a verbatim replay inside the window is refused", async () => {
    const seen = new Set<string>();
    claimNonceMock.mockImplementation(async (nonce: string) => {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    });
    const senderProof = proof({ visa: "visa-a", jti: "one-use-proof" });

    expect((await call("visa-a", senderProof)).status).toBe(200);
    const replay = await call("visa-a", senderProof);

    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: "sender_proof_replayed" });
  });

  it("refuses an out-of-window proof with an actionable clock-skew message", async () => {
    const stale = proof({ visa: "visa-a", iat: Math.floor(Date.now() / 1000) - 31 });

    const res = await call("visa-a", stale);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("sender_proof_clock_skew");
    expect(body.message).toMatch(/clock|NTP/i);
    expect(claimNonceMock).not.toHaveBeenCalled();
  });

  it("refuses a proof signed by a different agent key", async () => {
    const res = await call("visa-a", proof({ visa: "visa-a", seed: OTHER_SEED }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_sender_proof" });
  });

  it("leaves an agent in mode off unchanged", async () => {
    currentPolicyMock.mockResolvedValue({
      policy: {},
      shadow: null,
      senderConstraintMode: "off",
      budget: { known: false },
    });

    const res = await call("visa-a");

    expect(res.status).toBe(200);
    expect(claimNonceMock).not.toHaveBeenCalled();
  });
});

/**
 * Observe mode exists because step 5 of research/sender-constrained-visas.md
 * gates default-on on "evidence from steps 2-3" — and with the mode off the
 * proxy deliberately never inspects an unsolicited proof, so no evidence was
 * ever produced. Observe verifies exactly as enforcement does and admits the
 * call regardless.
 *
 * The load-bearing property is NOT that it records things. It is that recording
 * them changes nothing a receipt claims.
 */
describe("observe mode", () => {
  beforeEach(() => {
    currentPolicyMock.mockResolvedValue({
      policy: {},
      shadow: null,
      senderConstraintMode: "observe",
      budget: { known: false },
    });
  });

  it("admits a call whose proof is missing, and says so in the log", async () => {
    const res = await call("visa-a");
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(writeLogMock.mock.calls.at(-1)?.[0]).toMatchObject({ senderProofWould: "missing" });
  });

  it("admits a call whose proof is good, and says so in the log", async () => {
    const res = await call("visa-a", proof({ visa: "visa-a" }));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(writeLogMock.mock.calls.at(-1)?.[0]).toMatchObject({ senderProofWould: "pass" });
  });

  // THE assertion this whole mode rests on. An unenforced proof is not
  // assurance, so a receipt handed to a third party must keep saying `passport`
  // however well the observation went. If this ever goes green the other way,
  // observe mode has started lying on somebody else's behalf.
  it("never upgrades auth_method, however good the proof was", async () => {
    await call("visa-a", proof({ visa: "visa-a" }));
    await vi.waitFor(() => expect(signReceiptMock).toHaveBeenCalled());

    const receipt = signReceiptMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const log = writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(receipt.authMethod).toBe("passport");
    expect(log.authMethod).toBe("passport");
    expect(log.senderProofWould).toBe("pass");
  });

  it.each([
    ["a proof for a different visa", () => proof({ visa: "visa-b" }), "invalid"],
    ["a proof signed by another key", () => proof({ visa: "visa-a", seed: OTHER_SEED }), "invalid"],
    ["a proof for the wrong method", () => proof({ visa: "visa-a", method: "GET" }), "invalid"],
    ["a proof for the wrong path", () => proof({ visa: "visa-a", path: "/api/v1/demo/other" }), "invalid"],
    [
      "a proof outside the window",
      () => proof({ visa: "visa-a", iat: Math.floor(Date.now() / 1000) - 3600 }),
      "clock_skew",
    ],
  ])("admits %s and records it", async (_label, make, would) => {
    const res = await call("visa-a", make());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(writeLogMock.mock.calls.at(-1)?.[0]).toMatchObject({ senderProofWould: would });
  });

  // The nonce IS claimed here. Skipping it would make observe cheaper than
  // enforcement and would make `replayed` unobservable — a measurement that
  // does not cost what the real thing costs does not predict it.
  it("claims the proof jti, so a replay is observable", async () => {
    claimNonceMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const replayed = proof({ visa: "visa-a" });

    await call("visa-a", replayed);
    const second = await call("visa-a", replayed);

    expect(second.status).toBe(200);
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalledTimes(2));
    expect(writeLogMock.mock.calls.at(-1)?.[0]).toMatchObject({ senderProofWould: "replayed" });
    expect(claimNonceMock).toHaveBeenCalledTimes(2);
  });

  // Replay protection failing is an authentication fault under enforcement. Here
  // there is no authentication to fault: the call was always going to be
  // admitted, so a Redis blip must not turn a diagnostic into a 401.
  it("admits the call when the replay check itself is unavailable", async () => {
    claimNonceMock.mockRejectedValue(new Error("redis down"));
    const res = await call("visa-a", proof({ visa: "visa-a" }));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(writeLogMock.mock.calls.at(-1)?.[0]?.senderProofWould).toBeUndefined();
  });

  // The property that makes observing predictive: it must run the SAME check in
  // the SAME order as enforcement, or the mode an operator decided from is not
  // the mode they switched on. Asserted behaviourally rather than by reading the
  // source — the same proof, the same visa, the same request, and the only
  // difference is whether the verdict blocks.
  it.each([
    ["missing", undefined],
    ["invalid", "wrong-visa"],
  ])("reaches the same verdict for %s as enforcement does", async (would, kind) => {
    const make = () => (kind === "wrong-visa" ? proof({ visa: "visa-b" }) : undefined);

    const observed = await call("visa-a", make());
    expect(observed.status).toBe(200);
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(writeLogMock.mock.calls.at(-1)?.[0]).toMatchObject({ senderProofWould: would });

    currentPolicyMock.mockResolvedValue({
      policy: {},
      shadow: null,
      senderConstraintMode: "required",
      budget: { known: false },
    });
    const enforced = await call("visa-a", make());
    expect(enforced.status).toBe(401);
  });

  // Drift resolves DOWN. A mode this build does not recognise — a newer schema
  // read by an older deploy — takes the bearer path rather than enforcing,
  // because enforcing would refuse every call for an agent whose operator
  // configured something we have not shipped. Same rule toSenderConstraintMode
  // follows one layer up.
  it("takes the bearer path for a mode this build does not know", async () => {
    currentPolicyMock.mockResolvedValue({
      policy: {},
      shadow: null,
      senderConstraintMode: "paranoid",
      budget: { known: false },
    });
    const res = await call("visa-a");
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(writeLogMock.mock.calls.at(-1)?.[0]?.senderProofWould).toBeUndefined();
  });

  it("records nothing at all when the mode is off", async () => {
    currentPolicyMock.mockResolvedValue({ policy: {}, shadow: null, senderConstraintMode: "off", budget: { known: false } });
    await call("visa-a", proof({ visa: "visa-a" }));
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(writeLogMock.mock.calls.at(-1)?.[0]?.senderProofWould).toBeUndefined();
  });
});
