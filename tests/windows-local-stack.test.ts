import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseEnvFile } from "../scripts/dev-docker.mjs";

// Windows self-host used to die at the first step of `passcontrol setup` with
// nothing but `✗ spawn EINVAL`, and then again at `npm run dev:stack` with a WSL
// error naming bash. Three distinct causes, none of them visible from the
// message. These pin all three so they cannot come back quietly.
//
// None of this can be exercised on the CI runners (macOS/Linux), so the
// assertions are on the code that decides, not on Windows behaviour.
//
// This file SHIPS to the public mirror, so it may only read files that ship.
// The matching assertions about scripts/curate-public.sh — which never ships —
// live in scripts/__tests__/public-curation.test.mjs. Putting them here turned
// the mirror's CI red on a file nobody outside can open.

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("spawning npm from the CLI on Windows", () => {
  const cli = read("bin/passcontrol.mjs");

  // Node ≥18.20.2/20.12.2 refuses to spawn a .cmd/.bat without a shell
  // (CVE-2024-27980) and throws EINVAL instead of running it. Every `npm.cmd`
  // the CLI spawns must therefore go through a shell.
  it("routes every npm.cmd spawn through runCommand, which adds the shell", () => {
    const direct = [...cli.matchAll(/spawn\(\s*process\.platform === "win32" \? "npm\.cmd"/g)];
    expect(
      direct,
      "a bare spawn() of npm.cmd throws EINVAL on Windows — call runCommand instead",
    ).toHaveLength(0);

    // And the helper they all funnel through actually sets it.
    expect(cli).toContain("function batchFileShell(command)");
    expect(cli).toMatch(/\.\(cmd\|bat\)\$/i);
    expect(cli).toContain("...batchFileShell(command)");
  });

  // The flip side, and the reason batchFileShell is not just `shell: true`:
  // runCommand also carries `docker compose -f docker/compose.yml` and
  // `supabase start`. Routing those through cmd.exe re-introduces shell quoting
  // to arguments that are safe today as an array — a checkout under
  // `C:\Users\Some Name\` would break.
  it("does not put non-batch commands through a shell", () => {
    const body = cli.slice(cli.indexOf("function batchFileShell"), cli.indexOf("async function runLocalCommand"));
    expect(body).toContain('process.platform === "win32"');
    expect(body).not.toMatch(/shell:\s*true\s*[,}]\s*$/m);
  });
});

describe("the dev server the CLI starts", () => {
  const cli = read("bin/passcontrol.mjs");

  // `npm run dev:docker` was a bash one-liner in single quotes. npm runs scripts
  // through cmd.exe, which does not treat ' as quoting, so bash got `'set` as
  // its whole command — broken on Windows even with Git Bash installed.
  it("is a node script, not a quoted bash one-liner", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["dev:docker"]).toBe("node scripts/dev-docker.mjs");
    expect(pkg.scripts["dev:docker"]).not.toContain("'");
  });

  // The recorded pid is Next's SUPERVISOR, not the HTTP worker it forks, and
  // that is deliberate: stopDashboard takes the whole tree from it — a process
  // group on Unix, `taskkill /PID <pid> /T` on Windows. Stopping is therefore
  // only correct if the pid sits ABOVE everything that needs to die.
  //
  // What must not creep back in is an npm/cmd wrapper above the supervisor.
  // Node refuses to spawn a .cmd without a shell (see above), and the wrapper
  // would add a layer that owns the port through two intermediaries rather than
  // one — so the CLI spawns the launcher script directly with process.execPath.
  it("is spawned directly so the recorded pid is Next's supervisor, not a wrapper", () => {
    const from = cli.indexOf("async function startDashboard");
    const body = cli.slice(from, cli.indexOf("\nasync function ", from + 1));
    expect(body).toContain("dev-docker.mjs");
    expect(body).toContain("process.execPath");
    expect(body).not.toContain('"run", "dev:docker"');
  });

  // …and it must OUTLIVE the CLI that spawned it. `child.unref()` only lets the
  // PARENT exit; on Windows it is `detached` that lets the CHILD survive, and
  // this spawn read `detached: process.platform !== "win32"` — detached only on
  // Unix, because `detached` was reasoned about purely as the thing that makes
  // `kill(-pid)` work in stopDashboard, and Windows gets its tree from
  // `taskkill /T` instead. True about stopping, and it missed the other half.
  //
  // The symptom is worse than a crash, because nothing on screen is wrong:
  // waitForGateway requires the gateway to answer AND the pid to be alive on the
  // same poll, so "✓ dashboard online" was *true* when printed. The CLI then
  // exited and took the server with it. `passcontrol setup` did it too — a
  // first-run self-hoster is handed a URL that stopped working as they read it.
  //
  // Confirmed on a Windows 11 box, 2026-09-13: `passcontrol start` reported
  // online, `passcontrol local-logs` showed the dev server's normal output with
  // no error and no stack trace, and `npm run dev:docker` in the same shell then
  // bound port 3000 cleanly — so nothing was still holding it.
  it("detaches the dashboard on every platform, so it survives the CLI exiting", () => {
    const from = cli.indexOf("async function startDashboard");
    const body = cli.slice(from, cli.indexOf("\nasync function ", from + 1));
    expect(body).toMatch(/detached:\s*true/);
    expect(
      body,
      "detached decides whether the child outlives us, not just how we stop it — it may not be conditional on the platform",
    ).not.toMatch(/detached:\s*process\.platform/);
  });

  // The pairing the fix above depends on: with the child detached, the CLI is no
  // longer its console's parent by the time anyone stops it, so the stop has to
  // address the tree by pid. Both halves must stay present together.
  it("still stops the whole tree by pid, on both platforms", () => {
    const helper = cli.slice(
      cli.indexOf("function windowsTaskkillTree"),
      cli.indexOf("async function stopDashboard"),
    );
    expect(helper).toContain("taskkill.exe");
    expect(helper).toContain('"/T"');

    const from = cli.indexOf("async function stopDashboard");
    const body = cli.slice(from, cli.indexOf("\nasync function ", from + 1));
    expect(body).toMatch(/process\.kill\(-state\.pid/);
  });

  // And the half detaching the child broke, reported from the same Windows box
  // on 2026-09-13: `passcontrol stop --dashboard-only` refused with taskkill's
  // "This process can only be terminated forcefully (with /F option)".
  //
  // `taskkill /T` WITHOUT /F asks politely, and a DETACHED_PROCESS child has
  // nowhere to receive the request — no console, no window — so taskkill exits
  // NON-ZERO and execFileSync turns that into a throw. The catch around it only
  // ever rescued ESRCH, which is a POSIX errno a failing taskkill cannot
  // produce, so it rethrew and abandoned the stop EIGHT LINES ABOVE the /F
  // escalation the function already had. The two-stage design was right; the
  // throw jumped over stage two.
  //
  // So the graceful attempt is best-effort by construction: it reports whether
  // it worked and never throws. Whether the dashboard is down is decided by the
  // port, which is the only fact that settles it.
  it("treats the polite taskkill as best-effort and escalates to /F itself", () => {
    const helper = cli.slice(
      cli.indexOf("function windowsTaskkillTree"),
      cli.indexOf("async function stopDashboard"),
    );
    expect(helper).toContain('"/F"');
    expect(
      helper,
      "a non-zero taskkill must be an answer, not an exception — it is how Windows says 'use /F'",
    ).toMatch(/catch\s*\{[^}]*return false/);

    const from = cli.indexOf("async function stopDashboard");
    const body = cli.slice(from, cli.indexOf("\nasync function ", from + 1));
    expect(
      body,
      "stopDashboard must go through the helper, so taskkill's exit code cannot abort it",
    ).not.toContain("execFileSync");
    expect(body).toMatch(/force:\s*false/);
    expect(body).toMatch(/force:\s*true/);
  });
});

describe("bash resolution for the local stack scripts", () => {
  const runBash = read("scripts/run-bash.mjs");

  it("is what package.json invokes, so a bare `bash` is never trusted", () => {
    const pkg = JSON.parse(read("package.json"));
    for (const name of ["dev:stack", "migrate"]) {
      expect(pkg.scripts[name], name).toContain("scripts/run-bash.mjs");
      expect(pkg.scripts[name], name).not.toMatch(/^bash /);
    }
  });

  // The whole point. On the machine this was written for, `where bash` returns
  // three paths and the first two are not shells:
  //   …\WindowsApps\bash.exe   (Store alias stub)
  //   C:\Windows\System32\bash.exe   (WSL launcher, no distro → execvpe fails)
  //   C:\Program Files\Git\usr\bin\bash.exe   (the real one)
  // An existsSync/`where` check passes on all three.
  it("rejects the two stubs that shadow Git Bash", () => {
    expect(runBash).toContain("\\\\windowsapps\\\\");
    expect(runBash).toContain("\\\\system32\\\\");
  });

  it("verifies a candidate by EXECUTING it, not by checking it exists", () => {
    expect(runBash).toContain("passcontrol_bash_ok");
    const probe = runBash.slice(runBash.indexOf("export function isWorkingBash"));
    expect(probe).toContain('"-c"');
    expect(probe).toMatch(/status === 0/);
  });

  it("looks in both places Git for Windows puts bash", () => {
    expect(runBash).toContain('"Git", "bin", "bash.exe"');
    expect(runBash).toContain('"Git", "usr", "bin", "bash.exe"');
  });

  it("names Git for Windows in the failure, rather than repeating the WSL error", () => {
    expect(runBash).toContain("git-scm.com/download/win");
    expect(runBash).toContain("PASSCONTROL_BASH");
  });

  // dev-stack.sh exits 1 for "Docker is down" and 1 for "the ledger was never
  // vetted", but it also exits non-zero from `set -e` mid-migration. Flattening
  // the child's code to 0 would report a half-applied schema as success.
  it("forwards the script's exit code instead of flattening it", () => {
    expect(runBash).toMatch(/process\.exit\(code \?\? 1\)/);
  });
});

describe(".env.docker loading matches `set -a; . ./.env.docker`", () => {
  it("lets the file win over the ambient environment", () => {
    // Sourcing assigns unconditionally. If the process env won instead, a stale
    // exported VISA_SECRET in the operator's shell would silently outrank the
    // one the stack generated — and visas would verify nowhere.
    const src = readFileSync(path.join(ROOT, "scripts/dev-docker.mjs"), "utf8");
    expect(src).toContain("Object.assign(process.env, parseEnvFile(");
  });

  it("keeps an empty value as empty rather than dropping the key", () => {
    // INSTANCE_SIGNING_KEY_PREV is empty until a real rotation fills it.
    // Dropping the key would let a stale value from the shell take its place.
    expect(parseEnvFile("INSTANCE_SIGNING_KEY_PREV=\n")).toEqual({ INSTANCE_SIGNING_KEY_PREV: "" });
  });

  it("reads the generated file's shape, including base64 with = padding", () => {
    const parsed = parseEnvFile(
      [
        "# Generated by scripts/dev-stack.sh",
        "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
        "CACHE_ENC_KEY=q+X/9dEyq0M4bF0hK1n3vJ8wZr2sT6uY7cA5eG1iL0k=",
        "PASSCONTROL_ISSUER=http://localhost:3000",
        "",
      ].join("\n"),
    );
    expect(parsed.CACHE_ENC_KEY).toBe("q+X/9dEyq0M4bF0hK1n3vJ8wZr2sT6uY7cA5eG1iL0k=");
    expect(parsed.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(Object.keys(parsed)).not.toContain("#");
  });

  it("survives CRLF, which is what a Windows editor leaves behind", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("neither script starts anything merely by being imported", () => {
    for (const rel of ["scripts/dev-docker.mjs", "scripts/run-bash.mjs"]) {
      expect(read(rel), rel).toContain("invokedDirectly");
      expect(read(rel), rel).toContain("path.resolve(fileURLToPath(import.meta.url))");
    }
  });
});
