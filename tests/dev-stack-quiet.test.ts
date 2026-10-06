// `passcontrol update` runs scripts/dev-stack.sh for its migrations. On the
// 1.1.0 → 1.2.0 update (2026-10-06) that printed Supabase's whole banner,
// local keys included, 60 "already applied" lines and a page of Postgres
// NOTICEs around the eight migrations that mattered. Under PASSCONTROL_QUIET=1
// the script must print what it applied and little else, and still show the
// full Supabase output when starting it fails.
//
// The script runs for real here, in a scratch copy, against stub `docker` and
// `supabase` commands: what is asserted is what a person would see.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = path.resolve(__dirname, "..");
const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const SUPABASE_STUB = `#!/usr/bin/env bash
case "$1" in
  start)
    echo "Started supabase local development setup."
    echo "Secret | sb_secret_STUBKEY"
    [[ -n "\${STUB_START_FAILS:-}" ]] && { echo "container unhealthy: supabase_db_stub" >&2; exit 1; }
    exit 0 ;;
  status)
    echo "Stopped services: [supabase_studio_stub]" >&2
    echo 'API_URL="http://127.0.0.1:54321"'
    echo 'ANON_KEY="anon"'
    echo 'SERVICE_ROLE_KEY="service"'
    exit 0 ;;
esac
exit 0
`;

// docker exec psql: answers the ledger-state query, the applied-versions query,
// and "applies" anything else. Prints a NOTICE unless client_min_messages is raised.
const DOCKER_STUB = `#!/usr/bin/env bash
case "$1" in
  info) exit 0 ;;
  ps) echo "supabase_db_stub"; exit 0 ;;
  compose) echo " Network stub_default Creating" >&2; exit 0 ;;
  exec)
    args="$*"
    if [[ "$args" != *"client-min-messages=warning"* ]]; then echo "NOTICE:  relation already exists, skipping" >&2; fi
    if [[ "$args" == *"select version || '|'"* ]]; then echo "0001_a.sql|$STUB_SUM_A"; exit 0; fi
    input="$(cat 2>/dev/null || true)"
    if [[ "$input" == *"_pc_ledger_state"* ]]; then echo "t|1"; fi
    exit 0 ;;
esac
exit 0
`;

function scratchStack() {
  const root = mkdtempSync(path.join(tmpdir(), "pc-devstack-"));
  scratch.push(root);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "db", "migrations"), { recursive: true });
  mkdirSync(path.join(root, "bin"));
  copyFileSync(path.join(repo, "scripts", "dev-stack.sh"), path.join(root, "scripts", "dev-stack.sh"));
  copyFileSync(
    path.join(repo, "scripts", "write-local-supabase-config.mjs"),
    path.join(root, "scripts", "write-local-supabase-config.mjs"),
  );
  writeFileSync(path.join(root, "db", "migrations", "0001_a.sql"), "select 1;\n");
  writeFileSync(path.join(root, "db", "migrations", "0002_b.sql"), "select 2;\n");
  writeFileSync(path.join(root, "bin", "supabase"), SUPABASE_STUB);
  writeFileSync(path.join(root, "bin", "docker"), DOCKER_STUB);
  chmodSync(path.join(root, "bin", "supabase"), 0o755);
  chmodSync(path.join(root, "bin", "docker"), 0o755);
  const sumA = createHash("sha256").update(readFileSync(path.join(root, "db", "migrations", "0001_a.sql"))).digest("hex");
  return { root, sumA };
}

function run(env: Record<string, string>) {
  const { root, sumA } = scratchStack();
  const result = spawnSync("bash", [path.join(root, "scripts", "dev-stack.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
      STUB_SUM_A: sumA,
      PASSCONTROL_SKIP_SEED: "1",
      PASSCONTROL_VIA_CLI: "1",
      ...env,
    },
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

const hasTools = (() => {
  try {
    execFileSync("bash", ["-c", "command -v openssl"], { stdio: "ignore" });
    return process.platform !== "win32";
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTools)("dev-stack.sh under PASSCONTROL_QUIET=1", () => {
  it("lists only the migration it applied, with a count of the rest", () => {
    const { status, output } = run({ PASSCONTROL_QUIET: "1" });
    expect(status, output).toBe(0);
    expect(output).toContain("+ 0002_b.sql");
    expect(output).not.toContain("= 0001_a.sql");
    expect(output).toMatch(/1 already applied/);
  });

  it("keeps Supabase's banner, its keys, compose progress and Postgres NOTICEs out", () => {
    const { output } = run({ PASSCONTROL_QUIET: "1" });
    expect(output).not.toContain("sb_secret_STUBKEY");
    expect(output).not.toContain("Stopped services");
    expect(output).not.toContain("Network stub_default");
    expect(output).not.toContain("NOTICE");
    expect(output).not.toContain("Local stack is up");
  });

  it("still shows everything Supabase said when it fails to start", () => {
    const { status, output } = run({ PASSCONTROL_QUIET: "1", STUB_START_FAILS: "1" });
    expect(status).not.toBe(0);
    expect(output).toContain("container unhealthy: supabase_db_stub");
  });
});

describe.skipIf(!hasTools)("dev-stack.sh run by hand (not quiet)", () => {
  it("still lists every migration and the closing summary, without NOTICEs", () => {
    const { status, output } = run({});
    expect(status, output).toBe(0);
    expect(output).toContain("= 0001_a.sql (already applied)");
    expect(output).toContain("+ 0002_b.sql");
    expect(output).toContain("Local stack is up");
    expect(output).not.toContain("NOTICE");
  });
});
