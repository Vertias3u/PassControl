-- Keep the public /notices route unavailable as an operator profile handle.
-- The reserved-handle registry is server-only and trigger-enforced; route
-- additions extend its seed in a new migration because applied files are immutable.

insert into public.reserved_usernames (username)
values ('notices')
on conflict (username) do nothing;
