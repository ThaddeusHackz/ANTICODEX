-- REVIEW AND APPLY SEPARATELY. This PR never applies a live database migration.
-- Existing ownerless connections remain inaccessible. Reconnect per account;
-- never infer or mass-assign an owner to legacy credentials.
alter table public.mcp_connections add column if not exists owner_id text;
create index if not exists mcp_connections_owner_id_idx on public.mcp_connections(owner_id);
alter table public.sessions add column if not exists owner_id text;
alter table public.sessions add column if not exists used boolean default false;
alter table public.sessions add column if not exists expires_at timestamptz;
create index if not exists sessions_mcp_owner_idx on public.sessions(owner_id) where kind = 'mcp-oauth';
