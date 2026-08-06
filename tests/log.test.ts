import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { insert, rpc, serviceClientMock, captureErrorMock } = vi.hoisted(() => ({
  insert: vi.fn(),
  rpc: vi.fn(),
  serviceClientMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("../lib/observability", () => ({
  captureError: (...args: unknown[]) => captureErrorMock(...args),
}));

import { mirrorSpend, writeLog } from "../lib/log";

beforeEach(() => {
  vi.clearAllMocks();
  serviceClientMock.mockReturnValue({
    from: vi.fn(() => ({ insert })),
    rpc,
  });
  captureErrorMock.mockResolvedValue(undefined);
});

describe("gateway accounting writes", () => {
  it("reports an authoritative agent_logs insert error instead of dropping it", async () => {
    insert.mockResolvedValue({ error: { message: "database unavailable" } });

    await writeLog({
      agentId: "agent-1",
      userId: "user-1",
      passportId: "passport-1",
      jti: "visa-1",
      provider: "openai",
      status: "ok",
    });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        route: "lib.log.writeLog",
        agentId: "agent-1",
        jti: "visa-1",
        provider: "openai",
        code: "agent_log_insert_failed",
      })
    );
  });

  // The caller now supplies `id` so it can put the receipt id in a response
  // header before the row exists. That makes the blind retry collidable for the
  // first time: if the first insert actually landed but the response was lost,
  // the retry hits the primary key and would report a healthy write as a failure.
  it("treats a duplicate key on the RETRY as success and reports nothing", async () => {
    insert
      .mockResolvedValueOnce({ error: { message: "network blip" } })
      .mockResolvedValueOnce({ error: { code: "23505", message: "duplicate key value" } });

    await writeLog({
      id: "receipt-1",
      agentId: "agent-1",
      userId: "user-1",
      passportId: "passport-1",
      jti: "visa-1",
      status: "ok",
    });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  // ...but a duplicate on the FIRST attempt is not a lost response. Something
  // else already wrote that id, which means reconcile ran twice. Swallowing it
  // would hide exactly the bug worth knowing about.
  it("still reports a duplicate key on the FIRST attempt", async () => {
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key value" } });

    await writeLog({
      id: "receipt-1",
      agentId: "agent-1",
      userId: "user-1",
      passportId: "passport-1",
      jti: "visa-1",
      status: "ok",
    });

    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: "agent_log_insert_failed" })
    );
  });

  it("persists the supplied id and receipt so the row can be named before it exists", async () => {
    insert.mockResolvedValue({ error: null });

    await writeLog({
      id: "receipt-1",
      agentId: "agent-1",
      userId: "user-1",
      passportId: "passport-1",
      jti: "visa-1",
      status: "ok",
      receipt: "header.payload.signature",
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "receipt-1", receipt: "header.payload.signature" })
    );
  });

  // PostgREST rejects the ENTIRE insert when a named column does not exist. So
  // naming `receipt` unconditionally would mean a deployment running this code
  // against a pre-0016 schema writes no audit rows at all — silently, on every
  // call, because agent_logs writes are best-effort and swallow their errors.
  // Omitting the key is what lets the code ship ahead of the migration.
  it("never names the receipt column when there is no receipt to store", async () => {
    insert.mockResolvedValue({ error: null });

    await writeLog({
      agentId: "agent-1",
      userId: "user-1",
      passportId: "passport-1",
      jti: "visa-1",
      status: "ok",
    });

    const row = insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("receipt");
  });

  it("does not name the receipt column when the receipt is explicitly null", async () => {
    insert.mockResolvedValue({ error: null });

    await writeLog({
      id: "receipt-1",
      agentId: "agent-1",
      userId: "user-1",
      passportId: "passport-1",
      jti: "visa-1",
      status: "ok",
      receipt: null,
    });

    expect(insert.mock.calls[0]![0]).not.toHaveProperty("receipt");
  });

  it("reports a failed spend mirror RPC instead of dropping it", async () => {
    rpc.mockResolvedValue({ error: { message: "database unavailable" } });

    await mirrorSpend("agent-1", 10, 20);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        route: "lib.log.mirrorSpend",
        agentId: "agent-1",
        code: "spend_mirror_failed",
      })
    );
  });
});

// Every audit status must reach the Control Tower with its own label. That is
// normally enforced at compile time: StatusPill's CONFIG is a Record over
// LogEntry["status"], so a new status without a label fails `tsc`.
//
// It has been defeated twice. blocked_endpoint drifted in by hand and rendered
// as "Provider error"; blocked_policy then shipped behind
// `as Parameters<typeof writeLog>[0]["status"]`, which silences the same guard
// and produced the same wrong label. A cast is the recurrence mechanism, so the
// cast is what this test forbids.
describe("the audit status model stays the single source of truth", () => {
  const proxy = readFileSync(
    join(process.cwd(), "app/api/v1/[provider]/[...path]/route.ts"),
    "utf8"
  );
  const statusPill = readFileSync(join(process.cwd(), "components/StatusPill.tsx"), "utf8");
  const log = readFileSync(join(process.cwd(), "lib/log.ts"), "utf8");

  it("never casts a status into the writeLog union", () => {
    expect(proxy).not.toMatch(/\bas\s+Parameters<typeof writeLog>/);
  });

  it("declares every status the proxy writes", () => {
    const union = log.match(/status:\s*([\s\S]*?);/)?.[1] ?? "";
    const declared = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

    for (const written of [...proxy.matchAll(/writeLog\([\s\S]{0,400}?status: "([a-z_]+)"/g)]) {
      expect(declared).toContain(written[1]);
    }
    expect(declared).toContain("blocked_policy");
  });

  it("gives each declared status its own Control Tower label", () => {
    const union = log.match(/status:\s*([\s\S]*?);/)?.[1] ?? "";
    for (const [, status] of union.matchAll(/"([a-z_]+)"/g)) {
      expect(statusPill).toMatch(new RegExp(`\\b${status}:\\s*\\{\\s*label:`));
    }
  });

  it("labels every status everywhere a status is turned into words", () => {
    // Three separate maps have now missed a status: StatusPill (blocked_endpoint),
    // AgentPassport (blocked_policy), and the departures board's vocabulary. Each
    // is keyed by LogEntry["status"] so tsc catches the next one — this asserts
    // none of them has quietly gone back to a plain string key.
    const union = log.match(/status:\s*([\s\S]*?);/)?.[1] ?? "";
    const statuses = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    const maps = {
      "components/AgentPassport.tsx": readFileSync(
        join(process.cwd(), "components/AgentPassport.tsx"),
        "utf8"
      ),
      "lib/departures.ts": readFileSync(join(process.cwd(), "lib/departures.ts"), "utf8"),
    };

    for (const [file, source] of Object.entries(maps)) {
      expect(source, `${file} must key its label map by LogEntry["status"]`).toMatch(
        /Record<\s*LogEntry\["status"\]/
      );
      for (const status of statuses) {
        expect(source, `${file} is missing ${status}`).toMatch(new RegExp(`\\b${status}:`));
      }
    }
  });
});
