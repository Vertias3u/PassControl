-- PassControl — complete tenant-data erasure for a verified account deletion.
--
-- This RPC is service-role-only. The dashboard action supplies p_user_id only
-- after validating the session against GoTrue and clearing the strict MFA gate.
-- Exposing it to `authenticated` would let a caller bypass that gate by calling
-- PostgREST directly.
--
-- agent_logs cannot be deleted directly: migration 0006's append-only trigger
-- rejects a depth-1 DELETE. Deleting public.users uses its declared
-- agent_logs.user_id ON DELETE CASCADE path, which the trigger deliberately
-- permits. The cascade also deletes agents and nulls the historical direct-key
-- references; captured key ids are removed immediately afterwards.
create or replace function public.delete_account_data(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_ids uuid[];
  v_access_key_ids uuid[];
  v_agent_ids uuid[];
  v_control_api_key_ids uuid[];
begin
  if p_user_id is null then
    raise exception 'user id is required';
  end if;

  -- Lock the parent row before capturing child references. New credential and
  -- key inserts need an FK key-share lock and therefore cannot slip between
  -- this inventory and the profile cascade; they resume only to find the
  -- parent gone and fail their transaction.
  perform 1 from public.users where id = p_user_id for update;

  select coalesce(array_agg(a.id), array[]::uuid[])
    into v_agent_ids
    from public.agents as a
   where a.user_id = p_user_id;

  select coalesce(array_agg(k.id), array[]::uuid[])
    into v_control_api_key_ids
    from public.api_keys as k
   where k.user_id = p_user_id;

  select coalesce(array_agg(pc.vault_secret_id), array[]::uuid[])
    into v_secret_ids
    from public.provider_credentials as pc
   where pc.user_id = p_user_id;

  select coalesce(array_agg(k.id), array[]::uuid[])
    into v_access_key_ids
    from public.agent_access_keys as k
   where k.user_id = p_user_id;

  -- The FK cascade removes agent_logs, agents, provider credential references,
  -- audit rows, owner proof, recovery codes and break-glass grants atomically.
  delete from public.users where id = p_user_id;

  -- 0023 keeps these rows after ordinary agent deletion for attribution. Full
  -- account erasure is the explicit exception, after the logs are gone.
  delete from public.agent_access_keys
   where id = any(v_access_key_ids);

  -- provider_credentials stores only references; deleting the profile does not
  -- delete the encrypted Vault rows themselves, so remove the captured secrets.
  delete from vault.secrets
   where id = any(v_secret_ids);

  return jsonb_build_object(
    'agent_ids', to_jsonb(v_agent_ids),
    'control_api_key_ids', to_jsonb(v_control_api_key_ids)
  );
end;
$$;

revoke all on function public.delete_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;

comment on function public.delete_account_data(uuid) is
  'Service-role-only tenant erasure after strict session/MFA confirmation. Deletes '
  'the public profile cascade, orphaned Direct Agent Keys, and captured Vault secrets.';
