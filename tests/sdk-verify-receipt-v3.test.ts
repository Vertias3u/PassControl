import { expect, it, vi } from "vitest";
// Exercise the actual version gate with the maximum understood by a v3 build.
vi.mock("../cli/protocols.mjs", async (original) => ({
  ...await original<Record<string, unknown>>(),
  RECEIPT_PROTOCOL: { minimum: 1, maximum: 3 },
}));
import { verifyReceipt, SUPPORTED_VER } from "@/sdk/verify";
import { signCompactJws, RECEIPT_TYP } from "@/lib/crypto/jws";
it("a v3 verifier refuses a v4 receipt before fetching keys", async () => {
  expect(SUPPORTED_VER).toBe(3);
  const fetchKeys = vi.fn();
  const token = signCompactJws({ typ: RECEIPT_TYP, kid: "test", seed: new Uint8Array(32).fill(9), claims: {
    iss: "https://gateway.example", ver: 4, sub: "gateway", agid: "agent-1",
    auth: { kind: "gateway_ending" }, end: { thg: "thing", knd: "run", trg: "kill_switch", sat: 1700000000 },
  } });
  expect(await verifyReceipt(token, { trustedIssuers: ["https://gateway.example"], fetch: fetchKeys }))
    .toEqual({ ok: false, reason: "unsupported_version" });
  expect(fetchKeys).not.toHaveBeenCalled();
});
