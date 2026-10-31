// Offline coverage of the Redis hash boundary; no local stack or network.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), eval: vi.fn() }));
vi.mock("@/lib/state/redis", () => ({ redis: () => ({
  eval: h.eval,
  zrange: async () => [...h.rows.keys()].map((key) => key.slice(4)),
  hgetall: async (key: string) => h.rows.get(key) ?? null,
  pipeline: () => {
    const keys: string[] = [];
    return { hgetall: (key: string) => keys.push(key), exec: async () => keys.map((key) => h.rows.get(key) ?? null) };
  },
}) }));
const { checkApproval, listPendingApprovals, readApproval } = await import("@/lib/state/approvals");

beforeEach(() => {
  h.rows.clear();
  h.eval.mockReset().mockImplementation(async (_lua: string, _keys: string[], args: string[]) => {
    const raw: Record<string, unknown> = { state: "pending", created: args[2] };
    for (let i = 5; i < args.length; i += 2) raw[args[i]!] = args[i + 1];
    h.rows.set(`apv:${args[1]}`, raw);
    return ["created", args[1]];
  });
});
const request = { userId: "owner", agentId: "agent", service: "github", method: "POST", path: "/issues", preview: "hello", fingerprint: "unchanged" };

describe("approval hold storage", () => {
  it.each(["injection_tainted", "injection_unknown"] as const)("round-trips %s through the hash and pending list", async (hold) => {
    const result = await checkApproval({ ...request, hold }, { create: true });
    expect(h.rows.get(`apv:${result.id}`)).toHaveProperty("hold", hold);
    expect(await listPendingApprovals("owner")).toEqual([expect.objectContaining({ hold })]);
    expect(await readApproval("owner", result.id!)).toHaveProperty("hold", hold);
    expect(h.rows.get(`apv:${result.id}`)).toHaveProperty("fp", request.fingerprint);
  });

  it("writes no hold field for ordinary requests and accepts legacy records", async () => {
    await checkApproval(request, { create: true });
    expect([...h.rows.values()][0]).not.toHaveProperty("hold");
    expect((await listPendingApprovals("owner"))[0]).not.toHaveProperty("hold");
  });

  it.each(["other", "~injection_tainted", 123, null])("ignores an invalid stored hold: %s", async (hold) => {
    const result = await checkApproval(request, { create: true });
    h.rows.get(`apv:${result.id}`)!.hold = hold;
    expect((await listPendingApprovals("owner"))[0]).not.toHaveProperty("hold");
    expect(await readApproval("owner", result.id!)).not.toHaveProperty("hold");
  });
});
