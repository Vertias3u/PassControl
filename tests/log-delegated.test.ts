// Bet D slice 5: the audit row for a WORKER's call. The two delegated methods are
// written explicitly with all four delegation columns (0081's shape constraint), and
// every other row names none of them, so a database without 0081 still accepts it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { insert, serviceClientMock } = vi.hoisted(() => ({ insert: vi.fn(), serviceClientMock: vi.fn() }));
vi.mock("../lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("../lib/observability", () => ({ captureError: async () => {} }));

import { writeLog } from "../lib/log";

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue({ error: null });
  serviceClientMock.mockReturnValue({ from: vi.fn(() => ({ insert })), rpc: vi.fn() });
});

const delegation = { jti: "jti-0000000000000002", actor: "W".repeat(43), chainHash: "c".repeat(43), links: ["jti-0000000000000001", "jti-0000000000000002"] };

describe("writeLog for a worker's call", () => {
  it.each(["delegated", "delegated_proof_per_request"] as const)("%s writes the method and all four delegation columns", async (authMethod) => {
    await writeLog({ authMethod, agentId: "a", userId: "u", passportId: "root", jti: "visa-1", status: "ok", delegation });
    expect(insert.mock.calls[0]![0]).toMatchObject({
      auth_method: authMethod,
      passport_id: "root",
      jti: "visa-1",
      delegation_jti: delegation.jti,
      delegation_actor: delegation.actor,
      delegation_chain_hash: delegation.chainHash,
      delegation_links: delegation.links,
    });
  });

  it("an ordinary passport row names no delegation column", async () => {
    await writeLog({ agentId: "a", userId: "u", passportId: "root", jti: "visa-1", status: "ok" });
    const row = insert.mock.calls[0]![0];
    for (const col of ["delegation_jti", "delegation_actor", "delegation_chain_hash", "delegation_links"]) expect(row).not.toHaveProperty(col);
  });

  it("a delegated method without its delegation is never written as passport", async () => {
    await expect(
      writeLog({ authMethod: "delegated", agentId: "a", userId: "u", passportId: "root", jti: "visa-1", status: "ok" } as never)
    ).resolves.toBeUndefined();
    // Nothing sent that the shape constraint would refuse silently as a different identity.
    expect(insert).not.toHaveBeenCalled();
  });
});
