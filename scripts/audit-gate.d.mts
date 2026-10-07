// Types for scripts/audit-gate.mjs, which is plain ESM because CI runs it with
// `node` before any build. tests/audit-gate.test.ts imports it and `tests/`
// ships to the public mirror, so this file is on curate-public.sh's allowlist
// alongside the module it describes. Same arrangement as dev-docker.d.mts.

/** What a package.json + package-lock.json pair installs, without the project's own version. */
export declare function dependencySnapshot(packageJson: string, packageLock: string): string;

export declare function dependenciesChanged(before: string, after: string): boolean;

/** changed: null when the commit before the push could not be read. */
export declare function auditVerdict(input: { auditPassed: boolean; changed: boolean | null }): {
  exitCode: 0 | 1;
  annotation: string | null;
};
