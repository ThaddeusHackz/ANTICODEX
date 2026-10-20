-- Already applied to anticodex via Supabase on 2026-10-20.
-- Account keys are accessed through the authenticated server bridge only.
begin;
alter table public.user_keys enable row level security;
revoke all privileges on table public.user_keys from anon, authenticated;
grant select, insert, update, delete on table public.user_keys to service_role;
commit;
