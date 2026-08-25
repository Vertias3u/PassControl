// Every migration state the server can report must have a word in the CLI.
//
// This is the StatusPill trap, in a new place. `lib/log.ts`'s status union has a
// standing comment about it and a guard test that fails when any display map
// misses a member, because an unmapped status does not error — it falls through
// to a default and quietly says something vaguer than the truth. That is how
// five display maps once described a call that never left the gateway as "the
// upstream provider returned an error".
//
// `SCHEMA_WORD` in bin/passcontrol.mjs is keyed off `MigrationHealthState`,
// declared in lib/system-health/index.ts — a TypeScript union that a .mjs file
// cannot import and the compiler therefore cannot check. Add a member to the
// union and `passcontrol version` silently prints "see the dashboard" for it.
// So the union is read out of the source and compared, the same way
// tests/departures.test.ts pins UI wiring it cannot import.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();

function migrationStates(): string[] {
  const source = readFileSync(join(repo, "lib/system-health/index.ts"), "utf8");
  const match = /export type MigrationHealthState =([^;]+);/u.exec(source);
  if (!match) throw new Error("MigrationHealthState is no longer declared where this test looks");
  return [...match[1]!.matchAll(/"([a-z_]+)"/gu)].map((m) => m[1]!);
}

function schemaWords(): string[] {
  const source = readFileSync(join(repo, "bin/passcontrol.mjs"), "utf8");
  const match = /const SCHEMA_WORD = \{([\s\S]*?)\n\};/u.exec(source);
  if (!match) throw new Error("SCHEMA_WORD is no longer declared where this test looks");
  return [...match[1]!.matchAll(/^\s*([a-z_]+):/gmu)].map((m) => m[1]!);
}

describe("the CLI's migration vocabulary", () => {
  it("finds both declarations", () => {
    expect(migrationStates().length).toBeGreaterThan(0);
    expect(schemaWords().length).toBeGreaterThan(0);
  });

  it("has a word for every state the server can report", () => {
    const missing = migrationStates().filter((state) => !schemaWords().includes(state));
    expect(missing, `SCHEMA_WORD in bin/passcontrol.mjs is missing: ${missing.join(", ")}`).toEqual(
      []
    );
  });

  it("invents no state the server cannot report", () => {
    // The other direction matters too: a word for a state that does not exist
    // is a promise the CLI can never keep, and it hides a renamed member.
    const invented = schemaWords().filter((word) => !migrationStates().includes(word));
    expect(invented, `SCHEMA_WORD names states that do not exist: ${invented.join(", ")}`).toEqual(
      []
    );
  });
});

describe("the schema probe is bounded", () => {
  // `doctor` calls schemaState() on EVERY run, not just --deep, and api() is
  // deliberately unbounded by default so a fleet mutation is never abandoned
  // half-done. Without an explicit timeout here, the command whose entire job
  // is "diagnose why the gateway is unavailable" hangs forever on exactly the
  // gateway it exists to diagnose. Verified empirically against a black-holed
  // address; pinned here so it cannot regress silently.
  it("passes an explicit timeout to the control API", () => {
    const source = readFileSync(join(repo, "bin/passcontrol.mjs"), "utf8");
    expect(source).toMatch(/api\(\s*"GET",\s*"\/system"[\s\S]{0,120}?timeoutMs:\s*\d+/);
  });

  it("still leaves every other control call unbounded", () => {
    const source = readFileSync(join(repo, "bin/passcontrol.mjs"), "utf8");
    const timed = [...source.matchAll(/timeoutMs:\s*\d+/g)];
    expect(timed).toHaveLength(1);
  });
});
