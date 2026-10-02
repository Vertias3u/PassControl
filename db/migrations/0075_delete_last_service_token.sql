-- ============================================================================
-- PassControl — the only token for a service can be deleted (any-API).
--
-- 0030's delete_provider_key_for_user refuses the credential the gateway is
-- using ("active"), because promoting another row in its place would silently
-- change which upstream account is billed. That refusal is right whenever a
-- sibling row exists. For the ONLY token a workspace holds for a service
-- (`svc:github`, 0074) there is no sibling to promote, so the reason does not
-- apply — and the refusal left an operator no way to remove a GitHub token
-- from Vault short of storing a second one first.
--
-- This lifts the refusal for exactly that case:
--
--   provider is a service (`svc:%`)  AND  no other row exists for it
--
-- Everything else is refused as before: an LLM provider key (whose removal
-- would stop every model call for the workspace — a separate decision), and a
-- service token that still has a sibling (switch first, then delete).
--
-- After the delete, that service's calls answer 409 no_service_credential
-- until a token is stored again. The row is locked while it is decided about,
-- so a concurrent switch or rotate cannot slip between the check and the
-- delete.
-- ============================================================================

create or replace function public.delete_provider_key_for_user(
  p_user_id       uuid,
  p_credential_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret   uuid;
  v_active   boolean;
  v_provider text;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;

  select vault_secret_id, is_active, provider
    into v_secret, v_active, v_provider
    from public.provider_credentials
   where id = p_credential_id and user_id = p_user_id
     for update;

  if v_secret is null then
    raise exception 'credential not found';
  end if;

  -- Refused, not silently reassigned (0027, 0030) — unless this is the only
  -- token for a service, where there is nothing to reassign.
  if v_active and not (
    v_provider like 'svc:%'
    and not exists (
      select 1
        from public.provider_credentials as sibling
       where sibling.user_id = p_user_id
         and sibling.provider = v_provider
         and sibling.id <> p_credential_id
    )
  ) then
    raise exception 'active_credential';
  end if;

  delete from public.provider_credentials
   where id = p_credential_id and user_id = p_user_id;

  -- The row holds only a reference; the encrypted secret outlives it otherwise.
  delete from vault.secrets where id = v_secret;
end;
$$;

revoke all on function public.delete_provider_key_for_user(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_provider_key_for_user(uuid, uuid)
  to service_role;

comment on function public.delete_provider_key_for_user(uuid, uuid) is
  'Delete a tenant''s stored credential and its Vault secret. Service-role only; '
  'p_user_id must come from server-verified session state. Refuses the active '
  'credential, except the only token for a service (svc:*), see 0075.';
