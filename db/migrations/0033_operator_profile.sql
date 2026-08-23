-- ============================================================================
-- PassControl — the operator profile, and the public /@handle page.
--
-- 0032 closed the write surface on public.users; this hangs an identity off it.
-- Read that header first — the reason every write here goes through the service
-- role is stated there and not repeated.
--
-- ── Two independent opt-ins, and they must stay independent ─────────────────
--
--     users.profile_public   → this operator has a public /@handle page at all
--     agents.published       → this specific agent is listed on it
--
-- Publishing the profile publishes NO agent. That is the same shape as
-- agent_owners (0017), where declaring an owner and publishing it are separate
-- acts, and it exists for the same reason: a single switch with two effects is a
-- switch people flip without knowing the second effect.
--
-- ── What must never cross the boundary ──────────────────────────────────────
--
-- The RPCs below fix their readable columns in the database, following 0015. The
-- deny-list, stated so a later edit has to argue with it:
--
--   users.id / agents.user_id  — 0015: "the tenant is never named on a public
--                                surface." A tenant uuid on a public page is
--                                also a correlation handle into dashboard URLs.
--   users.email, users.plan    — obvious.
--   users.timezone             — a coarse location signal. It exists so the
--                                operator's OWN dashboard can format times.
--   users.avatar_path          — the private storage key. The public surface
--                                carries avatar_key instead; see below.
--   agents.id                  — internal, and 0015 already refuses it.
--   budgets / spend / allowed_scopes / policy / fallbacks — operational.
--   agent_owners.verification_token — a secret. Note that lib/owner/manage.ts
--                                has a const named PUBLIC_COLS which includes
--                                it; that name is a trap, do not reuse it.
--   agent_owners.kind          — omitted deliberately. 0017 is emphatic that a
--                                verified label is keyed off `tier` (what was
--                                proven), never `kind` (what was attempted).
--                                A field that cannot be read cannot be misread.
--   anything from agent_logs   — see the next paragraph.
--
-- ── One doctrine question, answered rather than dodged ──────────────────────
--
-- The obvious thing to put on a public profile is a receipt count: "318 signed
-- receipts" reads as proof of a working fleet. It is not added here. 0015's
-- deny-list names agent_logs explicitly, because call volume is operational and
-- a public volume figure is business intelligence about the operator. 0017 set
-- the precedent that amending that doctrine is done in a migration header with
-- an argument, not slipped in as a count(*). `published_agent_count` counts rows
-- the operator explicitly published, which is a different thing: it is a count
-- of assertions they chose to make, not a measure of what they do.
--
-- ── agents.name is not safe to publish ──────────────────────────────────────
--
-- 0015 already refuses `name` on the public passport surface, and the reason
-- generalises: internal agent names are customer-identifying. `acme-prod-billing`
-- published under a vendor's handle is a customer list. So publishing an agent
-- requires a separate `public_label`, and the UI pre-fills it from `name` behind
-- an explicit warning rather than publishing `name` silently.
-- ============================================================================

-- ── 1. Profile columns ───────────────────────────────────────────────────────

alter table public.users
  add column if not exists username       text,
  add column if not exists display_name   text,
  add column if not exists bio            text,
  add column if not exists website_url    text,
  add column if not exists company        text,
  add column if not exists timezone       text,
  add column if not exists profile_public boolean not null default false,
  add column if not exists avatar_path    text,
  add column if not exists avatar_key     text,
  add column if not exists updated_at     timestamptz not null default now();

-- Handles are lowercase at rest, enforced here rather than by a case-insensitive
-- index. That choice matters: with a citext column or a lower() index, `Alice`
-- and `alice` would be one handle for uniqueness but two different strings
-- everywhere else in the codebase. Making uppercase unstorable means the plain
-- unique index below IS case-insensitive uniqueness, with no extension.
--
-- No hyphen: reserved for a future namespace separator, and visually confusable
-- with an underscore in several of the faces this renders in. No leading or
-- trailing underscore. 3–30 characters.
alter table public.users
  drop constraint if exists users_username_shape;
alter table public.users
  add constraint users_username_shape
    check (username is null or username ~ '^[a-z0-9][a-z0-9_]{1,28}[a-z0-9]$');

-- Bounds on every free-text field. These are the first strings this product ever
-- renders on a page a stranger reads, and an unbounded bio is both a layout
-- problem and a storage one.
alter table public.users
  drop constraint if exists users_display_name_len,
  drop constraint if exists users_bio_len,
  drop constraint if exists users_company_len,
  drop constraint if exists users_website_url_len,
  drop constraint if exists users_website_url_scheme;
alter table public.users
  add constraint users_display_name_len   check (display_name is null or length(display_name) <= 60),
  add constraint users_bio_len            check (bio is null or length(bio) <= 280),
  add constraint users_company_len        check (company is null or length(company) <= 80),
  add constraint users_website_url_len    check (website_url is null or length(website_url) <= 200),
  -- The backstop for the one genuinely new injection surface this feature adds:
  -- an operator-controlled href rendered on a public page. `javascript:` and
  -- `data:` URLs are rejected in lib/profile/url.ts before the write; this makes
  -- a bypass unstorable. Same "a mistake has to be made twice" discipline 0015
  -- applies to its column list.
  add constraint users_website_url_scheme check (website_url is null or website_url ~ '^https?://');

-- NULLs are distinct in a Postgres unique index, so every operator without a
-- handle coexists happily.
create unique index if not exists users_username_key
  on public.users (username) where username is not null;
create unique index if not exists users_avatar_key_key
  on public.users (avatar_key) where avatar_key is not null;

comment on column public.users.profile_public is
  'Operator opt-in to a public /@handle page. Publishing the profile does NOT '
  'publish any agent — agents.published is a second, independent opt-in.';

comment on column public.users.timezone is
  'The operator''s own display preference. PRIVATE: a coarse location signal, '
  'deliberately absent from public_operator_profile().';

comment on column public.users.avatar_path is
  'Object key inside the private `avatars` bucket. PRIVATE — the public surface '
  'carries avatar_key, an unguessable capability token, so that neither the '
  'tenant uuid nor the storage layout is ever named publicly.';

comment on column public.users.avatar_key is
  'Unguessable public handle for the avatar, used as /avatars/<key>. Rotated on '
  'every upload AND whenever profile_public goes false, which is what revokes '
  'previously shared URLs. Rotation is a one-column update; the stored object is '
  'untouched.';

-- ── 2. Retired handles ───────────────────────────────────────────────────────
--
-- A released handle is never re-registrable. If it were, an old /@handle link —
-- in a README, a receipt, a blog post — would silently start resolving to a
-- different operator. On an identity product that is an impersonation vector,
-- not a tidiness question, so a freed handle is retired rather than recycled.
--
-- This is why there is no "handle change cooldown": a cooldown delays the
-- collision, retirement removes it.

create table if not exists public.retired_usernames (
  username    text primary key,
  retired_at  timestamptz not null default now()
);

comment on table public.retired_usernames is
  'Handles that were once claimed and released. Never reissued: an old /@handle '
  'link must 404 rather than resolve to somebody else.';

-- Same posture as the migration ledger in 0019: RLS on with no policy at all, so
-- neither PostgREST role can see a row even if a future `grant all on all tables
-- in schema public` hands the grants back. service_role bypasses RLS.
alter table public.retired_usernames enable row level security;
revoke all on public.retired_usernames from authenticated, anon;
-- Explicit rather than assumed, for the reason 0007 exists: default privileges do
-- not reproduce on a from-scratch apply.
grant select, insert on public.retired_usernames to service_role;

-- The table alone retires nothing. Without this trigger, "retired" would be a
-- claim enforced only by lib/profile/handle.ts — one forgotten check away from
-- silently handing an old /@handle link to a different operator, which is the
-- exact impersonation this table exists to prevent. So the rule lives in the
-- database too: "a mistake has to be made twice", the same discipline 0015
-- applies to its column list.
--
-- It raises unique_violation on purpose. The application already maps that code
-- to "that handle is taken", so a retired handle and a taken handle are
-- indistinguishable to the caller — no oracle for which handles were once used.
create or replace function public.reject_retired_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.username is not null
     and (tg_op = 'INSERT' or new.username is distinct from old.username)
     and exists (select 1 from public.retired_usernames r where r.username = new.username) then
    raise exception 'handle % is retired', new.username using errcode = 'unique_violation';
  end if;
  return new;
end
$$;

revoke all on function public.reject_retired_username() from public, anon, authenticated;

drop trigger if exists users_reject_retired_username on public.users;
create trigger users_reject_retired_username
  before insert or update of username on public.users
  for each row execute function public.reject_retired_username();

-- ── 3. Per-agent publish opt-in ──────────────────────────────────────────────
--
-- NOTE what this does NOT do: it does not issue `revoke update on public.agents`.
-- 0011 replaced the table-wide grant with a column list and 0018 later appended
-- `fallbacks` to it; a fresh revoke-and-regrant here would silently drop any
-- column omitted from the new list. Column grants are additive and explicit, so
-- simply never granting these two leaves them server-write-only by construction.
-- db/tests/rls_invariants.sql asserts both directions.

alter table public.agents
  add column if not exists published    boolean not null default false,
  add column if not exists public_label text;

alter table public.agents
  drop constraint if exists agents_public_label_len,
  drop constraint if exists agents_published_needs_label;
alter table public.agents
  add constraint agents_public_label_len
    check (public_label is null or length(public_label) <= 60),
  -- Publishing without a label is a representable state that renders as a blank
  -- row on a stranger's screen, and the obvious "fix" — falling back to
  -- agents.name — is precisely what must never happen here. So the label is
  -- required at the moment of publishing, and the RPC filters for it as well.
  add constraint agents_published_needs_label
    check (not published or public_label is not null);

comment on column public.agents.published is
  'Operator opt-in to listing this agent on their public /@handle page. Requires '
  'users.profile_public as well — both opt-ins must hold. Server-write only: '
  'publishing is a disclosure act and runs behind mfaAuthorizedUser, which RLS '
  'cannot express.';

comment on column public.agents.public_label is
  'The name shown publicly. Separate from `name` because internal agent names are '
  'customer-identifying — 0015 refuses `name` on the public passport surface for '
  'the same reason.';

create index if not exists agents_published_idx
  on public.agents (user_id) where published;

-- ── 4. The public read surface ───────────────────────────────────────────────
--
-- Three functions, following 0015 exactly rather than inventing a second
-- pattern: SECURITY DEFINER with an empty search_path, an explicit RETURNS TABLE
-- that fixes the readable columns IN THE DATABASE (so a later edit to the page
-- cannot widen them), and EXECUTE granted to service_role only.
--
-- anon and authenticated cannot call these at all. As in 0015, "public" happens
-- in the web tier: a server component calls them with the service client. The
-- surface anon sees through PostgREST is unchanged by this migration.
--
-- SECURITY DEFINER is required because public.users and public.agents are both
-- RLS'd to the tenant and the caller here is nobody in particular.
--
-- Handles are lowercased on the way in as well as on the way out. The
-- application normalises in lib/profile/handle.ts; doing it here too is 0015's
-- "a mistake has to be made twice" rule.

create or replace function public.public_operator_profile(p_handle text)
returns table (
  username              text,
  display_name          text,
  bio                   text,
  website_url           text,
  company               text,
  avatar_key            text,
  member_since          timestamptz,
  owner_subject         text,
  owner_tier            text,
  owner_verified_at     timestamptz,
  published_agent_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.username,
    u.display_name,
    u.bio,
    u.website_url,
    u.company,
    -- The key ONLY when there are bytes behind it. avatar_object_path() below
    -- filters on `avatar_path is not null`, so a key without a stored object
    -- resolves to 404 — and the public page cannot guard that itself, because
    -- avatar_path is private by design and it has nothing else to check.
    --
    -- The pairing is not exotic. setProfilePublic(false) rotates the key to
    -- revoke URLs a stranger already has, and it does so whether or not an
    -- avatar exists; publishing again then handed out a key that resolves to
    -- nothing, and a stranger saw a broken-image icon. lib/profile/manage.ts
    -- no longer creates that state, and this makes it unpublishable either way.
    case when u.avatar_path is not null then u.avatar_key end,
    u.created_at,
    o.subject,
    o.tier,
    o.verified_at,
    (select count(*)::integer
       from public.agents a
      where a.user_id = u.id and a.published)
  from public.users u
  -- `and o.published` belongs in the JOIN, not the WHERE. In the WHERE it would
  -- suppress the whole profile for an operator who has not published an owner
  -- binding, instead of returning the profile with null owner columns. Same
  -- reasoning, and the same trap, as 0017's join against agent_owners.
  left join public.agent_owners o
    on o.user_id = u.id and o.published
  where u.username = lower(p_handle)
    and u.profile_public
  limit 1
$$;

create or replace function public.public_operator_agents(p_handle text, p_limit integer)
returns table (
  passport_pubkey text,
  label           text,
  status          text,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.passport_pubkey,
    a.public_label,
    a.status::text,
    a.created_at
  from public.agents a
  join public.users u on u.id = a.user_id
  -- Both opt-ins, every time. An agent published under a profile that is later
  -- made private disappears with the profile.
  where u.username = lower(p_handle)
    and u.profile_public
    and a.published
    -- A Direct Agent Key agent has no passport (0023 dropped the NOT NULL), and
    -- the whole value of this list is that each row is independently checkable
    -- at /verify/<pubkey>. A row nobody can verify does not belong on it.
    and a.passport_pubkey is not null
    -- Belt and braces with agents_published_needs_label: never emit a blank row,
    -- and never be tempted to coalesce to a.name to avoid one.
    and a.public_label is not null
  order by a.created_at desc
  limit least(coalesce(p_limit, 24), 100)
$$;

-- Exists so the unauthenticated avatar route physically cannot select `email` or
-- `plan`, even if someone later edits it carelessly. It takes the capability
-- token and returns one column: where the bytes live.
create or replace function public.avatar_object_path(p_key text)
returns table (object_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.avatar_path
  from public.users u
  where u.avatar_key = p_key
    and u.avatar_path is not null
  limit 1
$$;

-- Explicit, and not assumed from default privileges: 0007 exists because
-- implicit grants do not reproduce on a from-scratch apply, and a newly created
-- function defaults to EXECUTE for PUBLIC. 0017's header records what forgetting
-- this costs.
revoke all on function public.public_operator_profile(text) from public, anon, authenticated;
grant execute on function public.public_operator_profile(text) to service_role;

revoke all on function public.public_operator_agents(text, integer) from public, anon, authenticated;
grant execute on function public.public_operator_agents(text, integer) to service_role;

revoke all on function public.avatar_object_path(text) from public, anon, authenticated;
grant execute on function public.avatar_object_path(text) to service_role;

-- ── 5. Avatar storage ────────────────────────────────────────────────────────
--
-- PRIVATE bucket, and no policy is created on storage.objects for it. That
-- absence is deliberate rather than an oversight, which is why it is written
-- down: RLS on storage.objects is default-deny, so with no policy neither anon
-- nor authenticated can read or write these objects, and service_role bypasses
-- RLS. Every avatar byte therefore moves through our own server.
--
-- The reason it is not the conventional public Supabase bucket is CSP.
-- lib/csp.ts pins `img-src 'self' data: blob:`. A public bucket URL would be
-- blocked on every page unless that directive were widened to name a third-party
-- origin, so the bytes are served from our own origin instead and the policy is
-- left exactly as it is. tests/csp.test.ts is what keeps that true.
--
-- file_size_limit and allowed_mime_types are a backstop, not the control: the
-- real validation is magic-byte sniffing in lib/profile/image.ts, because a MIME
-- type is a claim made by the uploader.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 524288, array['image/png', 'image/webp'])
on conflict (id) do nothing;
