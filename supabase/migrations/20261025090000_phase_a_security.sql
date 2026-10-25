begin;

alter table public.mcp_connections add column if not exists enabled boolean default true;
alter table public.mcp_connections add column if not exists token text;
alter table public.mcp_connections add column if not exists access_token text;
alter table public.mcp_connections add column if not exists refresh_token text;
alter table public.mcp_connections add column if not exists expires_at timestamptz;
alter table public.mcp_connections add column if not exists tools jsonb default '[]'::jsonb;
alter table public.mcp_connections add column if not exists prompts jsonb default '[]'::jsonb;
alter table public.mcp_connections add column if not exists headers jsonb default '{}'::jsonb;
alter table public.mcp_connections add column if not exists connected_at timestamptz;
alter table public.mcp_connections add column if not exists last_test timestamptz;
alter table public.mcp_connections add column if not exists last_error text;
create index if not exists idx_mcp_connections_user on public.mcp_connections(user_id);

alter table public.sessions add column if not exists user_id text;
alter table public.sessions add column if not exists allow_private boolean default false;
alter table public.sessions add column if not exists used_at timestamptz;

create table if not exists public.skill_settings (
  id text primary key,
  user_id text not null unique,
  states jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_skill_settings_user on public.skill_settings(user_id);
alter table public.skill_settings enable row level security;
drop policy if exists "service role full access" on public.skill_settings;
create policy "service role full access" on public.skill_settings for all to service_role using (true) with check (true);

-- Earlier schema revisions created these policies without a role clause, which
-- made them apply to anon/authenticated. Restrict them to the server role.
drop policy if exists "service role full access" on public.users;
create policy "service role full access" on public.users for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.threads;
create policy "service role full access" on public.threads for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.reset_codes;
create policy "service role full access" on public.reset_codes for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.mcp_connections;
create policy "service role full access" on public.mcp_connections for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.generations;
create policy "service role full access" on public.generations for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.sessions;
create policy "service role full access" on public.sessions for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.audit;
create policy "service role full access" on public.audit for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.outbox;
create policy "service role full access" on public.outbox for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.api_keys;
create policy "service role full access" on public.api_keys for all to service_role using (true) with check (true);
drop policy if exists "service role full access" on public.policy;
create policy "service role full access" on public.policy for all to service_role using (true) with check (true);

commit;
