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

describe("recording whether a call could be priced", () => {
  // agent_logs records cost_microcents = 0 for a call nobody could price, and
  // until 0053 nothing said that 0 was meaningless. A spend statement summing
  // that column would reintroduce, on the artifact handed to an auditor, exactly
  // the defect "an unknown cost stops reading as zero" fixed on receipts.
  beforeEach(() => {
    insert.mockResolvedValue({ error: null });
  });

  const base = {
    agentId: "agent-1",
    userId: "user-1",
    passportId: "passport-1",
    jti: "visa-1",
    provider: "openai",
    status: "ok" as const,
  };

  it("marks a row the gateway could not price", async () => {
    await writeLog({ ...base, costMicrocents: 0, unpriced: true });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ unpriced: true }));
  });

  it("OMITS the column entirely when the call was priced, rather than sending false", async () => {
    // The same conditional-spread this function already uses for `receipt`,
    // `policy_shadow_would` and `sender_proof_would`, and for the same reason:
    // PostgREST rejects the WHOLE insert on an unknown column, so a deployment
    // running this code against pre-0053 schema would write NO audit rows at
    // all — silently, on every call, because these writes are best-effort.
    await writeLog({ ...base, costMicrocents: 4200 });
    const row = insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("unpriced");
  });

  it("omits it for an explicit false too, so a priced call is byte-identical to before", async () => {
    await writeLog({ ...base, costMicrocents: 4200, unpriced: false });
    const row = insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("unpriced");
  });

  it("leaves every other column untouched by the new one", async () => {
    await writeLog({ ...base, costMicrocents: 7, unpriced: true });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "agent-1",
        user_id: "user-1",
        passport_id: "passport-1",
        jti: "visa-1",
        cost_microcents: 7,
        status: "ok",
        unpriced: true,
      })
    );
  });
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

  it("writes a direct identity without fabricating passport or visa fields", async () => {
    insert.mockResolvedValue({ error: null });

    await writeLog({
      authMethod: "direct_key",
      agentId: "agent-1",
      userId: "user-1",
      agentAccessKeyId: "key-1",
      credentialUseId: "use-1",
      status: "ok",
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        auth_method: "direct_key",
        agent_access_key_id: "key-1",
        credential_use_id: "use-1",
        passport_id: null,
        jti: null,
      })
    );
  });

  it("persists proof-per-request only for the passport path that enforced it", async () => {
    insert.mockResolvedValue({ error: null });

    await writeLog({
      authMethod: "passport_proof_per_request",
      agentId: "agent-1",
      userId: "user-1",
      passportId: "passport-1",
      jti: "visa-1",
      status: "ok",
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        auth_method: "passport_proof_per_request",
        passport_id: "passport-1",
        jti: "visa-1",
      })
    );
    expect(insert.mock.calls[0]![0]).not.toHaveProperty("agent_access_key_id");
    expect(insert.mock.calls[0]![0]).not.toHaveProperty("credential_use_id");
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
