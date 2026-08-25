// The guard that explains a missing migration manifest must be able to fire.
//
// next.config.mjs hashes db/migrations at build time to freeze the manifest
// System Health compares the ledger against. It carries a deliberate guard:
//
//   if (isProd && migrationEntries.length === 0) throw new Error(
//     "No migrations found in db/migrations — ... this usually means
//      .vercelignore excluded them from the upload.")
//
// That message is the whole value of the guard, and it could not be reached in
// the scenario its own comment describes. `.vercelignore` excluding the files
// leaves the directory ABSENT from the upload, not empty — so `readdirSync`
// threw `ENOENT ... scandir '.../db/migrations'` several lines earlier and the
// build died on a raw stack trace. On the Node target `next start` loads the
// config too, so the same throw takes the running server down.
//
// Executed rather than asserted as text: the config is copied into a scratch
// root with no db/migrations and imported for real, because "does this throw
// the right error" is exactly the kind of claim a source grep gets wrong.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = process.cwd();
const roots: string[] = [];

/** Load next.config.mjs with `repoRoot` pointing at a scratch directory. */
function loadConfig(
  { migrations, nodeEnv }: { migrations: string[] | null; nodeEnv: "production" | "development" }
): { ok: true } | { ok: false; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "pc-manifest-"));
  roots.push(root);
  copyFileSync(join(repo, "next.config.mjs"), join(root, "next.config.mjs"));
  if (migrations) {
    mkdirSync(join(root, "db", "migrations"), { recursive: true });
    for (const name of migrations) {
      writeFileSync(join(root, "db", "migrations", name), `-- ${name}\n`);
    }
  }
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(join(root, "next.config.mjs"))})`], {
      env: { ...process.env, NODE_ENV: nodeEnv },
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, stderr: String((error as { stderr?: Buffer }).stderr ?? "") };
  }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("the production migration-manifest guard", () => {
  it("explains an ABSENT db/migrations instead of dying on scandir", () => {
    const result = loadConfig({ migrations: null, nodeEnv: "production" });
    expect(result.ok, "the build accepted a missing manifest").toBe(false);
    if (result.ok) return;
    expect(result.stderr).toContain("No migrations found in db/migrations");
    expect(result.stderr).not.toMatch(/ENOENT|scandir/);
  });

  it("still explains an EMPTY db/migrations", () => {
    const result = loadConfig({ migrations: [], nodeEnv: "production" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stderr).toContain("No migrations found in db/migrations");
  });

  it("builds when the migrations are there", () => {
    expect(loadConfig({ migrations: ["0001_init.sql"], nodeEnv: "production" }).ok).toBe(true);
  });

  it("does not block a development load, which has no manifest to ship", () => {
    expect(loadConfig({ migrations: null, nodeEnv: "development" }).ok).toBe(true);
  });
});
