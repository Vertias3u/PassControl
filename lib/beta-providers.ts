/**
 * The beta signup provider list, kept in its own module with NO Node imports.
 *
 * `lib/beta-launch.ts` imports `node:crypto`, so a "use client" component that
 * reads the list from there drags crypto into the browser bundle and the
 * production build fails with `UnhandledSchemeError: node:crypto`. It compiles
 * and tests fine — only `next build` says anything. So the data lives here and
 * beta-launch re-exports it for its server-side callers.
 *
 * There is still a second copy of this list, deliberately: the
 * `beta_applications_provider` CHECK constraint in
 * db/migrations/0039_beta_applications_gemini.sql. A database is entitled to
 * enforce its own domain, and tests/beta-provider-parity.test.ts pins the two
 * together — the app validator runs first, so if they drift the applicant is
 * either quietly offered nothing (harmless) or handed a 500 on a correctly
 * filled form (not).
 */
export const BETA_PROVIDERS = [
  "openai",
  "anthropic",
  "groq",
  "mistral",
  "together",
  "deepseek",
  "gemini",
  "undecided",
] as const;

export type BetaProvider = (typeof BETA_PROVIDERS)[number];

/**
 * Display labels for the signup form. A total Record, so adding a provider
 * without a label is a compile error rather than a blank <option> nobody spots.
 */
export const BETA_PROVIDER_LABELS: Record<BetaProvider, string> = {
  undecided: "Not decided",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  mistral: "Mistral",
  together: "Together",
  deepseek: "DeepSeek",
  gemini: "Google Gemini",
};
