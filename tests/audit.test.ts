import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAuditRecord, AUDIT_ACTIONS, AUDIT_VALUE_MAX_CHARS } from "../lib/audit";

describe("buildAuditRecord — admin-action audit row", () => {
  it("builds a row for a known action", () => {
    const rec = buildAuditRecord({
      userId: "user-1",
      action: "agent.create",
      targetType: "agent",
      targetId: "agent-9",
      metadata: { name: "billing-bot" },
    });
    expect(rec).toEqual({
      user_id: "user-1",
      action: "agent.create",
      target_type: "agent",
      target_id: "agent-9",
      metadata: { name: "billing-bot" },
    });
  });

  it("rejects an unknown action (only our own constants may be logged)", () => {
    // @ts-expect-error — exercising the runtime guard with a bad value
    expect(() => buildAuditRecord({ userId: "u", action: "drop.tables" })).toThrow();
  });

  it("sanitizes metadata + target so an injected value can't forge log/audit lines", () => {
    const rec = buildAuditRecord({
      userId: "u",
      action: "agent.suspend",
      targetType: "agent",
      targetId: "ok\r\nfake",
      metadata: { note: "line1\r\nline2", suspended: true },
    });
    expect(String(rec.target_id)).not.toMatch(/[\r\n]/);
    expect(String((rec.metadata as any).note)).not.toMatch(/[\r\n]/);
    expect((rec.metadata as any).suspended).toBe(true); // non-strings pass through
  });

  it("bounds over-long target ids", () => {
    const rec = buildAuditRecord({ userId: "u", action: "provider_key.add", targetId: "x".repeat(500) });
    expect(String(rec.target_id).length).toBeLessThanOrEqual(200);
  });

  it("defaults missing target fields to null", () => {
    const rec = buildAuditRecord({ userId: "u", action: "killswitch.master", metadata: { on: true } });
    expect(rec.target_type).toBeNull();
    expect(rec.target_id).toBeNull();
  });

  // ── The audit row is not a log line ───────────────────────────────────────
  //
  // Every metadata value used to go through seclog's sanitizeValue, whose
  // 256-character bound is a log-INJECTION control for a single-line surface.
  // The capability writers stringify whole scope / fallback / policy documents
  // into metadata, so that bound cut valid JSON mid-value; admin_audit is
  // append-only, so the cut is permanent and no reader can recover it. These
  // tests pin the audit side's own treatment: strip control characters, keep
  // the document.
  const REALISTIC_SCOPES = [
    {
      provider: "anthropic",
      models: ["claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
    },
    { provider: "openai", models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"] },
    { provider: "groq", models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"] },
  ];

  it("keeps a realistic scope snapshot intact — it is jsonb, not a log line", () => {
    const json = JSON.stringify(REALISTIC_SCOPES);
    // The fixture must be the kind of document that actually broke: a toy
    // three-model array stays under 256 characters and proves nothing.
    expect(json.length).toBeGreaterThan(256);

    const rec = buildAuditRecord({
      userId: "u",
      action: "agent.update",
      targetType: "agent",
      targetId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      metadata: { fields: "allowed_scopes", via: "dashboard", from: "null", to: json },
    });

    expect(rec.metadata.to).toBe(json);
    expect(JSON.parse(String(rec.metadata.to))).toEqual(REALISTIC_SCOPES);
  });

  it("keeps a break-glass reason at its own maximum (500) intact", () => {
    // BREAK_GLASS_REASON_MAX is 500, so the reason — the entire point of the
    // elevation row — was being cut at 256.
    const reason = "incident 4127: ".padEnd(500, "x");
    const rec = buildAuditRecord({
      userId: "u",
      action: "agent.break_glass",
      targetType: "agent",
      targetId: "a1",
      metadata: { reason },
    });
    expect(rec.metadata.reason).toBe(reason);
  });

  // ── The ceiling has to be a size an INSERT can carry ──────────────────────
  //
  // A row carries two snapshots, so the per-value bound is half the row's
  // budget. Set it too high and the fix makes the worst case WORSE: a
  // pathological save becomes an insert big enough to be refused, and
  // recordAdminAction swallows a failed insert, so the row vanishes entirely
  // where before it merely arrived cut. No row is worse than a damaged row on a
  // surface whose whole job is the record.
  it("bounds a whole row well inside any plausible request-body limit", () => {
    expect(AUDIT_VALUE_MAX_CHARS * 2).toBeLessThanOrEqual(64 * 1024);
  });

  it("still holds the whole scope ceiling at the length real model ids run", () => {
    // LIMITS: 20 scope entries x 50 model patterns. At the length of a real
    // identifier ("claude-sonnet-4-20250514" is 24 characters) the entire
    // ceiling has to fit, or an operator using every slot the product sells
    // them loses the snapshot.
    const full = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({
        provider: `provider-${i}`,
        models: Array.from({ length: 50 }, (_, m) => `claude-sonnet-4-2025${String(m).padStart(4, "0")}`),
      }))
    );
    expect(full.length).toBeLessThanOrEqual(AUDIT_VALUE_MAX_CHARS);
    const rec = buildAuditRecord({ userId: "u", action: "agent.update", metadata: { to: full } });
    expect(rec.metadata.to).toBe(full);
  });

  it("declines the pathological document explicitly rather than risking the row", () => {
    // 20 x 50 patterns of near-maximum 200 characters: valid, absurd, and about
    // 204 KB. It is the one document that does not fit, and the operator is told
    // so in the record instead of the record going missing.
    const pathological = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({
        provider: `provider-${i}`,
        models: Array.from({ length: 50 }, (_, m) => `model-${m}`.padEnd(200, "z")),
      }))
    );
    expect(pathological.length).toBeGreaterThan(200_000);
    const rec = buildAuditRecord({ userId: "u", action: "agent.update", metadata: { to: pathological } });
    expect(rec.metadata.to).toEqual({ omitted: "too_large", chars: pathological.length });
  });

  it("keeps a value exactly at the ceiling and marks the one character past it", () => {
    const at = "z".repeat(AUDIT_VALUE_MAX_CHARS);
    const over = `${at}z`;
    const rec = buildAuditRecord({ userId: "u", action: "agent.update", metadata: { at, over } });
    expect(rec.metadata.at).toBe(at);
    expect(rec.metadata.over).toEqual({ omitted: "too_large", chars: AUDIT_VALUE_MAX_CHARS + 1 });
  });

  it("records a value past the audit bound as an explicit omission, never a cut string", () => {
    const absurd = "y".repeat(1_000_000);
    const rec = buildAuditRecord({ userId: "u", action: "agent.update", metadata: { to: absurd } });
    // A silent prefix is the defect: it still looks like data to every reader.
    expect(typeof rec.metadata.to).not.toBe("string");
    expect(rec.metadata.to).toEqual({ omitted: "too_large", chars: 1_000_000 });
  });

  it("still strips control characters from a long value", () => {
    const withNewlines = `${"a".repeat(400)}\r\n${"b".repeat(400)}`;
    const rec = buildAuditRecord({ userId: "u", action: "agent.update", metadata: { note: withNewlines } });
    expect(String(rec.metadata.note)).not.toMatch(/[\r\n]/);
    expect(String(rec.metadata.note).length).toBe(withNewlines.length);
  });

  it("covers exactly the privileged mutations", () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [
        "agent.create",
        "agent.direct_key.create",
        "agent.direct_key.revoke",
        "agent.update",
        "agent.suspend",
        "agent.revoke",
        "killswitch.master",
        "provider_key.add",
        "provider_key.rotate",
        // Migration 0027. Switching decides which stored credential the gateway
        // injects, and therefore which upstream account is billed from then on;
        // deleting destroys a credential row and its Vault secret. Neither mints
        // anything, and both are exactly the kind of change an operator needs to
        // find in the trail when an unexpected provider bill turns up.
        "provider_key.activate",
        "provider_key.delete",
        "apikey.create",
        "apikey.revoke",
        "mfa.enroll",
        "mfa.disable",
        // Owner binding (migration 0017). Declaring an owner, publishing it to
        // the public /verify page, and running the domain check are all
        // privileged: each one changes what a stranger reads about this tenant.
        "owner.set",
        "owner.publish",
        "owner.verify",
        "profile.update",
        "profile.handle",
        "profile.publish",
        "profile.avatar",
        "profile.avatar_removed",
        "agent.publish",
        // Break-glass elevation (migration 0022). The most privileged action in
        // this list: it widens what an agent may reach, for a bounded time,
        // outside the stored capability. The audit row is the entire
        // justification for the feature existing.
        "agent.break_glass",
        // Workspace configuration export and import. Export is a read, which
        // makes it the odd one out in a list of mutations — it earns its place
        // because the Recovery panel renders the newest row as "Last export",
        // so the row is not a record of a change but the answer to "could I
        // rebuild this workspace, and when did I last check". Import is an
        // ordinary mutation: it creates agents.
        "workspace.export",
        "workspace.import",
        // Problem reports (migration 0038). Filing is the reporter's action and
        // is audited under the reporter; triage is the operator's and is
        // audited under the operator, so the trail answers "who decided this"
        // rather than "who was complained about". Neither row carries the
        // report body: admin_audit is served by GET /api/control/v1/audit, and
        // the text belongs in exactly one column of one server-only table.
        "problem.report",
        "problem.triage",
        // `passcontrol login`. The approve row records a WRITE-scoped
        // control-plane key minted without anyone opening the Settings form, so
        // it is the one trail that says a CLI on some machine was given fleet
        // authority — and by whom. Deny is recorded too: refusing a prompt you
        // did not start is a security event, and a trail that only kept the
        // approvals could not tell a quiet workspace from a targeted one.
        // Neither row carries the user_code or the token.
        "cli.device.approve",
        "cli.device.deny",
      ].sort()
    );
  });
});

// ── A swallowed audit write must not also be a silent one ───────────────────
//
// recordAdminAction never throws into the caller on purpose: an audit write
// failing must not fail the operator's action. Swallowed and unreported are
// different things, though. A row that quietly never lands is the one failure
// this subsystem cannot afford to be quiet about — and the sizing above only
// makes a refused insert unlikely, not impossible. lib/log.ts already sets the
// pattern: swallow, then captureError.
describe("a failed audit write is swallowed, not hidden", () => {
  const source = readFileSync(resolve(process.cwd(), "lib/audit.ts"), "utf8");
  const writer = source.slice(source.indexOf("export async function recordAdminAction"));

  it("reports the failure to observability", () => {
    expect(source).toMatch(/import \{ captureError \} from "\.\/observability"/);
    // Both failure paths, not just one: the insert that returns an error and
    // the call that throws. A helper that exists but is only wired to one of
    // them leaves half the failures silent.
    expect((writer.match(/reportAuditFailure\(/g) ?? []).length).toBe(2);
    const helper = source.slice(source.indexOf("async function reportAuditFailure"));
    expect(helper).toMatch(/captureError\(/);
  });

  it("still returns rather than throwing into the caller's action", () => {
    expect(writer).not.toMatch(/\bthrow\b/);
  });
});
