// How long a Redis outage holds one gateway call (stress run 2026-10-30,
// plans/stress-runs/2026-10-30.md). Upstash's default retry is 6 attempts with
// 50·e^i ms backoff, about 4.3 s per command once Redis refuses; a budgeted proxy
// call makes about five in a row, so it hung past 20 s before it was refused.
// One quick retry stays: every budget transition is idempotent on its attempt id
// (lib/state/holds.ts), so a replay is safe, and one covers a transient blip.
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
afterEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = saved.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
  vi.resetModules();
});

/** A "Redis" that accepts each connection and drops it at once, counting them. */
async function droppingServer() {
  let connections = 0;
  const server = net.createServer((socket) => { connections++; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, count: () => connections, close: () => new Promise((r) => server.close(r)) };
}

describe("the shared Redis client during an outage", () => {
  it("tries a command twice, not six times, and gives up in well under a second", async () => {
    const down = await droppingServer();
    try {
      process.env.UPSTASH_REDIS_REST_URL = down.url;
      process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
      vi.resetModules();
      const { redis } = await import("@/lib/state/redis");
      const started = performance.now();
      await expect(redis().get("any")).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(down.count()).toBe(2);
    } finally {
      await down.close();
    }
  });
});
