-- Keep the public /updates route unavailable as an operator profile handle.
-- 0040 is already applied and immutable, so route additions extend its seed in
-- their own migration. The registry remains server-only and trigger-enforced.

insert into public.reserved_usernames (username)
values ('updates')
on conflict (username) do nothing;
