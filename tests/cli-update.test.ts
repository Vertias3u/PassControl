// `passcontrol update` — the pure decisions, pinned before any of them touches
// someone's install. The mutating half (npm, git, the stack) is wired in
// bin/passcontrol.mjs and exercised end to end against a scratch mirror.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CLI module, no types
import * as update from "../cli/update.mjs";

const {
  detectInstall,
  isPublicRepoUrl,
  dirtyBlockers,
  stackFromConfig,
  expectedProjectId,
  planUpdate,
  formatPlan,
  migrationBase,
  finishLines,
} = update;

const PUBLIC = "https://github.com/Vertias3u/PassControl.git";

describe("detectInstall", () => {
  const at = (scriptPath: string, platform = "darwin", isSourceCheckout = false) =>
    detectInstall({ scriptPath, platform, isSourceCheckout, version: "1.0.1" });

  it("an npm global install on the default prefix updates itself, pinned to the checked version", () => {
    expect(at("/usr/local/lib/node_modules/passcontrol/bin/passcontrol.mjs")).toMatchObject({
      method: "npm-global",
      prefix: "/usr/local",
      command: ["npm", "install", "-g", "--prefix", "/usr/local", "passcontrol@1.0.1"],
    });
  });

  it("keeps a custom --prefix, so the update lands where the CLI actually lives", () => {
    expect(at("/Users/me/pc-e2e-cli/lib/node_modules/passcontrol/bin/passcontrol.mjs").command).toEqual([
      "npm", "install", "-g", "--prefix", "/Users/me/pc-e2e-cli", "passcontrol@1.0.1",
    ]);
  });

  it("Windows npm global uses npm.cmd and the node_modules parent as prefix", () => {
    const d = at("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\passcontrol\\bin\\passcontrol.mjs", "win32");
    expect(d.method).toBe("npm-global");
    expect(d.command).toEqual([
      "npm.cmd", "install", "-g", "--prefix", "C:\\Users\\me\\AppData\\Roaming\\npm", "passcontrol@1.0.1",
    ]);
  });

  it.each([
    ["/Users/me/.npm/_npx/abc123/node_modules/passcontrol/bin/passcontrol.mjs", "npx", /npx passcontrol@1\.0\.1/],
    ["/Users/me/Library/pnpm/global/5/node_modules/passcontrol/bin/passcontrol.mjs", "pnpm", /pnpm add -g passcontrol@1\.0\.1/],
    ["/Users/me/.config/yarn/global/node_modules/passcontrol/bin/passcontrol.mjs", "yarn", /yarn global add passcontrol@1\.0\.1/],
    ["/Users/me/.bun/install/global/node_modules/passcontrol/bin/passcontrol.mjs", "bun", /bun add -g passcontrol@1\.0\.1/],
    ["/Users/me/.volta/tools/image/packages/passcontrol/lib/node_modules/passcontrol/bin/passcontrol.mjs", "volta", /volta install passcontrol@1\.0\.1/],
  ])("%s → %s: prints the command, runs nothing", (scriptPath, method, manual) => {
    const d = at(scriptPath);
    expect(d.method).toBe(method);
    expect(d.command).toBeNull();
    expect(d.manual).toMatch(manual);
  });

  it("a source checkout never self-updates", () => {
    const d = at("/Users/me/PassControl/bin/passcontrol.mjs", "darwin", true);
    expect(d).toMatchObject({ method: "source", command: null });
    expect(d.manual).toMatch(/git pull/);
  });

  it("an unrecognised location prints the npm command instead of guessing a prefix", () => {
    const d = at("/opt/weird/passcontrol/bin/passcontrol.mjs");
    expect(d).toMatchObject({ method: "unknown", command: null });
    expect(d.manual).toMatch(/npm install -g passcontrol@1\.0\.1/);
  });
});

describe("isPublicRepoUrl", () => {
  it.each([
    PUBLIC,
    "https://github.com/Vertias3u/PassControl",
    "https://github.com/vertias3u/passcontrol.git",
    "git@github.com:Vertias3u/PassControl.git",
    "ssh://git@github.com/Vertias3u/PassControl.git",
    "https://github.com/Vertias3u/PassControl/",
  ])("accepts %s", (url) => expect(isPublicRepoUrl(url, PUBLIC)).toBe(true));

  it.each([
    "https://github.com/Kr1skata3/PassControl-private.git",
    "https://github.com/someone/PassControl.git",
    "https://github.com/Vertias3u/PassControl-fork.git",
    "https://github.com.evil.com/Vertias3u/PassControl.git",
    "",
  ])("refuses %s", (url) => expect(isPublicRepoUrl(url, PUBLIC)).toBe(false));
});

describe("dirtyBlockers", () => {
  it("tolerates the lockfile npm install rewrites (the 0.9.5 mirror's stale root version)", () => {
    expect(dirtyBlockers(" M package-lock.json\n")).toEqual([]);
  });

  it("parses a first line whose leading space was trimmed away (found by the real upgrade run)", () => {
    // A helper that trims git's output turns " M package-lock.json" into
    // "M package-lock.json"; reading columns by position then saw "ackage-lock.json".
    expect(dirtyBlockers("M package-lock.json")).toEqual([]);
    expect(dirtyBlockers("M lib/pricing.ts\n M package-lock.json")).toEqual(["lib/pricing.ts"]);
  });

  it("refuses any other modified tracked file", () => {
    expect(dirtyBlockers(" M package-lock.json\n M lib/pricing.ts\nMM app/page.tsx\n")).toEqual([
      "lib/pricing.ts",
      "app/page.tsx",
    ]);
  });

  it("ignores untracked files (a fast-forward names any real collision itself)", () => {
    expect(dirtyBlockers("?? notes.txt\n")).toEqual([]);
  });

  it("refuses a deleted or renamed tracked file", () => {
    expect(dirtyBlockers(" D README.md\nR  a.ts -> b.ts\n")).toEqual(["README.md", "a.ts -> b.ts"]);
  });
});

describe("stackFromConfig", () => {
  const config = (projectId: string, apiPort: number) =>
    `project_id = "${projectId}"\n\n[api]\nport = ${apiPort}\n\n[db]\nport = ${apiPort + 1}\n`;

  it("recovers the offset setup used from the API port", () => {
    expect(stackFromConfig(config("passcontrol-100", 54421))).toEqual({ projectId: "passcontrol-100", offset: 100 });
    expect(stackFromConfig(config("passcontrol", 54321))).toEqual({ projectId: "passcontrol", offset: 0 });
  });

  it("is null when the stack was never configured or the file is unreadable", () => {
    expect(stackFromConfig("")).toBeNull();
    expect(stackFromConfig('project_id = "x"\n')).toBeNull();
    expect(stackFromConfig(config("x", 50000))).toBeNull();
  });
});

describe("expectedProjectId", () => {
  it("matches dev-stack.sh: the directory name, plus -<offset> when non-zero", () => {
    expect(expectedProjectId("passcontrol", 0)).toBe("passcontrol");
    expect(expectedProjectId("pc-e2e-selfhost", 100)).toBe("pc-e2e-selfhost-100");
  });
});

describe("planUpdate", () => {
  const install = { method: "npm-global", command: ["npm", "install", "-g", "--prefix", "/usr/local", "passcontrol@1.0.1"], manual: "" };
  const base = { current: "1.0.0", latest: "1.0.1", install, app: { status: "none" } };

  it("updates the CLI when npm has a newer version", () => {
    expect(planUpdate(base).cli).toMatchObject({ needed: true, from: "1.0.0", to: "1.0.1" });
  });

  it("does nothing to the CLI when it is current or newer", () => {
    expect(planUpdate({ ...base, latest: "1.0.0" }).cli.needed).toBe(false);
    expect(planUpdate({ ...base, current: "1.1.0" }).cli.needed).toBe(false);
  });

  it("is nothing to do when both are current", () => {
    const plan = planUpdate({ ...base, latest: "1.0.0", app: { status: "current" } });
    expect(plan.nothingToDo).toBe(true);
  });

  it("an app that is behind is work, and names its new migrations", () => {
    const plan = planUpdate({
      ...base,
      latest: "1.0.0",
      app: { status: "behind", behind: 3, from: "aaaaaaa", to: "bbbbbbb", migrations: ["db/migrations/0074_x.sql"] },
    });
    expect(plan.nothingToDo).toBe(false);
    expect(formatPlan(plan).join("\n")).toMatch(/0074_x\.sql/);
  });

  it("an interrupted update (marker left behind) is still work, even at the target commit", () => {
    const plan = planUpdate({ ...base, latest: "1.0.0", app: { status: "current", resume: { from: "aaaaaaa", to: "bbbbbbb" } } });
    expect(plan.nothingToDo).toBe(false);
    expect(formatPlan(plan).join("\n")).toMatch(/interrupted/i);
  });

  it("a refused app is reported with its reason and is not work", () => {
    const plan = planUpdate({ ...base, latest: "1.0.0", app: { status: "refuse", reason: "not a clone of the public repo" } });
    expect(plan.nothingToDo).toBe(true);
    expect(formatPlan(plan).join("\n")).toMatch(/not a clone of the public repo/);
  });

  it("a registry that could not be reached is stated, never read as 'up to date'", () => {
    const plan = planUpdate({ ...base, latest: null });
    expect(plan.cli.needed).toBe(false);
    expect(formatPlan(plan).join("\n")).toMatch(/could not reach/i);
  });
});

// Found by the 1.1.0 → 1.2.0 update on the owner's Mac (2026-10-06): the
// install still carried a marker from a 1.0.0 → 1.1.0 update that had stopped
// before its migrations. The plan named three migrations and applied eight, never
// said it was finishing the earlier update, offered a rollback to the commit from
// before THAT update, and ended without saying the dashboard was not running.
describe("resuming an interrupted update", () => {
  const install = { method: "npm-global", command: ["npm", "install", "-g", "passcontrol@1.2.0"], manual: "" };
  const resume = { from: "473ebf52c626273fb7bdc04298e43feba8c756b5", to: "3733115c25d826db15d8dcebae150b394794859e", wasRunning: false };

  it("counts migrations from where the interrupted update started, when that commit is an ancestor", () => {
    const isAncestor = (rev: string) => rev === resume.from;
    expect(migrationBase({ head: "3733115", resumeFrom: resume.from, isAncestor })).toBe(resume.from);
  });

  it("falls back to HEAD with no marker, or a marker naming a commit this checkout does not contain", () => {
    expect(migrationBase({ head: "3733115", resumeFrom: undefined, isAncestor: () => true })).toBe("3733115");
    expect(migrationBase({ head: "3733115", resumeFrom: resume.from, isAncestor: () => false })).toBe("3733115");
  });

  it("says a behind app is also finishing the earlier update", () => {
    const plan = planUpdate({
      current: "1.2.0",
      latest: "1.2.0",
      install,
      app: { status: "behind", behind: 2, from: "3733115", to: "c6dc457", migrations: ["db/migrations/0071_a.sql"], resume },
    });
    const text = formatPlan(plan).join("\n");
    expect(text).toMatch(/earlier update .*did not finish/i);
    expect(text).toMatch(/473ebf5/);
    expect(text).toMatch(/0071_a\.sql/);
  });
});

describe("finishLines", () => {
  const base = { target: "c6dc457abc", root: "/u/pc", startCommand: "passcontrol start" };

  it("tells you to start the dashboard when the update did not restart it", () => {
    const text = finishLines({ ...base, restarted: false, rollbackTo: "3733115abc" }).map(([, t]: [string, string]) => t).join("\n");
    expect(text).toMatch(/not running/i);
    expect(text).toContain("passcontrol start");
  });

  it("says nothing about starting when it restarted the dashboard itself", () => {
    const text = finishLines({ ...base, restarted: true, rollbackTo: "3733115abc" }).map(([, t]: [string, string]) => t).join("\n");
    expect(text).not.toMatch(/passcontrol start/);
  });

  it("offers a rollback to the commit this run started from, not an older marker's", () => {
    const text = finishLines({ ...base, restarted: true, rollbackTo: "3733115abc" }).map(([, t]: [string, string]) => t).join("\n");
    expect(text).toContain("git -C /u/pc checkout 3733115abc");
    expect(text).toMatch(/migrations only go forward/i);
  });

  it("offers no rollback when this run did not move the code (it only finished an earlier update)", () => {
    const text = finishLines({ ...base, restarted: true, rollbackTo: null }).map(([, t]: [string, string]) => t).join("\n");
    expect(text).not.toMatch(/roll back/i);
  });
});
