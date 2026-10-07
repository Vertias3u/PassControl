// Push CI ran `npm audit --audit-level=high` as a hard gate, so an advisory
// published after a commit was written turned that commit red: 1.1.0, 1.2.0
// and 1.2.1 all failed on the audit alone, none of them having changed a
// dependency. The gate now fails a push only when the push changed what gets
// installed; an advisory against untouched dependencies is a warning there and
// a daily scheduled audit (.github/workflows/audit.yml) reports it.
//
// What "changed what gets installed" means is the point of these tests: every
// release bumps package.json's and the lockfile root's `version`, so comparing
// the files would make every release commit strict again.
import { describe, expect, it } from "vitest";
import { auditVerdict, dependenciesChanged, dependencySnapshot } from "../scripts/audit-gate.mjs";

function pkg(version: string, deps: Record<string, string> = { jose: "^5.0.0" }, extra: object = {}) {
  return JSON.stringify({ name: "passcontrol", version, dependencies: deps, scripts: { test: "vitest run" }, ...extra });
}

function lock(version: string, packages: Record<string, string> = { "node_modules/jose": "5.9.6" }) {
  const entries: Record<string, object> = { "": { name: "passcontrol", version, dependencies: { jose: "^5.0.0" } } };
  for (const [path, v] of Object.entries(packages)) entries[path] = { version: v, resolved: `https://r/${path}-${v}.tgz` };
  return JSON.stringify({ name: "passcontrol", version, lockfileVersion: 3, packages: entries });
}

const snap = (p: string, l: string) => dependencySnapshot(p, l);

describe("dependenciesChanged", () => {
  it("ignores a release: package.json and lockfile versions bump, nothing installed changes", () => {
    expect(dependenciesChanged(snap(pkg("1.2.0"), lock("1.2.0")), snap(pkg("1.2.1"), lock("1.2.1")))).toBe(false);
  });

  it("ignores scripts and other package.json fields", () => {
    const after = pkg("1.2.0", undefined, { scripts: { test: "vitest run --silent" }, description: "x" });
    expect(dependenciesChanged(snap(pkg("1.2.0"), lock("1.2.0")), snap(after, lock("1.2.0")))).toBe(false);
  });

  it("sees a locked version change", () => {
    const after = lock("1.2.0", { "node_modules/jose": "5.9.7" });
    expect(dependenciesChanged(snap(pkg("1.2.0"), lock("1.2.0")), snap(pkg("1.2.0"), after))).toBe(true);
  });

  it("sees a package added to the lockfile", () => {
    const after = lock("1.2.0", { "node_modules/jose": "5.9.6", "node_modules/left-pad": "1.3.0" });
    expect(dependenciesChanged(snap(pkg("1.2.0"), lock("1.2.0")), snap(pkg("1.2.0"), after))).toBe(true);
  });

  it("sees a range change in package.json", () => {
    const after = pkg("1.2.0", { jose: "^6.0.0" });
    expect(dependenciesChanged(snap(pkg("1.2.0"), lock("1.2.0")), snap(after, lock("1.2.0")))).toBe(true);
  });

  it("sees an overrides change", () => {
    const after = pkg("1.2.0", undefined, { overrides: { sharp: "^0.35.5" } });
    expect(dependenciesChanged(snap(pkg("1.2.0"), lock("1.2.0")), snap(after, lock("1.2.0")))).toBe(true);
  });
});

describe("auditVerdict", () => {
  it("passes a clean audit whatever changed", () => {
    expect(auditVerdict({ auditPassed: true, changed: true }).exitCode).toBe(0);
  });

  it("fails a push that changed dependencies into an advisory", () => {
    const v = auditVerdict({ auditPassed: false, changed: true });
    expect(v.exitCode).toBe(1);
    expect(v.annotation).toMatch(/^::error/);
  });

  it("warns, without failing, on an advisory against dependencies the push did not change", () => {
    const v = auditVerdict({ auditPassed: false, changed: false });
    expect(v.exitCode).toBe(0);
    expect(v.annotation).toMatch(/^::warning/);
  });

  it("stays strict when it cannot tell what the push changed", () => {
    const v = auditVerdict({ auditPassed: false, changed: null });
    expect(v.exitCode).toBe(1);
    expect(v.annotation).toMatch(/^::error/);
  });
});
