import { describe, expect, it, vi } from "vitest";
import { createVisaClient } from "../visa-client.mjs";

const GATEWAY = "https://gateway.test";
const PASSPORT_ID = Buffer.alloc(32, 3).toString("base64url");
const PASSPORT_SECRET = Buffer.alloc(32, 7).toString("base64url");

function visaResponse(visa, expiresIn = 300) {
  return new Response(JSON.stringify({ visa, expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("shared visa client", () => {
  it("single-flights minting, caches outside the skew window, and refreshes inside it", async () => {
    let now = 1_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(visaResponse("visa-one"))
      .mockResolvedValueOnce(visaResponse("visa-two"));
    const visas = createVisaClient({
      gateway: GATEWAY,
      passportId: PASSPORT_ID,
      passportSecret: PASSPORT_SECRET,
      fetch: fetchMock,
      now: () => now,
      randomUUID: () => "nonce-for-test",
      refreshSkewSeconds: 30,
    });

    await expect(Promise.all([visas.getVisa(), visas.getVisa()])).resolves.toEqual([
      "visa-one",
      "visa-one",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now = 270_999;
    await expect(visas.getVisa()).resolves.toBe("visa-one");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now = 271_000;
    await expect(visas.getVisa()).resolves.toBe("visa-two");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates and re-mints once when a visa-authenticated request returns 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(visaResponse("visa-one"))
      .mockResolvedValueOnce(visaResponse("visa-two"));
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const visas = createVisaClient({
      gateway: GATEWAY,
      passportId: PASSPORT_ID,
      passportSecret: PASSPORT_SECRET,
      fetch: fetchMock,
      now: () => 1_000,
      randomUUID: () => "nonce-for-test",
    });

    const response = await visas.fetchWithVisa(request);

    expect(response.status).toBe(200);
    expect(request.mock.calls.map(([visa]) => visa)).toEqual(["visa-one", "visa-two"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
