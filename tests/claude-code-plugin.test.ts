// The Claude Code plugin (F3, 2026-10-10): `/passcontrol`, answered on the user's
// machine by a hook, so it still answers while the gateway refuses every call.
//
// Two boundaries are held here.
//   * License. The plugin is MIT and everything else BSL 1.1 (owner, 2026-10-10).
//     That holds only while the plugin carries no PassControl code: it RUNS the CLI
//     and shows what it prints. A file in it that imported lib/ or cli/ would publish
//     that code under MIT without anyone deciding to.
//   * Behaviour. The hook runs on EVERY slash command Claude Code expands. For any
//     command but ours it must say nothing and get out of the way; for ours it must
//     stop the command before the model is called, and never hand the CLI anything
//     but fixed arguments and a session id held to the gateway's own pattern.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = join(ROOT, "plugins/passcontrol");
const HOOK = join(PLUGIN, "scripts/panel.mjs");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe("the plugin's license boundary", () => {
  it("is MIT, in its own LICENSE, manifest and listing", () => {
    expect(read("plugins/passcontrol/LICENSE")).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Kristiyan Ivanov\n/);
    expect(JSON.parse(read("plugins/passcontrol/.claude-plugin/plugin.json")).license).toBe("MIT");
    const listing = JSON.parse(read(".claude-plugin/marketplace.json"));
    expect(listing.plugins).toEqual([expect.objectContaining({ name: "passcontrol", source: "./plugins/passcontrol", license: "MIT" })]);
  });

  it("is carved out of the BSL's Licensed Work, and the READMEs say so", () => {
    const params = read("LICENSE").split("Terms")[0];
    expect(params).toMatch(/Licensed Work:\s+PassControl, excluding the plugins\/passcontrol\/ directory,\s+which is licensed under the MIT License/);
    // PUBLIC_README.md becomes the mirror's README.md, so only README.md is there.
    for (const readme of ["README.md", "PUBLIC_README.md"].filter((f) => existsSync(join(ROOT, f)))) {
      expect(read(readme), readme).toMatch(/plugins\/passcontrol\/[\s\S]{0,40}which is MIT/);
    }
  });

  it("carries no PassControl code: Node's own modules only", () => {
    for (const file of filesUnder(PLUGIN).filter((f) => /\.[cm]?[jt]sx?$/.test(f))) {
      const source = readFileSync(file, "utf8");
      const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of specifiers) expect(spec, `${relative(ROOT, file)} imports ${spec}`).toMatch(/^node:/);
    }
  });
});

/** The hook as Claude Code runs it, with a stand-in `passcontrol` first on PATH. */
function hook(input: unknown, cli: string | null = 'printf "PassControl · agent 18eddeb0\\n\\n  args: %s\\n" "$*"') {
  const bin = mkdtempSync(join(tmpdir(), "pc-plugin-bin-"));
  if (cli !== null) {
    writeFileSync(join(bin, "passcontrol"), `#!/bin/sh\n${cli}\n`);
    chmodSync(join(bin, "passcontrol"), 0o755);
  }
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
    // Only the stand-in and the system's own tools: never a real install.
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin } as unknown as NodeJS.ProcessEnv,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const ours = { hook_event_name: "UserPromptExpansion", command_name: "passcontrol:passcontrol", command_source: "plugin", session_id: "4345f899-3d2f-4f58-a021-2765be8b85c2" };

describe.skipIf(process.platform === "win32")("the /passcontrol hook", () => {
  it("answers /passcontrol with the CLI's panel and stops it before the model", () => {
    const r = hook(ours);
    expect(r.code).toBe(0);
    const answer = JSON.parse(r.out);
    expect(answer.continue).toBe(false);
    expect(answer.stopReason).toBe("PassControl · agent 18eddeb0\n\n  args: statusline --panel --session 4345f899-3d2f-4f58-a021-2765be8b85c2");
  });

  it("says nothing on any other command, so it runs as usual", () => {
    for (const command_name of ["review", "passcontrol-extra", "other:passcontrol-x", "", undefined]) {
      const r = hook({ ...ours, command_name });
      expect(r.code, String(command_name)).toBe(0);
      expect(r.out, String(command_name)).toBe("");
    }
  });

  it("never passes on a session id the gateway would not accept", () => {
    const answer = JSON.parse(hook({ ...ours, session_id: "x; rm -rf ~ #" }).out);
    expect(answer.stopReason).toMatch(/args: statusline --panel$/);
  });

  it("says how to install the CLI when there is none", () => {
    const answer = JSON.parse(hook(ours, null).out);
    expect(answer).toEqual({ continue: false, stopReason: expect.stringContaining("npm install -g passcontrol") });
    expect(answer.stopReason.split("\n")[0]).toBe("PassControl · CLI not found");
  });

  it("asks for an update when the CLI predates the panel and prints one line", () => {
    const answer = JSON.parse(hook(ours, "echo 'PassControl · $0.42 of $10.00 today'").out);
    expect(answer.stopReason).toMatch(/^PassControl · \$0\.42 of \$10\.00 today\n\n {2}For the full view, update the CLI: {2}npm install -g passcontrol@latest$/);
  });

  it("never gets in the way on input it cannot read", () => {
    const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("is wired to Claude Code's expansion event and nothing else", () => {
    const hooks = JSON.parse(read("plugins/passcontrol/hooks/hooks.json")).hooks;
    expect(Object.keys(hooks)).toEqual(["UserPromptExpansion"]);
    expect(hooks.UserPromptExpansion[0].hooks[0]).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/panel.mjs"] });
  });
});
