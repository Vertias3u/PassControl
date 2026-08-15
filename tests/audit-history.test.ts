// Capability-change history: turning admin_audit rows into an answer to
// "who widened this agent, when, and from what".
//
// This is the surface whose only job is to be trustworthy about the past, so
// the tests are mostly about what it must REFUSE to say:
//
//  * A row written before from/to existed carries `fields:` and nothing else.
//    It must read as "changed — what it changed from was not recorded", never
//    as a diff against the current value, and never as a diff inferred from the
//    row before it. That inference is wrong the moment one write went
//    unrecorded, which is precisely the case these rows come from.
//  * metadata.from / metadata.to are JSON STRINGS, not objects — both writers
//    use JSON.stringify. A reader that assumed objects would silently produce
//    empty diffs on every real row.
//  * The column is jsonb and admin_audit is append-only by convention only, so
//    malformed values must render as unknown rather than throw and take the
//    whole agent page down.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { summariseChange, toCapabilityHistory } from "@/lib/audit-history";
import { buildAuditRecord } from "@/lib/audit";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const row = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  action: "agent.update",
  target_type: "agent",
  target_id: "a1",
  metadata: {},
  created_at: "2026-08-07T10:00:00.000Z",
  ...over,
});

const scopeRow = (from: unknown, to: unknown, extra: Record<string, unknown> = {}) =>
  row({
    metadata: {
      fields: "allowed_scopes",
      from: JSON.stringify(from),
      to: JSON.stringify(to),
      ...extra,
    },
  });

describe("scope changes", () => {
  it("names a widened model pattern", () => {
    const change = summariseChange(
      scopeRow(
        [{ provider: "anthropic", models: ["claude-opus-5"] }],
        [{ provider: "anthropic", models: ["claude-*"] }]
      )
    )!;
    expect(change.recorded).toBe(true);
    expect(change.summary.toLowerCase()).toContain("scope");
    expect(change.detail?.join(" ")).toContain("claude-opus-5");
    expect(change.detail?.join(" ")).toContain("claude-*");
  });

  it("names a provider that was added", () => {
    const change = summariseChange(
      scopeRow(
        [{ provider: "anthropic", models: ["claude-*"] }],
        [
          { provider: "anthropic", models: ["claude-*"] },
          { provider: "openai", models: ["gpt-4o"] },
        ]
      )
    )!;
    expect(change.detail?.join(" ")).toContain("openai");
  });

  it("names a provider that was removed", () => {
    const change = summariseChange(
      scopeRow([{ provider: "openai", models: ["gpt-4o"] }], [])
    )!;
    const text = change.detail?.join(" ") ?? "";
    expect(text).toContain("openai");
    expect(text.toLowerCase()).toMatch(/removed|no longer/);
  });

  // An agent scoped to nothing is a real, deliberate state (ScopeEditor warns
  // rather than blocks). The history must say so rather than render an empty
  // list that reads as "nothing changed".
  it("says plainly when an agent was left able to reach nothing", () => {
    const change = summariseChange(
      scopeRow([{ provider: "openai", models: ["gpt-4o"] }], [])
    )!;
    expect(change.summary.toLowerCase()).toMatch(/nothing|no scopes/);
  });
});

// A scope document large enough to be real. The 256-character log bound that
// used to sit on the audit writer cut documents this size mid-JSON, so a test
// built on a two-model fixture stayed green while every real save lost its
// snapshot. Size is the point of this fixture.
const BEFORE_SCOPES = [
  {
    provider: "anthropic",
    models: ["claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
  },
  { provider: "openai", models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"] },
  { provider: "groq", models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"] },
];
const AFTER_SCOPES = [
  { provider: "anthropic", models: ["claude-*"] },
  { provider: "openai", models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"] },
  { provider: "groq", models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"] },
];

describe("a snapshot longer than a log line still reaches the reader", () => {
  // End to end through the WRITER, for the same reason the id round-trip test
  // at the bottom of this file goes through it: every other test here builds
  // its own metadata and would never notice the writer destroying it.
  const written = () => {
    const record = buildAuditRecord({
      userId: "b1a7c0de-0000-4000-8000-000000000001",
      action: "agent.update",
      targetType: "agent",
      targetId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      metadata: {
        fields: "allowed_scopes",
        via: "dashboard",
        from: JSON.stringify(BEFORE_SCOPES),
        to: JSON.stringify(AFTER_SCOPES),
      },
    });
    return summariseChange({ id: "r1", created_at: "2026-08-07T10:00:00.000Z", ...record })!;
  };

  it("uses a fixture big enough to have been truncated", () => {
    expect(JSON.stringify(BEFORE_SCOPES).length).toBeGreaterThan(256);
  });

  it("diffs a real scope save instead of calling it unrecorded", () => {
    const change = written();
    expect(change.recorded).toBe(true);
    expect(change.summary.toLowerCase()).not.toMatch(/not recorded|cannot be read/);
    expect(change.detail?.join(" ")).toContain("claude-*");
    expect(change.detail?.join(" ")).toContain("claude-opus-4-20250514");
  });

  // The distinguishability requirement. Both states are "no diff available", so
  // asserting recorded === false on each cannot fail — a reader tells them
  // apart by the sentence, so that is what is compared.
  it("does not present a row damaged in storage as a row that predates the record", () => {
    const cut = JSON.stringify(BEFORE_SCOPES).slice(0, 256);
    const damaged = summariseChange(
      row({ metadata: { fields: "allowed_scopes", from: cut, to: JSON.stringify(AFTER_SCOPES) } })
    )!;
    const old = summariseChange(row({ metadata: { fields: "allowed_scopes" } }))!;

    expect(damaged.summary).not.toBe(old.summary);
    expect(old.snapshot).toBe("absent");
    expect(damaged.snapshot).toBe("unreadable");
    expect(old.summary.toLowerCase()).toMatch(/not recorded/);
    expect(damaged.summary.toLowerCase()).toMatch(/cannot be read|damaged/);
    expect(damaged.detail).toBeNull();
  });

  // The writer declines a value past its ceiling and leaves a marker. That is
  // an explicit refusal, not damage in storage, and the operator is owed the
  // difference: nothing is corrupt, we chose not to store it. It still renders
  // in the damaged lane — a value that should be here is not.
  it("says an oversized value was declined, not that it cannot be read", () => {
    const declined = summariseChange(
      row({
        metadata: {
          fields: "allowed_scopes",
          from: { omitted: "too_large", chars: 312_004 },
          to: JSON.stringify(AFTER_SCOPES),
        },
      })
    )!;
    const damaged = summariseChange(
      row({ metadata: { fields: "allowed_scopes", from: "{not json", to: JSON.stringify(AFTER_SCOPES) } })
    )!;

    expect(declined.snapshot).toBe("unreadable"); // the panel's damaged lane
    expect(declined.summary).not.toBe(damaged.summary);
    expect(declined.summary.toLowerCase()).toMatch(/too large/);
    expect(declined.summary).toContain("312,004");
    expect(declined.recorded).toBe(false);
  });

  it("says the same about an elevation whose scopes were declined", () => {
    const change = summariseChange(
      row({
        action: "agent.break_glass",
        metadata: { reason: "outage", scopes: { omitted: "too_large", chars: 90_000 } },
      })
    )!;
    expect(change.summary.toLowerCase()).toMatch(/elevat/);
    expect(change.summary.toLowerCase()).toMatch(/too large/);
    expect(change.snapshot).toBe("unreadable");
  });

  it("marks every field's damaged row as damaged, not as unrecorded", () => {
    for (const fields of ["allowed_scopes", "fallbacks", "policy", "policy_shadow"]) {
      const change = summariseChange(
        row({ metadata: { fields, from: "{not json", to: "{not json" } })
      )!;
      expect(change.snapshot, fields).toBe("unreadable");
      expect(change.summary.toLowerCase(), fields).not.toMatch(/not recorded/);
    }
  });
});

describe("duplicate provider rows do not hide a widening", () => {
  // Runtime scope matching accepts ANY matching row (scopeRuleMatch iterates
  // every entry), so the effective authorization for a provider is the UNION of
  // its rows. Keying a diff by provider alone kept only the last row.
  it("reports a widening that a later duplicate row hides", () => {
    const change = summariseChange(
      scopeRow(
        [
          { provider: "openai", models: ["gpt-4"] },
          { provider: "openai", models: ["gpt-5"] },
        ],
        [
          { provider: "openai", models: ["*"] },
          { provider: "openai", models: ["gpt-5"] },
        ]
      )
    )!;
    expect(change.summary.toLowerCase()).not.toContain("no effective change");
    const text = change.detail?.join(" ") ?? "";
    expect(text).toContain("*");
    expect(text).toContain("gpt-4");
  });

  it("does not invent a change when duplicate rows were merged", () => {
    const change = summariseChange(
      scopeRow(
        [
          { provider: "openai", models: ["gpt-4o"] },
          { provider: "openai", models: ["gpt-5"] },
        ],
        [{ provider: "openai", models: ["gpt-5", "gpt-4o"] }]
      )
    )!;
    // Same effective authorization, different document. Neither "widened" nor
    // "no effective change" — the same thing said differently.
    expect(change.summary.toLowerCase()).not.toContain("no effective change");
    expect(change.detail?.join(" ")).toMatch(/written differently|same/i);
    expect(change.detail?.join(" ")).not.toMatch(/added|removed/);
  });

  it("still calls an identical document no effective change", () => {
    const same = [
      { provider: "openai", models: ["gpt-4o"] },
      { provider: "anthropic", models: ["claude-*"] },
    ];
    const change = summariseChange(scopeRow(same, same))!;
    expect(change.detail).toEqual([]);
    expect(change.summary.toLowerCase()).toContain("no effective change");
  });
});

describe("break-glass elevations belong on this page", () => {
  // The shapes are fixed by app/dashboard/agents/[id]/break-glass-actions.ts:
  // a grant carries reason / scopes (a JSON string) / expires_at; an end
  // carries ended: true and revoked (a COUNT, not a boolean).
  const grant = (over: Record<string, unknown> = {}) =>
    row({
      id: "bg1",
      action: "agent.break_glass",
      metadata: {
        via: "dashboard",
        reason: "incident 4127 — vendor outage",
        scopes: JSON.stringify([{ provider: "openai", models: ["gpt-4o", "o3-mini"] }]),
        expires_at: "2026-08-07T11:00:00.000Z",
        ...over,
      },
    });

  const ended = (revoked: number) =>
    row({ id: "bg2", action: "agent.break_glass", metadata: { via: "dashboard", ended: true, revoked } });

  it("does not drop the most privileged action there is", () => {
    expect(summariseChange(grant())).not.toBeNull();
    expect(summariseChange(ended(1))).not.toBeNull();
    expect(toCapabilityHistory([grant(), ended(1)]).map((h) => h.id)).toEqual(["bg1", "bg2"]);
  });

  it("names the elevation, what it granted, until when, and why", () => {
    const change = summariseChange(grant())!;
    expect(change.summary.toLowerCase()).toMatch(/elevat|break-glass/);
    expect(change.recorded).toBe(true);
    const text = change.detail?.join(" ") ?? "";
    expect(text).toContain("openai");
    expect(text).toContain("gpt-4o");
    expect(text).toContain("2026-08-07T11:00:00.000Z");
    expect(text).toContain("incident 4127");
  });

  it("reads an end, and does not claim one that ended nothing", () => {
    expect(summariseChange(ended(1))!.summary.toLowerCase()).toMatch(/ended/);
    const nothing = summariseChange(ended(0))!;
    expect(nothing.summary.toLowerCase()).toMatch(/nothing|no live|was not live/);
  });

  it("renders a malformed grant as unknown rather than throwing or inventing", () => {
    for (const bad of ["{not json", "", 42, null, { omitted: "too_large", chars: 9 }]) {
      const change = summariseChange(grant({ scopes: bad }))!;
      expect(() => summariseChange(grant({ scopes: bad }))).not.toThrow();
      expect(change.snapshot, JSON.stringify(bad)).not.toBe("recorded");
      expect(change.summary.toLowerCase(), JSON.stringify(bad)).toMatch(/elevat|break-glass/);
    }
  });
});

describe("fallback changes", () => {
  const fallbackRow = (from: unknown, to: unknown) =>
    row({ metadata: { fields: "fallbacks", from: JSON.stringify(from), to: JSON.stringify(to) } });

  it("names a fallback that was added", () => {
    const change = summariseChange(
      fallbackRow([], [{ provider: "groq", model: "llama-3.3-70b" }])
    )!;
    expect(change.detail?.join(" ")).toContain("groq/llama-3.3-70b");
  });

  it("names a fallback that was removed", () => {
    const change = summariseChange(
      fallbackRow([{ provider: "groq", model: "llama-3.3-70b" }], [])
    )!;
    const text = change.detail?.join(" ") ?? "";
    expect(text).toContain("groq/llama-3.3-70b");
    expect(text.toLowerCase()).toMatch(/removed|no longer/);
  });

  // Order is not decoration here: the list is tried first to last, so a
  // reordering changes which provider's key gets spent first.
  it("reports a reorder rather than calling it no change", () => {
    const change = summariseChange(
      fallbackRow(
        [
          { provider: "groq", model: "a" },
          { provider: "mistral", model: "b" },
        ],
        [
          { provider: "mistral", model: "b" },
          { provider: "groq", model: "a" },
        ]
      )
    )!;
    expect(change.detail?.join(" ").toLowerCase()).toMatch(/order/);
  });
});

describe("what it refuses to claim", () => {
  // The load-bearing one. Rows written before from/to existed must never be
  // dressed up as diffs.
  it("says the previous value was not recorded, and offers no diff", () => {
    const change = summariseChange(row({ metadata: { fields: "allowed_scopes" } }))!;
    expect(change.recorded).toBe(false);
    expect(change.detail).toBeNull();
    expect(change.summary.toLowerCase()).toMatch(/not recorded|no record/);
  });

  it("treats a from with no to the same way — a half-recorded change is not a diff", () => {
    const change = summariseChange(
      row({ metadata: { fields: "allowed_scopes", from: JSON.stringify([]) } })
    )!;
    expect(change.recorded).toBe(false);
    expect(change.detail).toBeNull();
  });

  it("renders unparseable metadata as unknown rather than throwing", () => {
    for (const bad of ["{not json", "", "42", '"a string"', "{}"]) {
      const change = summariseChange(
        row({ metadata: { fields: "allowed_scopes", from: bad, to: bad } })
      );
      expect(() => summariseChange(row({ metadata: { from: bad } }))).not.toThrow();
      expect(change?.detail ?? null, bad).toBeNull();
      expect(change?.recorded, bad).toBe(false);
    }
  });

  // `"null"` is NOT unparseable — it is what the very first scope edit on a
  // fresh agent writes, because updateAgentScopes serialises
  // `before?.allowed_scopes ?? null`. Treating it as unrecorded would mark
  // every agent's first amendment as a gap in the record when it is the one
  // change we know most about: there was nothing there before.
  it("reads a null previous value as a real record, not a missing one", () => {
    const change = summariseChange(
      row({
        metadata: {
          fields: "allowed_scopes",
          from: "null",
          to: JSON.stringify([{ provider: "openai", models: ["gpt-4o"] }]),
        },
      })
    )!;
    expect(change.recorded).toBe(true);
    expect(change.detail?.join(" ")).toContain("openai");
  });

  it("survives a metadata that is not an object at all", () => {
    for (const bad of [null, 42, "string", []]) {
      expect(() => summariseChange(row({ metadata: bad }))).not.toThrow();
    }
  });

  // budget_tokens,budget_cents is recorded with fields only — no from/to — so
  // it must land on the honest path rather than being silently skipped.
  it("shows a budget change as changed-but-unrecorded", () => {
    const change = summariseChange(
      row({ metadata: { fields: "budget_tokens,budget_cents" } })
    )!;
    expect(change.recorded).toBe(false);
    expect(change.summary.toLowerCase()).toContain("budget");
  });
});

describe("non-update actions still belong in the history", () => {
  it("reads a suspend and a resume from the same action", () => {
    expect(summariseChange(row({ action: "agent.suspend", metadata: { suspended: true } }))!.summary)
      .toMatch(/suspended/i);
    expect(summariseChange(row({ action: "agent.suspend", metadata: { suspended: false } }))!.summary)
      .toMatch(/resumed/i);
  });

  it("reads a revoke as terminal", () => {
    expect(summariseChange(row({ action: "agent.revoke" }))!.summary).toMatch(/revoked/i);
  });

  it("reads the issuance that started it", () => {
    expect(summariseChange(row({ action: "agent.create", metadata: { name: "Bot" } }))!.summary)
      .toMatch(/issued|created/i);
  });

  it("distinguishes direct-first creation and installation-key lifecycle", () => {
    expect(
      summariseChange(
        row({ action: "agent.create", metadata: { name: "Bot", auth_method: "direct_key" } })
      )!.summary
    ).toMatch(/direct agent created/i);
    expect(
      summariseChange(
        row({ action: "agent.direct_key.create", metadata: { name: "CI", suffix: "AbCd1234" } })
      )!.summary
    ).toMatch(/key created.*CI.*AbCd1234/i);
    expect(
      summariseChange(
        row({ action: "agent.direct_key.revoke", metadata: { name: "CI", suffix: "AbCd1234" } })
      )!.summary
    ).toMatch(/key revoked.*CI.*AbCd1234/i);
  });

  // A row about something else entirely (a provider key, the kill switch) has
  // no place on one agent's page.
  it("drops an action that is not about an agent", () => {
    expect(summariseChange(row({ action: "provider_key.add" }))).toBeNull();
    expect(summariseChange(row({ action: "killswitch.master" }))).toBeNull();
  });
});

describe("where the change came from", () => {
  it("reads an explicit api marker", () => {
    expect(summariseChange(scopeRow([], [], { via: "api" }))!.via).toBe("api");
  });

  it("reads an explicit dashboard marker", () => {
    expect(summariseChange(scopeRow([], [], { via: "dashboard" }))!.via).toBe("dashboard");
  });

  // Rows already in the database were written before the dashboard actions set
  // `via` at all. Absent must mean dashboard, or every historical row would be
  // attributed to an API key nobody used.
  it("treats an absent marker as the dashboard, not as unknown", () => {
    expect(summariseChange(scopeRow([], []))!.via).toBe("dashboard");
  });

  it("does not trust an unrecognised marker", () => {
    expect(summariseChange(scopeRow([], [], { via: "somewhere-else" }))!.via).toBe("dashboard");
  });
});

describe("the list", () => {
  it("drops rows it cannot place and keeps the rest in order", () => {
    const history = toCapabilityHistory([
      row({ id: "a", action: "provider_key.add" }),
      row({ id: "b", action: "agent.revoke", created_at: "2026-08-07T12:00:00.000Z" }),
      row({ id: "c", action: "agent.create", created_at: "2026-08-07T09:00:00.000Z" }),
    ]);
    expect(history.map((h) => h.id)).toEqual(["b", "c"]);
  });

  it("tolerates a non-array", () => {
    for (const bad of [null, undefined, 42, "rows", {}]) {
      expect(toCapabilityHistory(bad)).toEqual([]);
    }
  });
});

describe("the dashboard actions now say where a change came from", () => {
  const actions = read("app/dashboard/actions.ts");

  // Half of the `via` story. Without this, every dashboard row has the field
  // absent and the fallback above is the only thing keeping attribution honest
  // — which works, but leaves new rows indistinguishable from old ones.
  it.each(["updateAgentScopes", "updateAgentFallbacks"])("%s records via: dashboard", (name) => {
    const at = actions.indexOf(`export async function ${name}`);
    expect(at).toBeGreaterThan(-1);
    const body = actions.slice(at, actions.indexOf("\nexport async function ", at + 1));
    expect(body).toMatch(/via: "dashboard"/);
  });
});

describe("the panel", () => {
  const ui = read("components/CapabilityHistory.tsx");

  it("is on the agent's passport page", () => {
    expect(read("components/AgentPassport.tsx")).toMatch(/<CapabilityHistory/);
  });

  it("marks an unrecorded change as such rather than hiding it", () => {
    // Written as a ternary on `recorded`, so match the values, not a literal
    // attribute — and require BOTH, since a panel that only ever emitted
    // "recorded" would satisfy a one-sided check while erasing the distinction.
    expect(ui).toMatch(/data-state=\{[^}]*recorded[^}]*\}/);
    expect(ui).toContain('"unrecorded"');
    expect(ui).toContain('"recorded"');
    // And it must say so in words, not only in an attribute a reader cannot see.
    expect(ui).toMatch(/not known|not recorded/i);
  });

  it("says nothing has changed rather than rendering an empty list", () => {
    expect(ui).toMatch(/data-state="empty"/);
  });

  // "We never recorded this" and "we recorded it and what is stored cannot be
  // read" are different facts about the audit trail, and only the second one
  // means something was lost. A panel that renders them identically is the
  // reason the truncation went unnoticed.
  it("renders a damaged snapshot differently from one that was never recorded", () => {
    expect(ui).toContain('"damaged"');
    expect(ui).toContain('"unrecorded"');
    expect(ui).toMatch(/cannot be read|damaged/i);
  });
});

// The join this whole panel rests on, checked against the WRITER rather than a
// fixture. loadCapabilityHistory filters .eq("target_id", agentId); the writer
// puts targetId through sanitizeValue and a 256-char truncation first. If those
// altered a UUID by even one character the filter would never match, the panel
// would be permanently empty, and every test above would stay green — they all
// build their own rows and never touch buildAuditRecord.
describe("the id the writer stores is the id the reader filters on", () => {
  it("round-trips an agent uuid untouched", () => {
    const agentId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const record = buildAuditRecord({
      userId: "b1a7c0de-0000-4000-8000-000000000001",
      action: "agent.update",
      targetType: "agent",
      targetId: agentId,
      metadata: { fields: "allowed_scopes" },
    });
    expect(record.target_id).toBe(agentId);
    expect(record.target_type).toBe("agent");
  });
});

describe("the page loads the history", () => {
  const data = read("app/dashboard/agents/[id]/passport-data.ts");

  it("reads admin_audit scoped to this tenant AND this agent", () => {
    expect(data).toMatch(/from\("admin_audit"\)/);
    expect(data).toMatch(/\.eq\("user_id", userId\)/);
    expect(data).toMatch(/\.eq\("target_id", agentId\)/);
  });

  // Supplementary, like loadProviderStamps: a failure here degrades the panel,
  // it does not take the passport page down.
  it("carries the history onto the view", () => {
    expect(data).toMatch(/history:/);
  });
});
