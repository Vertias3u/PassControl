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
import { declaredSession } from "../cli/declared-session.mjs";

const RUN = "run-1234";
const gateway = (headers: Record<string, string>) =>
  readClientLineage(new Headers({ ...headers, "x-passcontrol-run": RUN }))?.session ?? null;
const cliSide = (headers: Record<string, string>) => declaredSession((name: string) => headers[name] ?? null, RUN);

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
