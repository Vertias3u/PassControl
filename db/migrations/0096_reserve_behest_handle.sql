-- Keep the public /behest route unavailable as an operator profile handle,
-- the same as 0043 did for /learn. The reserved-handle registry is server-only
-- and trigger-enforced; applied files are immutable, so each new route gets its
-- own seed migration.

insert into public.reserved_usernames (username)
values ('behest')
on conflict (username) do nothing;
