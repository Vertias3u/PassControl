import { describe, expect, it, vi } from "vitest";

// The gateway answers a governed call BEFORE its receipt row is written, so the
// receipt id it returns is a promise rather than a fact. A single immediate read
// loses that race — and loses it invisibly, because the 404 is the same answer a
// gateway gives when it signs no receipts at all. The operator is then told the
// deployment stores nothing, on the screen they read as proof that it does.
//
// So the retry POLICY is the contract, not an implementation detail: how long it
// is willing to wait, and which failures are worth waiting on.
const load = async () => {
  const url = new URL("../cli/selftest.mjs", import.meta.url).href;
  return (await import(/* @vite-ignore */ url)) as {
    fetchReceiptRow: (
      origin: string,
      apiKey: string,
      receiptId: string,
      fetchImpl: typeof fetch,
      wait: (ms: number) => Promise<void>
    ) => Promise<unknown>;
  };
};

const ORIGIN = "http://gateway.test";
const wait = async () => {};

describe("waiting out the gateway's background receipt write", () => {
  it("keeps reading through 404s and returns the row the moment it lands", async () => {
    const { fetchReceiptRow } = await load();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 3
        ? new Response("{}", { status: 404 })
        : Response.json({ data: { receipt: "signed.jws.value" } });
    });

    const row = await fetchReceiptRow(ORIGIN, "pc_key", "r-1", fetchImpl as never, wait);

    expect(row).toEqual({ receipt: "signed.jws.value" });
    expect(calls).toBe(3);
  });

  it("gives up after a bounded number of attempts rather than hanging a login", async () => {
    const { fetchReceiptRow } = await load();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));

    const row = await fetchReceiptRow(ORIGIN, "pc_key", "r-1", fetchImpl as never, wait);

    // Null, not a throw: by now "no receipt was stored for that call" is a fair
    // description, and the caller's own branch says exactly that. A throw would
    // be caught upstream as "the call did not work", which is false — it did.
    expect(row).toBeNull();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("does not retry a wrong key or a rate limit, which waiting cannot fix", async () => {
    const { fetchReceiptRow } = await load();
    for (const status of [401, 403, 429, 500]) {
      const fetchImpl = vi.fn(async () => new Response("{}", { status }));
      await expect(
        fetchReceiptRow(ORIGIN, "pc_key", "r-1", fetchImpl as never, wait)
      ).rejects.toThrow(String(status));
      expect(fetchImpl, `status ${status} must not be retried`).toHaveBeenCalledTimes(1);
    }
  });

  it("asks for the receipt by an encoded id, so a hostile id cannot reshape the path", async () => {
    const { fetchReceiptRow } = await load();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ data: { receipt: "x" } })
    );

    await fetchReceiptRow(ORIGIN, "pc_key", "../../agents", fetchImpl as never, wait);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${ORIGIN}/api/control/v1/receipts/..%2F..%2Fagents`
    );
  });
});
