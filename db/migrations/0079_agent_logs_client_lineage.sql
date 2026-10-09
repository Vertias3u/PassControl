-- 0079: the session and sub-agent a call DECLARED (sprint Bet A; lib/client-lineage.ts).
--
-- Claude Code and Codex already send, on every request, which working session the
-- call belongs to and which sub-agent made it. The gateway now records what they
-- send: on the signed receipt as `ctx` (with `src: "declared"`), and here.
--
-- DECLARED, NOT AUTHENTICATED. The sidecar holds the only passport key and every
-- sub-agent's call goes through the same local port, so any local process can send
-- any of these values. They identify a call for grouping and for session receipts;
-- nothing may ever authorise on them.
--
-- Additive and nullable. lib/log.ts names these columns only when a call declared
-- lineage, so every other row is byte-identical to before, and code running ahead
-- of this migration still writes its audit rows. Nothing is backfilled: 0006 makes
-- agent_logs append-only, and a historical row has no lineage to give.
--
-- ASSUMES 0078. Confirm the live ledger before applying there:
--   select version from public.schema_migrations order by version desc limit 1;

alter table public.agent_logs
  add column if not exists client_kind text,
  add column if not exists client_session text,
  add column if not exists client_agent text,
  add column if not exists client_parent text;

-- The same rule lib/client-lineage.ts applies before anything reaches here,
-- restated in the database: the service role is the only writer today, but a
-- value outside it can only be a bug, and a CHECK makes that bug loud. A session
-- is required for any of the rest to mean anything, and a parent needs an agent.
alter table public.agent_logs
  drop constraint if exists agent_logs_client_kind_check,
  add constraint agent_logs_client_kind_check
    check (client_kind is null or client_kind in ('claude-code', 'codex', 'sidecar')),
  drop constraint if exists agent_logs_client_values_check,
  add constraint agent_logs_client_values_check
    check (
      (client_session is null or client_session ~ '^[A-Za-z0-9._:-]{1,128}$')
      and (client_agent is null or client_agent ~ '^[A-Za-z0-9._:-]{1,128}$')
      and (client_parent is null or client_parent ~ '^[A-Za-z0-9._:-]{1,128}$')
    ),
  drop constraint if exists agent_logs_client_shape_check,
  add constraint agent_logs_client_shape_check
    check (
      (client_kind is null) = (client_session is null)
      and (client_agent is null or client_session is not null)
      and (client_parent is null or client_agent is not null)
    );

comment on column public.agent_logs.client_kind is
  'Who declared client_session: claude-code, codex, or sidecar (the sidecar''s per-run id). NULL = the call declared no lineage. Declared by the client, never authenticated.';
comment on column public.agent_logs.client_session is
  'The working session the client declared (x-claude-code-session-id, Codex session-id, or x-passcontrol-run). Identifies; never authenticates.';
comment on column public.agent_logs.client_agent is
  'The sub-agent the client declared. NULL = the main agent.';
comment on column public.agent_logs.client_parent is
  'The sub-agent that spawned client_agent, as declared. NULL = spawned by the main agent.';

-- One agent's calls in one session, newest last: what the Sessions view and the
-- seal route read. Partial, so the many rows with no lineage cost nothing.
-- Not CONCURRENTLY: the runner wraps each file in a transaction (see 0056). This
-- takes a brief write lock on agent_logs; at a large row count, create it by hand
-- with CONCURRENTLY first and this statement is a no-op.
create index if not exists agent_logs_client_session_idx
  on public.agent_logs (user_id, agent_id, client_session, created_at)
  where client_session is not null;
