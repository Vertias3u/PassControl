// The sidecar writes each call's declared session into its journal (2026-10-08 E2E: one
// sidecar run serves many Claude Code sessions, and a journal without sessions made every
// seal check report the other sessions' calls as "missing"). The sidecar is plain ESM and
// cannot import the gateway's TypeScript, so cli/declared-session.mjs is a second copy of
// the HEADER rules in lib/client-lineage.ts. This file is what keeps the two the same: if
// they disagree on a call, the verifier filters the journal by a session the receipt
// does not carry, and a real omission could hide.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readClientLineage } from "@/lib/client-lineage";
// @ts-expect-error -- plain ESM CLI module, no declaration file
import { declaredLineage, declaredSession } from "../cli/declared-session.mjs";

const RUN = "run-1234";
const gateway = (headers: Record<string, string>) =>
  readClientLineage(new Headers({ ...headers, "x-passcontrol-run": RUN }))?.session ?? null;
const cliSide = (headers: Record<string, string>) => declaredSession((name: string) => headers[name] ?? null, RUN);

// `passcontrol watch` (F6) puts each call on a sub-agent's row from the same copy, so
// the agent and its parent must agree too, not only the session.
const gatewayLineage = (headers: Record<string, string>) => {
  const l = readClientLineage(new Headers({ ...headers, "x-passcontrol-run": RUN }));
  return l ? { session: l.session, agent: l.agent, parent: l.parent } : null;
};
const cliLineage = (headers: Record<string, string>) => declaredLineage((name: string) => headers[name] ?? null, RUN);

const FIXTURES = [
  "tests/fixtures/claude-code/subagent-direct.json",
  "tests/fixtures/claude-code/subagent-sidecar.json",
  "tests/fixtures/codex/subagent-direct.json",
  "tests/fixtures/codex/subagent-sidecar.json",
];

describe("the sidecar names a call's session exactly as the gateway does", () => {
  for (const file of FIXTURES) {
    const { requests } = JSON.parse(readFileSync(file, "utf8")) as { requests: { role: string; headers: Record<string, string> }[] };
    it.each(requests.map((r, i) => [`${file.split("/").slice(-2).join("/")} #${i} (${r.role})`, r.headers] as const))("%s", (_name, headers) => {
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
      expect(cliSide(lower)).toBe(gateway(lower));
    });
  }

  it.each([
    ["no headers at all: the run", {}],
    ["a Claude Code session", { "x-claude-code-session-id": "abc-123" }],
    ["a malformed Claude Code session falls through to the run", { "x-claude-code-session-id": "bad session!" }],
    ["Codex with matching session headers", { originator: "codex_exec", "session-id": "s1", session_id: "s1" }],
    ["Codex with disagreeing session headers: the run", { originator: "codex_exec", "session-id": "s1", session_id: "s2" }],
    ["a session-id header without any Codex marker: the run", { "session-id": "s1" }],
    ["Claude Code wins over Codex markers", { "x-claude-code-session-id": "cc", originator: "codex", "session-id": "cx" }],
  ] as [string, Record<string, string>][])("%s", (_name, headers) => {
    expect(cliSide(headers)).toBe(gateway(headers));
  });
});

describe("the sidecar names a call's sub-agent and its parent exactly as the gateway does (F6)", () => {
  for (const file of FIXTURES) {
    const { requests } = JSON.parse(readFileSync(file, "utf8")) as { requests: { role: string; headers: Record<string, string> }[] };
    it.each(requests.map((r, i) => [`${file.split("/").slice(-2).join("/")} #${i} (${r.role})`, r.headers] as const))("%s", (_name, headers) => {
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
      expect(cliLineage(lower)).toEqual(gatewayLineage(lower));
    });
  }

  it("the fixtures include sub-agents and a nested one, so the cases above are not all main agents", () => {
    const roles = FIXTURES.flatMap((file) => (JSON.parse(readFileSync(file, "utf8")) as { requests: { role: string }[] }).requests.map((r) => r.role));
    expect(roles).toContain("subagent");
    expect(roles).toContain("nested-subagent");
  });

  it.each([
    ["no headers at all: the run, no agent", {}],
    ["a Claude Code sub-agent", { "x-claude-code-session-id": "s", "x-claude-code-agent-id": "a1" }],
    ["a nested Claude Code sub-agent", { "x-claude-code-session-id": "s", "x-claude-code-agent-id": "a2", "x-claude-code-parent-agent-id": "a1" }],
    ["a parent with no agent describes nobody", { "x-claude-code-session-id": "s", "x-claude-code-parent-agent-id": "a1" }],
    ["a malformed agent id is no agent", { "x-claude-code-session-id": "s", "x-claude-code-agent-id": "bad id!" }],
    ["the run stands in WITHOUT the CLI's agent ids", { "x-claude-code-session-id": "bad session!", "x-claude-code-agent-id": "a1" }],
    ["beside the run, a client's own declared agent", { "x-passcontrol-agent": "researcher" }],
    ["beside the run, a declared agent and its parent", { "x-passcontrol-agent": "writer", "x-passcontrol-parent": "researcher" }],
    ["a Claude Code session ignores x-passcontrol-agent", { "x-claude-code-session-id": "s", "x-passcontrol-agent": "researcher" }],
    ["a Codex sub-agent", { originator: "codex_exec", "session-id": "s1", "x-codex-parent-thread-id": "s1", "thread-id": "t2" }],
    ["a nested Codex sub-agent", { originator: "codex_exec", "session-id": "s1", "x-codex-parent-thread-id": "t2", "thread-id": "t3" }],
    ["Codex x-openai-subagent marks a spawn", { originator: "codex_exec", "session-id": "s1", "x-openai-subagent": "1", "thread-id": "t2" }],
    ["Codex main thread: no agent", { originator: "codex_exec", "session-id": "s1", "thread-id": "s1" }],
  ] as [string, Record<string, string>][])("%s", (_name, headers) => {
    expect(cliLineage(headers)).toEqual(gatewayLineage(headers));
  });
});
