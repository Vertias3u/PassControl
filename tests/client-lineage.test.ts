// Which session and which sub-agent a call says it came from, read from the headers
// Claude Code and Codex already send. Every expectation below is from a real request
// (tests/fixtures/{claude-code,codex}/subagent-*.json, captured 2026-10-08), not from
// reading a binary.
//
// These values are DECLARED by the client. They identify; they do not authenticate.
// So a malformed value is dropped silently ("not declared"), never an error and never
// a refusal: a lineage header must not be able to break a call.
import { describe, expect, it } from "vitest";
import { readClientLineage } from "@/lib/client-lineage";
import ccDirect from "./fixtures/claude-code/subagent-direct.json";
import ccSidecar from "./fixtures/claude-code/subagent-sidecar.json";
import codexDirect from "./fixtures/codex/subagent-direct.json";
import codexSidecar from "./fixtures/codex/subagent-sidecar.json";

type Captured = { role: string; headers: Record<string, string>; body: Record<string, unknown> };

const read = (r: Captured) => readClientLineage(new Headers(r.headers), r.body);

/** A header source that can return what `Headers` would refuse to hold. */
const raw = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

describe.each([
  ["direct", ccDirect.requests as Captured[]],
  ["through the sidecar", ccSidecar.requests as Captured[]],
])("Claude Code 2.1.293, %s", (_via, requests) => {
  const session = requests[0]!.headers["x-claude-code-session-id"];
  const sub = requests.find((r) => r.role === "subagent")!;
  const nested = requests.find((r) => r.role === "nested-subagent")!;

  it("the main agent declares the session and no agent", () => {
    for (const r of requests.filter((x) => x.role === "main")) {
      expect(read(r)).toEqual({ kind: "claude-code", session, agent: null, parent: null });
    }
  });

  it("a first-level sub-agent declares itself and no parent: its parent is the main agent", () => {
    expect(read(sub)).toEqual({ kind: "claude-code", session, agent: sub.headers["x-claude-code-agent-id"], parent: null });
  });

  it("a sub-agent's own sub-agent declares its parent", () => {
    expect(read(nested)).toEqual({
      kind: "claude-code",
      session,
      agent: nested.headers["x-claude-code-agent-id"],
      parent: sub.headers["x-claude-code-agent-id"],
    });
  });
});

describe.each([
  ["direct", codexDirect.requests as Captured[]],
  ["through the sidecar", codexSidecar.requests as Captured[]],
])("Codex 0.158, %s", (_via, requests) => {
  const session = requests[0]!.headers["session-id"];
  const sub = requests.find((r) => r.role === "subagent")!;

  it("the main thread declares the session and no agent", () => {
    for (const r of requests.filter((x) => x.role === "main")) {
      expect(read(r)).toEqual({ kind: "codex", session, agent: null, parent: null });
    }
  });

  it("a spawned thread is the agent; a parent that is the root thread reads as the main agent", () => {
    expect(sub.headers["x-codex-parent-thread-id"]).toBe(session);
    expect(read(sub)).toEqual({ kind: "codex", session, agent: sub.headers["thread-id"], parent: null });
  });
});

describe("Codex header spellings", () => {
  const base = { originator: "codex_exec", "thread-id": "t-1" };

  it("reads the underscore header when the hyphen one is absent", () => {
    expect(readClientLineage(raw({ ...base, session_id: "s-1" }))?.session).toBe("s-1");
  });

  it("falls back to client_metadata.session_id in the body", () => {
    expect(readClientLineage(raw(base), { client_metadata: { session_id: "s-2" } })?.session).toBe("s-2");
  });

  it("drops a session the client declared two different ways", () => {
    expect(readClientLineage(raw({ ...base, "session-id": "s-1", session_id: "s-9" }))).toBeNull();
    expect(readClientLineage(raw({ ...base, "session-id": "s-1" }), { client_metadata: { session_id: "s-9" } })).toBeNull();
  });

  it("a depth-2 Codex thread keeps a parent that is not the root", () => {
    const h = raw({ ...base, "session-id": "root", "thread-id": "child-2", "x-codex-parent-thread-id": "child-1", "x-openai-subagent": "collab_spawn" });
    expect(readClientLineage(h)).toEqual({ kind: "codex", session: "root", agent: "child-2", parent: "child-1" });
  });

  it("does not call an unknown client with a bare session-id header Codex", () => {
    expect(readClientLineage(raw({ "session-id": "s-1", "thread-id": "t-1" }))).toBeNull();
  });
});

describe("the sidecar's run id is the fallback session", () => {
  it("is used when no CLI declares a session", () => {
    expect(readClientLineage(raw({ "x-passcontrol-run": "run-1" }))).toEqual({
      kind: "sidecar",
      session: "run-1",
      agent: null,
      parent: null,
    });
  });

  it("loses to the CLI's own session, which is the more specific one", () => {
    const h = raw({ "x-passcontrol-run": "run-1", "x-claude-code-session-id": "cc-1" });
    expect(readClientLineage(h)).toEqual({ kind: "claude-code", session: "cc-1", agent: null, parent: null });
  });

  it("takes over when the CLI's session is malformed, without the CLI's agent ids", () => {
    const h = raw({ "x-passcontrol-run": "run-1", "x-claude-code-session-id": "bad value", "x-claude-code-agent-id": "a1" });
    expect(readClientLineage(h)).toEqual({ kind: "sidecar", session: "run-1", agent: null, parent: null });
  });
});

describe("nothing declared is null", () => {
  it.each([
    ["no headers", {}],
    ["an agent id with no session", { "x-claude-code-agent-id": "a1" }],
  ])("%s", (_name, h) => {
    expect(readClientLineage(raw(h))).toBeNull();
  });

  it("a body that is not an object", () => {
    expect(readClientLineage(raw({ originator: "codex_exec" }), "not json")).toBeNull();
    expect(readClientLineage(raw({ originator: "codex_exec" }), null)).toBeNull();
    expect(readClientLineage(raw({ originator: "codex_exec" }), { client_metadata: ["x"] })).toBeNull();
  });
});

describe("hostile values are dropped, never passed on and never thrown", () => {
  const HOSTILE = [
    "a\nb",
    "a\r\nx-api-key: stolen",
    "x".repeat(10 * 1024),
    "x".repeat(129),
    "",
    "has space",
    "sessión",
    "😀",
    "a,b",
    "a/../b",
    "<script>",
  ];

  it.each(HOSTILE)("as a Claude Code session: %j", (v) => {
    expect(readClientLineage(raw({ "x-claude-code-session-id": v }))).toBeNull();
  });

  it.each(HOSTILE)("as an agent or parent id: %j", (v) => {
    const out = readClientLineage(raw({ "x-claude-code-session-id": "s", "x-claude-code-agent-id": v, "x-claude-code-parent-agent-id": v }));
    expect(out).toEqual({ kind: "claude-code", session: "s", agent: null, parent: null });
  });

  it.each(HOSTILE)("as a Codex body session: %j", (v) => {
    expect(readClientLineage(raw({ originator: "codex_exec" }), { client_metadata: { session_id: v } })).toBeNull();
  });

  it("a parent with no agent is not kept: it would describe nobody", () => {
    const out = readClientLineage(raw({ "x-claude-code-session-id": "s", "x-claude-code-parent-agent-id": "p" }));
    expect(out).toEqual({ kind: "claude-code", session: "s", agent: null, parent: null });
  });

  it("accepts the longest allowed value and the full character set", () => {
    const max = "A".repeat(128);
    const chars = "aZ09._:-";
    expect(readClientLineage(raw({ "x-claude-code-session-id": max }))?.session).toBe(max);
    expect(readClientLineage(raw({ "x-claude-code-session-id": chars }))?.session).toBe(chars);
  });

  it("a non-string in the body is dropped", () => {
    for (const v of [42, true, { a: 1 }, ["s"]]) {
      expect(readClientLineage(raw({ originator: "codex_exec" }), { client_metadata: { session_id: v } })).toBeNull();
    }
  });
});
