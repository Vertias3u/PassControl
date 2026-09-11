// `passcontrol import` refusing a truncated export, through the real binary.
//
// The failure this prevents is quiet by construction: `snapshot.workspace?.agents ?? []`
// turned a damaged file into an empty fleet, the API planned nothing, `every()`
// over an empty plan reported `complete: true`, and the CLI printed "Nothing to
// create." and exited 0. Every surface said the restore succeeded and no fleet
// had been restored at all (T4-03).
//
// Run as a process, because the exit code is half the contract — a script that
// checks `$?` after a restore is exactly the caller this defect misled.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "bin/passcontrol.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "pc-import-"));

function fileWith(body: unknown): string {
  const target = path.join(dir, `snapshot-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(target, JSON.stringify(body));
  return target;
}

// A closed port for the control API: a file that gets PAST the envelope check
// has to fail somewhere, and it must fail fast rather than sit waiting on a
// prompt or a real network. The distinction under test is WHICH stage refused.
const runImport = (file: string) =>
  execFileAsync(process.execPath, [CLI, "import", file], {
    timeout: 10_000,
    env: {
      ...process.env,
      PASSCONTROL_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      PASSCONTROL_GATEWAY: "http://127.0.0.1:1",
      PASSCONTROL_API_KEY: `pc_${"a".repeat(40)}`,
    },
  });

const TRUNCATED = [
  ["a workspace with no agents key", { format: "passcontrol-export", version: 1, workspace: {} }],
  ["no workspace block at all", { format: "passcontrol-export", version: 1 }],
  ["a null agents collection", { format: "passcontrol-export", version: 1, workspace: { agents: null } }],
  ["an agents object rather than an array", { format: "passcontrol-export", version: 1, workspace: { agents: {} } }],
] as const;

describe("passcontrol import refuses a damaged export", () => {
  // Non-zero AND the right reason. Exit 1 alone proves nothing here: with the
  // guard removed the file reaches the control API and fails on the closed port
  // in this fixture, so a status-only assertion stays green on the bug.
  it.each(TRUNCATED)("refuses %s before it ever reaches the gateway", async (_label, body) => {
    const error: { code?: number; stdout?: string; stderr?: string } = await runImport(
      fileWith(body)
    ).catch((e: { code?: number; stdout?: string; stderr?: string }) => e);
    expect(error.code).toBe(1);
    expect(`${error.stdout ?? ""}${error.stderr ?? ""}`).toMatch(/truncated or damaged/i);
  });

  it("says the file is damaged rather than reporting an empty workspace", async () => {
    const error = await runImport(fileWith({ format: "passcontrol-export", version: 1, workspace: {} })).catch(
      (e: { stdout?: string; stderr?: string }) => e
    );
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;

    expect(output).toMatch(/truncated or damaged/i);
    expect(output).not.toMatch(/Nothing to create/i);
    expect(output).not.toMatch(/complete/i);
  });

  // The control, and the half that makes the refusal a rule rather than a
  // blanket. A workspace with no agents is a real export and must still import.
  it("does not refuse a genuinely empty fleet on envelope grounds", async () => {
    const error = await runImport(
      fileWith({ format: "passcontrol-export", version: 1, workspace: { agents: [] } })
    ).catch((e: { stdout?: string; stderr?: string }) => e);
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;

    // It gets past the envelope check and fails later, on there being no
    // gateway configured in this environment — which is the point: a different
    // failure, from a different stage.
    expect(output).not.toMatch(/truncated or damaged/i);
  });
});
