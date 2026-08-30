-- ============================================================================
-- PassControl — Gemini becomes selectable on the beta application form.
--
-- The gateway gained Gemini as its seventh provider (via Google's
-- OpenAI-compatibility endpoint). `beta_applications.provider` carries the only
-- provider CHECK constraint in the schema — every other provider column,
-- including `provider_credentials.provider` and `agent_logs.provider`, is plain
-- unconstrained `text` validated in application code. So this one table is the
-- only place the database has an opinion, and it still held the six-provider
-- list from 0025.
--
-- The failure this fixes is quiet in the worst direction: `BETA_PROVIDERS` in
-- The application action validates the submission FIRST, so while the two lists
-- disagreed the applicant simply had no Gemini option. Add it to the app list
-- alone and the order reverses — the validator accepts, Postgres rejects the
-- insert, and someone who filled the form in correctly gets a 500. That is why
-- this migration and the lib change are one commit, and why
-- tests/beta-provider-parity.test.ts now pins the two lists plus the form's
-- <option> values together.
--
-- Widening a CHECK is not rewriting history: every row already stored still
-- satisfies the new predicate, because the new list is a strict superset of the
-- old one. No backfill, no data change, no lock beyond the validation scan.
-- ============================================================================

alter table public.beta_applications
  drop constraint if exists beta_applications_provider;

alter table public.beta_applications
  add constraint beta_applications_provider check (
    provider in ('openai', 'anthropic', 'groq', 'mistral', 'together', 'deepseek', 'gemini', 'undecided')
  );
