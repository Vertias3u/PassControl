// The public revocation list.
//
// One question, from a stranger holding a receipt: was this passport still good
// at the moment it signed? /verify answers "does this passport exist" for one id
// you already know. This answers "which passports stopped being valid, and
// when" — offline, cached, and without asking the tenant.
//
// The rule that shapes every test below: a revocation list is MONOTONIC. An
// entry may be added and must never be withdrawn, because a verifier caches it
// and an entry that disappears silently converts "this key was dead" into "this
// key was fine". That single property decides what may go in it, and it happens
// to be the same answer the disclosure rule gives — see the module header.
import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/audit";
import {
  REVOCATION_LIST_FORMAT,
  REVOCATION_LIST_VERSION,
  REVOCATION_SOURCE_ACTIONS,
  DELEGATION_REVOCATION_ACTION,
  buildDelegationRevocations,
  buildRevocationEntries,
  buildRevocationListClaims,
} from "@/lib/revocation-list";

const AGENTS = [
  { id: "agent-1", passport_pubkey: "key-one" },
  { id: "agent-2", passport_pubkey: "key-two" },
  { id: "agent-3", passport_pubkey: null },
];

const revokeRow = (agentId: string, at: string) => ({
  action: "agent.revoke",
  target_id: agentId,
  created_at: at,
  metadata: {},
});

const rotateRow = (from: string, until: string, at = "2026-01-01T00:00:00.000Z") => ({
  action: "agent.update",
  target_id: "agent-1",
  created_at: at,
  metadata: { rotated: true, from, to: "key-new", previous_valid_until: until },
});

describe("what goes in the list", () => {
  it("publishes a revoked passport, dead from the moment the operator acted", () => {
    const entries = buildRevocationEntries(
      [revokeRow("agent-1", "2026-03-01T12:00:00.000Z")],
      AGENTS
    );
    expect(entries).toEqual([{ id: "key-one", notValidAfter: "2026-03-01T12:00:00.000Z" }]);
  });

  // The retired key stops working when its GRACE window closes, not when the
  // operator rotated. Publishing the rotation time would declare receipts dead
  // that the gateway itself was still accepting.
  it("publishes a rotated-out key, dead when its grace window closes", () => {
    const entries = buildRevocationEntries(
      [rotateRow("key-old", "2026-03-01T13:00:00.000Z")],
      AGENTS
    );
    expect(entries).toEqual([{ id: "key-old", notValidAfter: "2026-03-01T13:00:00.000Z" }]);
  });

  // An open grace window is a real, correct entry: "not valid after T" with T in
  // the future is exactly what a verifier needs to judge a receipt signed today.
  it("keeps an entry whose grace window has not closed yet", () => {
    const entries = buildRevocationEntries([rotateRow("key-old", "2099-01-01T00:00:00.000Z")], AGENTS);
    expect(entries).toHaveLength(1);
  });

  // A key that was rotated out AND whose agent was then revoked stopped being
  // valid at the earlier of the two. Taking the later one would vouch for a
  // window in which the gateway was already refusing it.
  it("takes the earliest death when a key is named twice", () => {
    const entries = buildRevocationEntries(
      [
        rotateRow("key-old", "2026-03-05T00:00:00.000Z"),
        { ...revokeRow("agent-1", "2026-03-02T00:00:00.000Z"), metadata: {} },
        { action: "agent.update", target_id: "agent-1", created_at: "2026-01-01T00:00:00.000Z",
          metadata: { rotated: true, from: "key-old", previous_valid_until: "2026-03-09T00:00:00.000Z" } },
      ],
      AGENTS
    );
    expect(entries.filter((e) => e.id === "key-old")).toEqual([
      { id: "key-old", notValidAfter: "2026-03-05T00:00:00.000Z" },
    ]);
  });

  it("is ordered and free of duplicates, so the document is stable between fetches", () => {
    const entries = buildRevocationEntries(
      [revokeRow("agent-2", "2026-03-01T00:00:00.000Z"), revokeRow("agent-1", "2026-02-01T00:00:00.000Z")],
      AGENTS
    );
    expect(entries.map((e) => e.id)).toEqual(["key-one", "key-two"]);
  });
});

describe("what stays out of it, and why", () => {
  // A Direct Agent Key is a bearer credential with no public half. There is
  // nothing for a stranger to verify a signature against, so an entry naming it
  // would be an identifier no verifier could ever match.
  it("says nothing about an agent that never had a passport", () => {
    expect(buildRevocationEntries([revokeRow("agent-3", "2026-03-01T00:00:00.000Z")], AGENTS)).toEqual([]);
  });

  // SUSPENSION IS REVERSIBLE. An operator suspends an agent on Monday and
  // resumes it on Tuesday; the entry would have to be withdrawn, and a verifier
  // that cached the list would keep refusing a passport that is fine. The list
  // would also become a per-tenant incident feed anyone could poll.
  it("never publishes a suspension", () => {
    const suspend = {
      action: "agent.suspend",
      target_id: "agent-1",
      created_at: "2026-03-01T00:00:00.000Z",
      metadata: { suspended: true },
    };
    expect(buildRevocationEntries([suspend], AGENTS)).toEqual([]);
  });

  // Kill-switch state lives in Redis and is read per request. It is the most
  // incident-shaped signal in the product and it is reversible twice over —
  // platform and per-tenant. It has no representation here at all.
  it("never publishes kill-switch state", () => {
    const kill = {
      action: "killswitch.master",
      target_id: "agent-1",
      created_at: "2026-03-01T00:00:00.000Z",
      metadata: { on: true },
    };
    expect(buildRevocationEntries([kill], AGENTS)).toEqual([]);
  });

  // A rotation recorded before the retired key was added to the audit metadata
  // cannot be published: nothing anywhere still holds that key once the
  // reconcile sweep clears the column. Dropping it is the only honest option —
  // inventing an id would be worse than an incomplete list, which `covers`
  // already tells the verifier to expect.
  it("skips a rotation that did not record which key it retired", () => {
    const old = {
      action: "agent.update",
      target_id: "agent-1",
      created_at: "2026-01-01T00:00:00.000Z",
      metadata: { rotated: true, to: "key-new", previous_valid_until: "2026-03-01T00:00:00.000Z" },
    };
    expect(buildRevocationEntries([old], AGENTS)).toEqual([]);
  });

  it("ignores an ordinary update that rotated nothing", () => {
    const update = {
      action: "agent.update",
      target_id: "agent-1",
      created_at: "2026-01-01T00:00:00.000Z",
      metadata: { fields: "expires_at", to: "2027-01-01T00:00:00.000Z" },
    };
    expect(buildRevocationEntries([update], AGENTS)).toEqual([]);
  });

  it("drops a row whose timestamp cannot be read rather than guessing one", () => {
    expect(buildRevocationEntries([revokeRow("agent-1", "whenever")], AGENTS)).toEqual([]);
    expect(buildRevocationEntries([rotateRow("key-old", "soon")], AGENTS)).toEqual([]);
  });
});

describe("the document a verifier reads", () => {
  const claims = () =>
    buildRevocationListClaims({
      issuer: "https://passcontrol.vertias.eu",
      entries: [{ id: "key-one", notValidAfter: "2026-03-01T00:00:00.000Z" }],
      generatedAt: Date.parse("2026-09-02T00:00:00.000Z"),
    });

  it("is dated and attributed, so it cannot be replayed to hide a later revocation", () => {
    const c = claims();
    expect(c.iss).toBe("https://passcontrol.vertias.eu");
    expect(c.iat).toBe(Math.floor(Date.parse("2026-09-02T00:00:00.000Z") / 1000));
    expect(c.fmt).toBe(REVOCATION_LIST_FORMAT);
    expect(c.v).toBe(REVOCATION_LIST_VERSION);
  });

  // THE MOST IMPORTANT FIELD IN THE DOCUMENT. A verifier that reads "not in the
  // list" as "was valid" has drawn a conclusion this list cannot support: an
  // expired passport is absent and was not valid. `covers` says so in the signed
  // payload rather than in documentation nobody fetches.
  it("names what it enumerates AND what it does not", () => {
    const c = claims();
    expect(c.covers.includes).toEqual(["revoked", "rotated", "delegation_revoked", "delegation_watermark"]);
    expect(c.covers.excludes).toContain("expired");
    expect(c.covers.excludes).toContain("suspended");
    expect(c.covers.excludes).toContain("kill_switch");
  });
});

// The coverage field is a hand-written array; the audit actions it implicitly
// promises to exclude live in AUDIT_ACTIONS. Nothing connected the two, so a
// future reversible agent state could be added and this document would keep
// claiming the same three exclusions while quietly publishing it — or quietly
// not. Same discipline as tests/audit.test.ts pinning the action set itself.
describe("the boundary between the audit trail and what is published", () => {
  it("derives entries from exactly three actions, and nothing else in the trail", () => {
    expect([...REVOCATION_SOURCE_ACTIONS].sort()).toEqual(["agent.delegation_revoke", "agent.revoke", "agent.update"]);
    for (const action of REVOCATION_SOURCE_ACTIONS) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });

  // Feed one row for EVERY action the product can write. Only the two named
  // above may produce an entry — so adding a new agent-state action to
  // AUDIT_ACTIONS lands here and forces a decision about this list rather than
  // silently inheriting one.
  it("publishes nothing for any other audit action, whatever it is", () => {
    for (const action of AUDIT_ACTIONS) {
      if ((REVOCATION_SOURCE_ACTIONS as readonly string[]).includes(action)) continue;
      const row = {
        action,
        target_id: "agent-1",
        created_at: "2026-03-01T00:00:00.000Z",
        // Deliberately hostile: the metadata a rotation would carry, on the
        // wrong action. The action check has to be what decides, not the shape.
        metadata: { rotated: true, from: "key-old", previous_valid_until: "2026-04-01T00:00:00.000Z" },
      };
      expect(buildRevocationEntries([row], AGENTS)).toEqual([]);
      // And the shape a watermark raise carries, on every other action.
      if (action === DELEGATION_REVOCATION_ACTION) continue;
      const watermark = { ...row, metadata: { all: true, valid_after: "2026-03-01T00:00:00.000Z", passports: ["key-one"] } };
      expect(buildDelegationRevocations([watermark]).delegationWatermarks).toEqual([]);
      const single = { ...row, metadata: { all: false, jti: "jti-0000000000000001", passports: ["key-one"] } };
      expect(buildDelegationRevocations([single]).delegations).toEqual([]);
    }
  });
});

// P2.4 (owner 2026-10-10: "start this"). A worker's receipt names its delegation and
// lists every link's jti (`dc`), and its `sub` is the root passport. Two permanent deaths
// reach a delegation, and both may only ever be added, so both belong here:
//   * one jti revoked by its owner (delegation_revocations, append-only, 0081);
//   * the agent's watermark: every delegation rooted in its passport and issued at or
//     before T stops being valid at T. The column only moves forward, but publishing
//     only its CURRENT value would erase the earlier raise, so each raise is its own
//     entry, read from the append-only audit row written when it happened.
describe("what a worker's delegation adds to the list", () => {
  // Both kinds are read from the append-only audit row written when the owner acted,
  // which records the root passport(s) the revocation covered AT THAT MOMENT.
  const revoke = (jti: string, at: string, passports: unknown = ["key-one"], extra: Record<string, unknown> = {}) => ({
    action: "agent.delegation_revoke",
    target_id: "agent-1",
    created_at: at,
    metadata: { all: false, jti, passports, ...extra },
  });
  const raise = (at: string, passports: unknown, extra: Record<string, unknown> = {}) => ({
    action: "agent.delegation_revoke",
    target_id: "agent-1",
    created_at: at,
    metadata: { all: true, valid_after: at, passports, ...extra },
  });

  it("publishes a revoked jti under its root passport, dead from the moment its owner revoked it", () => {
    const out = buildDelegationRevocations([revoke("jti-0000000000000001", "2026-10-10T12:00:00.000Z")]);
    expect(out.delegations).toEqual([{ id: "key-one", jti: "jti-0000000000000001", notValidAfter: "2026-10-10T12:00:00.000Z" }]);
  });

  // THE SCOPING CASE (advisor, 2026-10-10). A delegator chooses its own jti, and the
  // owner may revoke a jti never seen, so a jti alone names nobody: tenant A could
  // revoke tenant B's jti, copied from a receipt, and the instance would sign "B's
  // delegation is dead". Scoped to the passport, A's revocation says only that A's
  // delegation with that jti is dead, which is true.
  it("keeps two passports' revocations of the same jti apart", () => {
    const out = buildDelegationRevocations([
      revoke("jti-0000000000000001", "2026-10-10T12:00:00.000Z", ["key-a"]),
      revoke("jti-0000000000000001", "2026-10-10T13:00:00.000Z", ["key-b"]),
    ]);
    expect(out.delegations).toEqual([
      { id: "key-a", jti: "jti-0000000000000001", notValidAfter: "2026-10-10T12:00:00.000Z" },
      { id: "key-b", jti: "jti-0000000000000001", notValidAfter: "2026-10-10T13:00:00.000Z" },
    ]);
  });

  it("publishes a revocation under every passport it covered (a key still in its grace window)", () => {
    const out = buildDelegationRevocations([revoke("jti-0000000000000001", "2026-10-10T12:00:00.000Z", ["key-now", "key-old"])]);
    expect(out.delegations.map((d) => d.id)).toEqual(["key-now", "key-old"]);
  });

  it("orders the entries and keeps the earliest of two records for one passport and jti", () => {
    const out = buildDelegationRevocations([
      revoke("jti-0000000000000002", "2026-10-10T12:00:00.000Z"),
      revoke("jti-0000000000000001", "2026-10-10T13:00:00.000Z"),
      revoke("jti-0000000000000001", "2026-10-10T11:00:00.000Z"),
    ]);
    expect(out.delegations).toEqual([
      { id: "key-one", jti: "jti-0000000000000001", notValidAfter: "2026-10-10T11:00:00.000Z" },
      { id: "key-one", jti: "jti-0000000000000002", notValidAfter: "2026-10-10T12:00:00.000Z" },
    ]);
  });

  it.each([
    ["a jti of the wrong shape", revoke("short", "2026-10-10T12:00:00.000Z")],
    ["a jti with a character no delegation uses", revoke("jti-000000000000000!", "2026-10-10T12:00:00.000Z")],
    ["an unreadable time", revoke("jti-0000000000000001", "soon")],
    ["no recorded passports (written before this format)", { ...revoke("jti-0000000000000001", "2026-10-10T12:00:00.000Z"), metadata: { all: false, jti: "jti-0000000000000001" } }],
    ["passports that are not a list", revoke("jti-0000000000000001", "2026-10-10T12:00:00.000Z", "key-one")],
  ])("drops %s rather than guessing", (_label, row) => {
    expect(buildDelegationRevocations([row]).delegations).toEqual([]);
  });

  it("publishes a watermark raise under each passport it covered", () => {
    const out = buildDelegationRevocations([raise("2026-10-10T12:00:00.000Z", ["key-now", "key-old"])]);
    expect(out.delegationWatermarks).toEqual([
      { id: "key-now", issuedAtOrBefore: "2026-10-10T12:00:00.000Z", notValidAfter: "2026-10-10T12:00:00.000Z" },
      { id: "key-old", issuedAtOrBefore: "2026-10-10T12:00:00.000Z", notValidAfter: "2026-10-10T12:00:00.000Z" },
    ]);
    expect(out.delegations).toEqual([]);
  });

  // THE MONOTONICITY CASE. A receipt from between the two raises, for a delegation
  // issued before the first, was already dead; only the first entry says so.
  it("keeps every raise, not only the latest", () => {
    const out = buildDelegationRevocations([raise("2026-10-12T00:00:00.000Z", ["key-now"]), raise("2026-10-10T00:00:00.000Z", ["key-now"])]);
    expect(out.delegationWatermarks.map((w) => w.issuedAtOrBefore)).toEqual(["2026-10-10T00:00:00.000Z", "2026-10-12T00:00:00.000Z"]);
  });

  it("publishes one entry for a raise recorded twice", () => {
    const r = raise("2026-10-10T00:00:00.000Z", ["key-now"]);
    expect(buildDelegationRevocations([r, r]).delegationWatermarks).toHaveLength(1);
  });

  it.each([
    ["a raise that recorded no passports (written before P2.4)", { ...raise("2026-10-10T00:00:00.000Z", ["x"]), metadata: { all: true } }],
    ["a raise whose passports are not a list", raise("2026-10-10T00:00:00.000Z", "key-now")],
    ["a raise with an unreadable time", raise("soon", ["key-now"])],
    ["metadata that says all as a string", raise("2026-10-10T00:00:00.000Z", ["key-now"], { all: "true" })],
  ])("publishes no watermark for %s", (_label, row) => {
    expect(buildDelegationRevocations([row]).delegationWatermarks).toEqual([]);
  });

  it("skips a passport id that is not a string, keeping the others", () => {
    const out = buildDelegationRevocations([
      raise("2026-10-10T00:00:00.000Z", ["key-now", 7, "", null]),
      revoke("jti-0000000000000001", "2026-10-10T12:00:00.000Z", ["key-now", 7, "", null]),
    ]);
    expect(out.delegationWatermarks.map((w) => w.id)).toEqual(["key-now"]);
    expect(out.delegations.map((d) => d.id)).toEqual(["key-now"]);
  });

  it("puts both in the signed document, empty when there are none", () => {
    const c = buildRevocationListClaims({ issuer: "https://gw.example", entries: [] });
    expect(c.delegations).toEqual([]);
    expect(c.delegationWatermarks).toEqual([]);
    const d = buildRevocationListClaims({
      issuer: "https://gw.example",
      entries: [],
      ...buildDelegationRevocations([revoke("jti-0000000000000001", "2026-10-10T12:00:00.000Z"), raise("2026-10-10T00:00:00.000Z", ["key-now"])]),
    });
    expect(d.delegations).toHaveLength(1);
    expect(d.delegationWatermarks).toHaveLength(1);
  });

  // Additive: a verifier written for the passport list reads `entries` exactly as before.
  it("leaves the passport entries and the version as they were", () => {
    const c = buildRevocationListClaims({ issuer: "https://gw.example", entries: [{ id: "key-one", notValidAfter: "2026-03-01T00:00:00.000Z" }] });
    expect(c.entries).toEqual([{ id: "key-one", notValidAfter: "2026-03-01T00:00:00.000Z" }]);
    expect(c.v).toBe(1);
  });
});
