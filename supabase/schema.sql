-- ANTICODEX Supabase schema (project: anticodex / xmbkmdqaczlxkdarayyy)
-- Applied via the Supabase connector and kept here as the source of truth.

create table if not exists public.users (
  id text primary key,
  email text unique not null,
  name text,
  password_hash text,
  role text default 'user',
  provider text default 'email',
  github_id text,
  github_login text,
  supabase_uid text,
  avatar_url text,
  confirmed boolean default false,
  sessions jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.user_keys (
  id text primary key,
  user_id text,
  email text,
  key_env text not null,
  value text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists user_keys_email_idx on public.user_keys(email);

create table if not exists public.threads (
  id text primary key,
  user_id text references public.users(id) on delete cascade,
  title text,
  model text,
  messages jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.reset_codes (
  id text primary key,
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  used boolean default false,
  purpose text default 'recovery',
  created_at timestamptz default now()
);

create table if not exists public.mcp_connections (
  id text primary key,
  user_id text,
  name text,
  transport text,
  url text,
  cmd text,
  status text default 'disconnected',
  permissions jsonb default '{"tools":true,"resources":true,"prompts":true,"read":true,"write":false}'::jsonb,
  scopes jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.generations (
  id text primary key,
  user_id text,
  kind text,               -- image | video
  provider text,
  prompt text,
  result text,
  created_at timestamptz default now()
);

create table if not exists public.sessions (
  id text primary key,
  kind text,               -- mcp-oauth | desktop-pair | computer
  code text,
  connection_id text,
  scopes jsonb,
  approved boolean default false,
  approved_at timestamptz,
  used boolean default false,
  claimed_by text,
  linked_token text,
  linked_user jsonb,
  claimed_at timestamptz,
  verifier text,
  client_id text,
  client_secret text,
  meta jsonb,
  redirect_uri text,
  url text,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.audit (
  id text primary key,
  type text,
  message text,
  user_id text,
  ip text,
  at timestamptz default now()
);

create table if not exists public.outbox (
  id text primary key,
  "to" text,
  subject text,
  body text,
  at timestamptz default now()
);

create table if not exists public.api_keys (
  id text primary key,
  user_id text,
  provider text,           -- nvidia | tavily | exa | cloudflare | minimax | custom
  label text,
  key_value text,
  endpoint text,
  created_at timestamptz default now()
);

create index if not exists idx_threads_user on public.threads(user_id);
create index if not exists idx_reset_email on public.reset_codes(email);
create index if not exists idx_sessions_code on public.sessions(code);

-- Row Level Security (service-role key bypasses these; anon needs policies).
alter table public.users enable row level security;
alter table public.threads enable row level security;
alter table public.reset_codes enable row level security;
alter table public.mcp_connections enable row level security;
alter table public.generations enable row level security;
alter table public.sessions enable row level security;
alter table public.audit enable row level security;
alter table public.outbox enable row level security;
alter table public.api_keys enable row level security;

create policy "service role full access" on public.users for all using (true) with check (true);
create policy "service role full access" on public.threads for all using (true) with check (true);
create policy "service role full access" on public.reset_codes for all using (true) with check (true);
create policy "service role full access" on public.mcp_connections for all using (true) with check (true);
create policy "service role full access" on public.generations for all using (true) with check (true);
create policy "service role full access" on public.sessions for all using (true) with check (true);
create policy "service role full access" on public.audit for all using (true) with check (true);
create policy "service role full access" on public.outbox for all using (true) with check (true);
create policy "service role full access" on public.api_keys for all using (true) with check (true);
