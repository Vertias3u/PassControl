-- ============================================================================
-- PassControl — post-apply check for 0033 (the operator profile).
--
-- READ-ONLY. Safe on a live database: it opens no transaction, writes nothing,
-- and touches no tenant data. Unlike the invariant suites next door it is meant
-- to be run against production right after a migration, which is why it reports
-- rather than raises — one screen you can read, instead of an exception that
-- stops at the first problem and hides the rest.
--
-- Run with the SAME DATABASE_URL you migrated with:
--   psql -q "$DATABASE_URL" -f db/tests/verify_0033_applied.sql
--
-- The first row identifies WHICH project you are on, which matters because two
-- hosted projects exist and a runbook once handed the owner the wrong string:
-- through the Supavisor pooler `current_user` reads `postgres.<project-ref>`,
-- and only the live project holds a real agent_logs history.
--
-- Every other row should read "ok" or a full count. Specifically:
--   avatars bucket MISSING  — the storage insert did not take (the pooler user
--                             may not own the `storage` schema). Avatar uploads
--                             will fail with "The image could not be stored",
--                             which reads like a bug rather than a missing
--                             bucket. Create it in the dashboard: private, 512
--                             KB limit, image/png + image/webp.
--   avatar_key guard MISSING — an older copy of 0033 was applied, before the
--                             fix. The public page will render broken images.
--   users STILL WRITABLE    — 0032 did not take on this project.
-- ============================================================================

\pset pager off
select current_user as connection_user,
       (select count(*) from public.agent_logs) as agent_log_rows;

select 'avatars bucket' as check,
       coalesce((select case when public then 'PUBLIC — WRONG' else 'private, ok' end
                   from storage.buckets where id='avatars'), 'MISSING') as result
union all
select 'profile columns',
       (select count(*)::text || ' of 10'
          from information_schema.columns
         where table_schema='public' and table_name='users'
           and column_name in ('username','display_name','bio','website_url','company',
                               'timezone','profile_public','avatar_path','avatar_key','updated_at'))
union all
select 'agents.published + public_label',
       (select count(*)::text || ' of 2'
          from information_schema.columns
         where table_schema='public' and table_name='agents'
           and column_name in ('published','public_label'))
union all
select 'the 3 public RPCs exist',
       (select count(*)::text || ' of 3' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname in
               ('public_operator_profile','public_operator_agents','avatar_object_path'))
union all
select 'RPCs hidden from anon/authenticated',
       case when exists (
         select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public'
            and p.proname in ('public_operator_profile','public_operator_agents','avatar_object_path')
            and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       ) then 'LEAKED — anon or authenticated can execute' else 'ok' end
union all
select 'avatar_key guard (the fix)',
       case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='public_operator_profile')
                 like '%case when u.avatar_path is not null%'
            then 'ok' else 'MISSING — public page will render broken images' end
union all
select 'retirement trigger armed',
       case when exists (select 1 from pg_trigger
                          where tgname='users_reject_retired_username' and not tgisinternal)
            then 'ok' else 'MISSING — a released handle is reclaimable' end
union all
select 'handle lock column (0034)',
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='users'
                            and column_name='handle_locked_at')
            then 'ok' else 'MISSING — apply 0034 before deploying' end
union all
select 'handle lock trigger armed (0034)',
       case when exists (select 1 from pg_trigger
                          where tgname='users_reject_locked_username' and not tgisinternal)
            then 'ok' else 'MISSING — a published handle can still be moved' end
union all
select 'users writable by authenticated (0032)',
       case when has_table_privilege('authenticated','public.users','UPDATE')
            then 'STILL WRITABLE — 0032 did not take' else 'locked, ok' end;
