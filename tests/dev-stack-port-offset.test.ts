// An install made with `setup --port-offset N` serves its dashboard on 3000 + N, and
// its receipt issuer and Supabase site URL say so. `passcontrol update` reruns
// dev-stack.sh WITHOUT a PORT, and the script used to fall back to 3000: the update
// rewrote the issuer to :3000 (every receipt then fails at `iss`) and the Auth site
// URL to the wrong dashboard. Found on the owner's own 1.5.0 update, 2026-10-11.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(env: Record<string, string>, existingEnvDocker?: string) {
  const { root, sumA } = scratchStack();
  if (existingEnvDocker !== undefined) writeFileSync(path.join(root, ".env.docker"), existingEnvDocker);
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
  const read = (...parts: string[]) => (existsSync(path.join(root, ...parts)) ? readFileSync(path.join(root, ...parts), "utf8") : "");
  const envDocker = read(".env.docker");
  const config = read("supabase", "config.toml");
  return { ...result, output: `${result.stdout}${result.stderr}`, envDocker, config };
}

const hasTools = (() => {
  try {
    execFileSync("bash", ["-c", "command -v openssl"], { stdio: "ignore" });
    return process.platform !== "win32";
  } catch {
    return false;
  }
})();

const line = (file: string, key: string) => file.split("\n").find((l) => l.startsWith(`${key}=`)) ?? null;

describe.skipIf(!hasTools)("dev-stack.sh and the dashboard port of an offset install", () => {
  it("an offset install with no PORT given serves on 3000 + offset, not 3000", () => {
    const { status, output, envDocker, config } = run({ PASSCONTROL_PORT_OFFSET: "100", PORT: "" });
    expect(status, output).toBe(0);
    expect(line(envDocker, "PORT")).toBe("PORT=3100");
    expect(line(envDocker, "PASSCONTROL_ISSUER")).toBe("PASSCONTROL_ISSUER=http://localhost:3100");
    expect(config).toContain("localhost:3100");
    expect(config).not.toMatch(/localhost:3000\b/);
  });

  it("an install an older update broke (PORT=3000 at offset 100) is put right", () => {
    const broken = "PORT=3000\nPASSCONTROL_ISSUER=http://localhost:3000\nVISA_SECRET=keep\n";
    const { status, output, envDocker } = run({ PASSCONTROL_PORT_OFFSET: "100", PORT: "" }, broken);
    expect(status, output).toBe(0);
    expect(line(envDocker, "PORT")).toBe("PORT=3100");
    expect(line(envDocker, "PASSCONTROL_ISSUER")).toBe("PASSCONTROL_ISSUER=http://localhost:3100");
    expect(line(envDocker, "VISA_SECRET")).toBe("VISA_SECRET=keep");
  });

  it("refuses a PORT that is not a port", () => {
    const { status, output } = run({ PASSCONTROL_PORT_OFFSET: "100", PORT: "80; rm -rf x" });
    expect(status).not.toBe(0);
    expect(output).toContain("dashboard port must be a number");
  });

  it("a PORT given on purpose still wins", () => {
    const { envDocker } = run({ PASSCONTROL_PORT_OFFSET: "100", PORT: "3999" }, "PORT=3150\n");
    expect(line(envDocker, "PORT")).toBe("PORT=3999");
    expect(line(envDocker, "PASSCONTROL_ISSUER")).toBe("PASSCONTROL_ISSUER=http://localhost:3999");
  });

  it("a default install is unchanged: issuer on 3000, no PORT line", () => {
    const { envDocker } = run({ PASSCONTROL_PORT_OFFSET: "0", PORT: "" });
    expect(line(envDocker, "PASSCONTROL_ISSUER")).toBe("PASSCONTROL_ISSUER=http://localhost:3000");
    expect(line(envDocker, "PORT")).toBeNull();
  });
});
