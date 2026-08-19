-- ============================================================================
-- PassControl — credential CREATION is server-only, not merely owner-only.
--
-- ── The defect ──────────────────────────────────────────────────────────────
--
-- Every consequential credential operation in app/dashboard/actions.ts is gated
-- on `requireCredentialMfa` -> `mfaAuthorizedUser` (lib/mfa.ts), which is strict,
-- fails closed, and refuses an aal1 session belonging to an MFA-enrolled account.
-- That gate is correct and stays exactly as it is.
--
-- What was wrong is that the gate was the ONLY thing in the way. `createApiKey`
-- minted with the USER-SCOPED client:
--
--     db.from("api_keys").insert({ user_id, name, key_prefix, key_hash, scope })
--
-- so the legitimate mint already travelled over PostgREST authenticated by the
-- user's own JWT. An attacker holding an aal1 session did not have to find a
-- hidden surface — they replayed the request the dashboard itself makes, minus
-- the Server Action wrapper. RLS accepted it, because RLS asks *who owns this
-- row*, and the answer was "the caller". It cannot ask *did this session clear a
-- second factor*, which is the question the application had started asking.
--
-- Two sinks, both reproduced against a local stack as role `authenticated` with
-- an `aal1` claim, both succeeding before this migration:
--
--   api_keys — attacker picks the plaintext `pc_` token, stores its own SHA-256
--     as key_hash, sets scope='write'. lib/control/auth.ts authenticates purely
--     by hash lookup and has no provenance column (nor should it). The result is
--     a persistent write-scoped control-plane credential that outlives the
--     stolen session and every password reset, until explicitly revoked.
--
--   agents — attacker inserts a row carrying its OWN Ed25519 public key.
--     `status` defaults to 'active' and `expires_at` to null, and
--     findAuthenticatablePassport (lib/auth/passport.ts) gates on exactly those
--     two things, so the passport authenticates, mints visas, and spends the
--     tenant's provider key. Worse than the control-plane key: it costs money.
--
-- ── Why 0011/0012 did not already cover this ────────────────────────────────
--
-- They locked privileged COLUMNS against a PATCH and said so explicitly:
-- 0012 reasoned "an owner can already mint a write-scoped key at will, so
-- flipping an existing key's scope grants nothing new". That was true under the
-- invariant in force when it was written — owner authority. Introducing the MFA
-- gate silently changed the invariant to *owner authority at aal2*, and nothing
-- went back to re-derive 0012's conclusion underneath it. This migration is that
-- re-derivation, not a reversal: a column lock stops tampering with an existing
-- credential, and only a table lock stops minting a new one.
--
-- ── provider_credentials is the sharpest one, and is NOT MFA-specific ────────
--
-- The row holds `vault_secret_id`, and `authenticated` held table-wide INSERT
-- *and* UPDATE on it. 0027's get_provider_key joins
--
--     join vault.decrypted_secrets ds on ds.id = pc.vault_secret_id
--
-- while deriving ownership only from agent -> user -> credential. It never
-- checks that the SECRET belongs to the tenant, because until now nothing could
-- write that column. So any authenticated user — at aal2 exactly as much as at
-- aal1, which is why this is a separate finding and not a step-up bypass — could
-- point their own credential row at another tenant's vault secret and have the
-- gateway decrypt and inject it on their behalf. The only thing standing in the
-- way was not being able to guess a UUID, which is obscurity, not authorization.
-- No TypeScript writes this table at all; every legitimate write already goes
-- through a SECURITY DEFINER RPC. Revoking costs nothing and closes a
-- cross-tenant provider-key read.
--
-- ── TRUNCATE, while we are here ─────────────────────────────────────────────
--
-- The blanket `grant all` in 0007/0008 also handed `authenticated` and `anon`
-- TRUNCATE on all three tables. TRUNCATE is NOT subject to row-level security,
-- so it is a cross-tenant destruction primitive by definition. It is latent
-- rather than live — PostgREST exposes no TRUNCATE verb, and Supabase does not
-- hand end users a direct Postgres connection — but it has no legitimate caller
-- and 0023 already established the house pattern by leaving `agent_access_keys`
-- without it. Same for TRIGGER: `authenticated` has no CREATE on schema public
-- today, so it cannot be used, and it should not be sitting there if that
-- changes.
--
-- ── What deliberately does NOT change ───────────────────────────────────────
--
--   * SELECT stays. The dashboard reads its own credential metadata directly and
--     RLS is the right control for a read.
--   * `update (revoked_at)` on api_keys stays, and the column grants on agents
--     (name, allowed_scopes, budget_*, fallbacks) stay. Note this migration
--     never says `revoke update` on those two tables: in PostgreSQL revoking a
--     table-level privilege revokes the column-level grants of the same type
--     with it, so that one word would silently delete 0011/0012/0018's work and
--     take the ungated revoke path down with it.
--   * Emergency authority REDUCTION stays reachable without a step-up.
--     `revokeApiKey`, `setAgentSuspended` and `setMasterKill` remain on
--     `requireUser()` by design — an operator who cannot complete a step-up must
--     still be able to stop a leaking credential. This migration only removes
--     CREATE and DESTROY, never the stop.
--   * The four provider-key RPCs (store/rotate/set_active/delete) still hold
--     `execute` for `authenticated`. They derive the actor from `auth.uid()` and
--     constrain every write with `and user_id = v_uid`, so an aal1 caller can
--     sabotage its OWN tenant but gains no authority and reaches no other
--     tenant. That is a real step-up bypass of materially lower severity, and
--     closing it means new `*_for_user(p_user_id …)` service-role variants plus
--     four call-site rewrites — deliberately not bundled into a hardening pass.
-- ============================================================================

-- ── api_keys: minting and hard deletion are server-only ─────────────────────
-- DELETE goes too: revocation here is a SOFT delete precisely so `key_prefix`
-- stays referenceable from admin_audit (0008). A hard delete would erase the
-- record a revocation exists to leave behind. Account erasure is unaffected —
-- delete_account_data (0024) is SECURITY DEFINER and removes the profile row,
-- and an FK cascade does not consult these grants.
revoke insert, delete, truncate, trigger on public.api_keys from authenticated, anon;

-- ── agents: passport registration and deletion are server-only ──────────────
revoke insert, delete, truncate, trigger on public.agents from authenticated, anon;

-- ── provider_credentials: no direct write path at all ───────────────────────
-- UPDATE is included here (unlike the two above) because this table has no
-- column-level UPDATE grant to preserve — nothing legitimately PATCHes it.
revoke insert, update, delete, truncate, trigger on public.provider_credentials from authenticated, anon;

comment on table public.api_keys is
  'Control-plane developer keys. Minted server-side only, behind the strict MFA '
  'gate, with the service role; `authenticated` may read its own metadata and '
  'set revoked_at, and nothing else. See 0028.';

comment on table public.agents is
  'Agent passports. Registered server-side only, behind the strict MFA gate, with '
  'the service role; `authenticated` may read its own rows and edit unprivileged '
  'metadata columns. See 0028.';

comment on table public.provider_credentials is
  'References to Vault-held provider keys. No direct client write path: '
  'vault_secret_id is what get_provider_key decrypts against, so a writable row '
  'is a cross-tenant key read. All writes go through SECURITY DEFINER RPCs. See 0028.';
