// Types for scripts/dev-docker.mjs, which is plain ESM because it is a launcher:
// it runs before any build step, so it cannot be TypeScript. Same arrangement as
// cli/protocols.d.mts. tests/windows-local-stack.test.ts imports parseEnvFile
// from it, and `tests/` ships to the public mirror — so this file is on
// curate-public.sh's allowlist alongside the module it describes, or the mirror
// type-checks against a module with no declaration.

/**
 * Parse a `.env.docker`-shaped file. Matches `set -a; . ./.env.docker`, NOT
 * dotenv: the caller assigns these OVER the existing environment, because shell
 * sourcing assigns unconditionally.
 */
export declare function parseEnvFile(contents: string): Record<string, string>;

/**
 * The values the launcher applies: the file's, plus `PROVIDER_ENDPOINT_MODE=selfhost`
 * when neither the file nor `ambientEnv` names the mode.
 */
export declare function localStackEnv(
  fileValues: Record<string, string>,
  ambientEnv: Record<string, string | undefined>
): Record<string, string>;
