-- 0078: workspace alerts. Where a workspace's Slack, Discord or Telegram alerts go, and
-- which kinds it wants (plans/workspace-alerts.md).
--
-- THE URL IS A CREDENTIAL. An incoming-webhook URL carries its own token, and
-- the Telegram form carries the bot token: anyone holding either can post into
-- the tenant's channel. So it is stored the
-- way a provider key is (0030): in Supabase Vault, written and read only by
-- SECURITY DEFINER functions that only service_role may execute, with the
-- tenant passed explicitly by server code that verified the session. The
-- table holds only what is safe to show: the service, a hint (host plus the
-- last four characters) and the enabled kinds. Nothing gives the URL back to a
-- browser.
--
-- Which URLs are acceptable (Slack, Discord and Telegram's sendMessage, exact
-- host and path shape) is
-- decided in lib/alerts/destination.ts before this is called, and again before
-- every send. The CHECK below only pins the service names.

create table if not exists public.workspace_alerts (
  user_id         uuid primary key references public.users(id) on delete cascade,
  destination     text not null check (destination in ('slack', 'discord', 'telegram')),
  hint            text not null check (char_length(hint) between 1 and 120),
  vault_secret_id uuid not null,
  -- refused: scope / endpoint / policy refusals. budget: out of budget for the
  -- agent or the period. security: passport rotation and break-glass.
  events          text[] not null default array['refused', 'budget', 'security']::text[]
                  check (events <@ array['refused', 'budget', 'security']::text[]),
  updated_at      timestamptz not null default now()
);

comment on table public.workspace_alerts is
  'Where a workspace''s alerts go (0078). The webhook URL itself is in Vault '
  '(vault_secret_id); this row holds only the service, a display hint and the '
  'enabled kinds. Written only through the service-role RPCs below.';

alter table public.workspace_alerts enable row level security;
revoke all on public.workspace_alerts from public, anon, authenticated;
-- The Settings page may read its own row (hint and kinds). Writes go through
-- the server, which applies the credential gate first.
grant select on public.workspace_alerts to authenticated;
grant select, insert, update, delete on public.workspace_alerts to service_role;

drop policy if exists workspace_alerts_select_own on public.workspace_alerts;
create policy workspace_alerts_select_own on public.workspace_alerts
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Create or replace the destination. Replacing rewrites the existing Vault
-- secret in place, so an account never accumulates old webhook URLs.
create or replace function public.set_workspace_alert_destination_for_user(
  p_user_id     uuid,
  p_destination text,
  p_hint        text,
  p_url         text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;
  if p_url is null or char_length(p_url) not between 1 and 512 then
    raise exception 'invalid destination';
  end if;

  select vault_secret_id into v_secret
    from public.workspace_alerts
   where user_id = p_user_id
     for update;

  if v_secret is null then
    v_secret := vault.create_secret(
      p_url,
      'workspace_alert:' || p_user_id::text || ':' || gen_random_uuid()::text,
      'PassControl workspace alert webhook'
    );
    insert into public.workspace_alerts (user_id, destination, hint, vault_secret_id)
    values (p_user_id, p_destination, p_hint, v_secret);
  else
    perform vault.update_secret(v_secret, p_url);
    update public.workspace_alerts
       set destination = p_destination, hint = p_hint, updated_at = now()
     where user_id = p_user_id;
  end if;
end;
$$;

-- The one decrypt path for a webhook URL. Null when the workspace has none.
create or replace function public.get_workspace_alert_url_for_user(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
    from public.workspace_alerts wa
    join vault.decrypted_secrets ds on ds.id = wa.vault_secret_id
   where wa.user_id = p_user_id;
$$;

-- Whatever deletes the row deletes its secret: the RPC below, and also the
-- public.users cascade that account erasure (delete_account_data, 0024) runs.
-- 0024 removes provider-key secrets by hand; a table added later must not rely
-- on someone remembering to extend that function.
create or replace function public.workspace_alerts_drop_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

revoke all on function public.workspace_alerts_drop_secret() from public, anon, authenticated;

drop trigger if exists workspace_alerts_drop_secret on public.workspace_alerts;
create trigger workspace_alerts_drop_secret
  after delete on public.workspace_alerts
  for each row execute function public.workspace_alerts_drop_secret();

create or replace function public.delete_workspace_alert_destination_for_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;
  delete from public.workspace_alerts where user_id = p_user_id;
end;
$$;

revoke all on function public.set_workspace_alert_destination_for_user(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.get_workspace_alert_url_for_user(uuid) from public, anon, authenticated;
revoke all on function public.delete_workspace_alert_destination_for_user(uuid) from public, anon, authenticated;
grant execute on function public.set_workspace_alert_destination_for_user(uuid, text, text, text) to service_role;
grant execute on function public.get_workspace_alert_url_for_user(uuid) to service_role;
grant execute on function public.delete_workspace_alert_destination_for_user(uuid) to service_role;
