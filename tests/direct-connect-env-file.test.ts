// The Setup screen's "save and load" step, run in real shells.
//
// Found 2026-10-04 on live: the env block was shown as a file to save, and the
// owner pasted it straight into zsh instead. That creates shell variables that
// are NOT exported, so the next line, `. ./passcontrol.env`, failed (no file),
// and a curl smoke test still passed because it expands $OPENAI_API_KEY in the
// same shell. An SDK started from that shell would not see the key at all.
//
// So the test is the child process, not the string: whatever the user pastes,
// a program started afterwards must read the Direct Agent Key from its env.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildDirectConnectSetup, DIRECT_KEY_PLACEHOLDER } from "@/lib/direct-connect-config";

const DIRECT_KEY = `pc_agent_${"A".repeat(20)}-${"b".repeat(22)}`;
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs `script` in a fresh folder, then asks a CHILD process for `variable`. */
function childSees(shell: string, script: string, variable: string): { value: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pc-envfile-"));
  dirs.push(dir);
  const probe = `node -e 'process.stdout.write(process.env.${variable} ?? "MISSING")'`;
  // PATH only: a runner (or this machine) with OPENAI_API_KEY set would hand
  // it to the child and the test would pass over the bug.
  const value = execFileSync(shell, ["-c", `${script}\n${probe}`], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return { value, dir };
}

const cases = [
  { provider: "openai", key: DIRECT_KEY, model: "gpt-5-mini" },
  { provider: "anthropic", key: DIRECT_KEY, model: "claude-haiku-4-5" },
  { provider: "openai", key: null, model: "gpt-5-mini" },
  { provider: "anthropic", key: null, model: "claude-haiku-4-5" },
] as const;

describe("Setup's save-and-load paste", () => {
  it.each(SHELLS.map((shell) => [shell]))("reproduces the bug in %s: the env block alone does not reach a child", (shell) => {
    const setup = buildDirectConnectSetup({ origin: "https://p.example", provider: "openai", key: DIRECT_KEY, model: "gpt-5-mini" });
    expect(childSees(shell, setup.envBlock, setup.keyVariable).value).toBe("MISSING");
  });

  for (const shell of SHELLS) {
    it.each(cases.map((c) => [c.provider, c.key ? "key" : "placeholder", c] as const))(
      `${shell}: %s with the %s writes passcontrol.env and exports it to a child`,
      (_provider, _which, c) => {
        const setup = buildDirectConnectSetup({ origin: "https://p.example", provider: c.provider, key: c.key, model: c.model });
        const { value, dir } = childSees(shell, setup.saveAndLoadCommand, setup.keyVariable);
        expect(value).toBe(c.key ?? DIRECT_KEY_PLACEHOLDER);

        // The file is the envBlock, byte for byte, so re-running the load line
        // in a new terminal gives the same configuration.
        expect(readFileSync(join(dir, setup.envFileName), "utf8")).toBe(`${setup.envBlock}\n`);

        const baseVar = setup.family === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
        const modelVar = setup.family === "anthropic" ? "ANTHROPIC_MODEL" : "OPENAI_MODEL";
        expect(childSees(shell, setup.saveAndLoadCommand, baseVar).value).toMatch(/^https:\/\/p\.example\/api\/v1\//u);
        expect(childSees(shell, setup.saveAndLoadCommand, modelVar).value).toBe(c.model);
      }
    );
  }

  // The file holds a bearer credential: only its owner may read it, including
  // when the paste overwrites a file someone already created world-readable.
  it.each(SHELLS.map((shell) => [shell]))("%s: leaves passcontrol.env readable by its owner only", (shell) => {
    const setup = buildDirectConnectSetup({ origin: "https://p.example", provider: "openai", key: DIRECT_KEY, model: "gpt-5-mini" });
    const fresh = childSees(shell, setup.saveAndLoadCommand, setup.keyVariable);
    expect(statSync(join(fresh.dir, setup.envFileName)).mode & 0o777).toBe(0o600);

    const dir = mkdtempSync(join(tmpdir(), "pc-envfile-"));
    dirs.push(dir);
    writeFileSync(join(dir, setup.envFileName), "OLD=1\n", { mode: 0o644 });
    execFileSync(shell, ["-c", setup.saveAndLoadCommand], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv });
    expect(statSync(join(dir, setup.envFileName)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, setup.envFileName), "utf8")).toBe(`${setup.envBlock}\n`);
  });

  it("ends with the same load line a new terminal re-runs", () => {
    const setup = buildDirectConnectSetup({ origin: "https://p.example", provider: "openai", key: null, model: "gpt-5-mini" });
    expect(setup.saveAndLoadCommand.endsWith(`\n${setup.loadCommand}`)).toBe(true);
    // A quoted delimiter: nothing inside the heredoc is expanded while writing.
    expect(setup.saveAndLoadCommand.split("\n")[0]).toMatch(/^cat > passcontrol\.env <<'[A-Z_]+'$/u);
  });
});
