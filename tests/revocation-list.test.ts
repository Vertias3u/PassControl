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
    expect(c.covers.includes).toEqual(["revoked", "rotated"]);
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
  it("derives entries from exactly two actions, and nothing else in the trail", () => {
    expect([...REVOCATION_SOURCE_ACTIONS].sort()).toEqual(["agent.revoke", "agent.update"]);
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
    }
  });
});
