-- The key and the address must name the same credential.
--
-- ── The defect this closes (S-01 in daybreakblue-1) ────────────────────────
--
-- The proxy resolved a credential's ENDPOINT and its SECRET through two
-- independent reads, cached them under two independent keys with two independent
-- lifetimes, and had nothing in either value naming which credential it came
-- from. So the two could disagree, and when they did the gateway sent secret B
-- to endpoint A — a real provider key delivered to a server that was never
-- selected to receive it. Reproduced at handler level: an activation landing
-- between the two reads, and separately a stale cache fill landing after a purge.
--
-- ── Why the obvious fix is the wrong one ──────────────────────────────────
--
-- "Return the secret and the endpoint from one row" is the first idea and it
-- breaks two properties that are load-bearing:
--
--   * The endpoint must be known BEFORE `reconcile`, because that closure prices
--     the call and a custom endpoint is UNPRICED (0050 fixed a temporal-dead-zone
--     bug here already).
--   * The secret must be resolved after the budget reserve, because CLAUDE.md's
--     check order is verify -> kill/suspend -> scope -> budget reserve ->
--     resolve key -> inject. Decrypting earlier means decrypting for calls that
--     were about to be refused.
--
-- CORRECTION, 2026-09-10: this comment first said the endpoint must be known
-- "before the budget reserve". It is not, and never was: `openHold` is step 5 of
-- the proxy and `resolveEndpoint` runs after it. The binding argument below is
-- unaffected — the two reads are still separated in time, which is the only
-- premise it rests on — but the stated reason named the wrong boundary. That the
-- endpoint is NOT known at reserve time is exactly what made the reserve price a
-- custom endpoint from the built-in retail table (S3-03).
--
-- So the two reads have to stay separated in TIME. What they must stop being is
-- separated in IDENTITY.
--
-- ── What this does ────────────────────────────────────────────────────────
--
-- The endpoint read now also returns the credential's id, and this function
-- fetches the secret FOR THAT ID — refusing if that credential is no longer the
-- one the agent's provider selection resolves to. A rotation, an activation or a
-- deletion landing between the two reads makes this return no row, and the proxy
-- refuses the call rather than pairing a new secret with an old address. Nothing
-- is guessed and nothing is silently substituted: fail closed, exactly as the
-- unknown-endpoint case already does.
--
-- The selection rule below is copied from `get_provider_key` character for
-- character. Which credential is chosen must not depend on the query plan, and
-- must not differ between the function that reads the address and the function
-- that decrypts the secret. Change one, change both.
--
-- ── The selector disagreement it also closes, which nobody had noticed ─────
--
-- The old pair did not even agree on which credential they were about.
-- `get_provider_key` picks `order by pc.is_active desc, pc.created_at asc` — the
-- chosen credential, else the legacy oldest-first fallback. The endpoint read
-- filtered `is_active = true` and nothing else. For a tenant on the legacy path,
-- with no credential ever marked active, the key came from the oldest row while
-- the endpoint read found NO row — which reads as "no custom endpoint" and sends
-- that key to the provider's own host. The caller now uses the same ordering, and
-- this function re-checks it, so the two cannot drift apart again.
--
-- ── What this does NOT change ─────────────────────────────────────────────
--
-- `get_provider_key` is untouched and still exists. This is the second decrypt
-- path and is held to identical rules: SECURITY DEFINER, empty search_path,
-- ownership re-derived through agent -> user -> credential rather than trusted
-- from an argument, execute revoked from everyone but service_role. A caller
-- supplying another tenant's credential id gets no row — the id is a selector
-- inside an ownership join, never an authorization token.

create or replace function public.get_provider_key_for_credential(
  p_agent_id uuid,
  p_provider text,
  p_credential_id uuid
)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_key text;
begin
  select ds.decrypted_secret
    into v_key
  from public.agents a
  join public.provider_credentials pc
    on pc.user_id = a.user_id and pc.provider = p_provider
  join vault.decrypted_secrets ds
    on ds.id = pc.vault_secret_id
  where a.id = p_agent_id
    and a.status = 'active'
    -- The caller resolved this id from the same ordering, one step earlier. If
    -- it is no longer the selected credential, this row is not returned and the
    -- caller refuses. That refusal IS the fix.
    and pc.id = p_credential_id
    and pc.id = (
      select pc2.id
      from public.provider_credentials pc2
      where pc2.user_id = a.user_id and pc2.provider = p_provider
      order by pc2.is_active desc, pc2.created_at asc
      limit 1
    );

  return v_key;
end;
$$;

comment on function public.get_provider_key_for_credential(uuid, text, uuid) is
  'Decrypts the secret of ONE named credential, and only while that credential is '
  'still the agent''s selected one for this provider. See 0069: resolving the key '
  'and the endpoint independently let the gateway send one credential''s key to '
  'another credential''s address.';

revoke all on function public.get_provider_key_for_credential(uuid, text, uuid) from public;
revoke all on function public.get_provider_key_for_credential(uuid, text, uuid) from anon;
revoke all on function public.get_provider_key_for_credential(uuid, text, uuid) from authenticated;
grant execute on function public.get_provider_key_for_credential(uuid, text, uuid) to service_role;
