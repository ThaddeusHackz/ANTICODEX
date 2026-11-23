// Request-scoped tenant boundary shared by every MCP caller, not just the UI.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
const actors = new AsyncLocalStorage();
export const withMcpOwner = (owner, run) => actors.run(owner ? String(owner) : null, run);
export const mcpOwner = () => actors.getStore() || null;
export const ownsMcp = (row, owner = mcpOwner()) => Boolean(owner && row && row.owner_id === owner);
export function scopePredicate(collection, pred = () => true) {
  const owner = mcpOwner();
  return (row) => (collection !== 'mcp_connections' && !(collection === 'sessions' && row?.kind === 'mcp-oauth') || ownsMcp(row, owner)) && pred(row);
}
export function ownMcpRow(collection, row) {
  if (collection !== 'mcp_connections' && !(collection === 'sessions' && row?.kind === 'mcp-oauth')) return row;
  const owner = mcpOwner();
  if (!owner) throw new Error('Sign in before changing MCP connections.');
  for (const key of Object.keys(row)) if (key.startsWith('has_')) delete row[key];
  row.owner_id = owner;
  if (collection === 'mcp_connections') {
    const prefix = `mc_${createHash('sha256').update(owner).digest('hex').slice(0, 16)}_`;
    if (!String(row.id).startsWith(prefix)) row.id = prefix + String(row.id || globalThis.crypto.randomUUID());
  } else {
    row.used = false;
    row.expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  }
  return row;
}
const PRIVATE = /^(?:access_token|refresh_token|token|client_secret|registration_access_token|client_registration_access_token|verifier|code_verifier|authorization|api_key)$/i;
export function publicMcp(value) {
  if (Array.isArray(value)) return value.map(publicMcp);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'tool_cache' || key === 'owner_id') continue;
    if (['inputSchema', 'outputSchema', 'schema', 'parameters'].includes(key)) { result[key] = val; continue; }
    if (PRIVATE.test(key) && (val === null || typeof val !== 'object')) { if (val) result[`has_${key}`] = true; continue; }
    if (/headers/i.test(key) && val && typeof val === 'object') result[key] = Object.fromEntries(Object.keys(val).map((k) => [k, '[configured]']));
    else result[key] = publicMcp(val);
  }
  return result;
}
export function credentialPatch(input, previous) {
  const patch = { ...input };
  delete patch.id; delete patch.owner_id;
  for (const key of Object.keys(patch)) if (key.startsWith('has_')) delete patch[key];
  for (const key of Object.keys(patch)) {
    if (PRIVATE.test(key) && (patch[key] === '[configured]' || patch[key] === '')) delete patch[key];
    if (/headers/i.test(key) && patch[key] && typeof patch[key] === 'object') patch[key] = Object.fromEntries(Object.entries(patch[key]).map(([k, v]) => [k, v === '[configured]' ? previous?.[key]?.[k] : v]).filter(([, v]) => v !== undefined));
  }
  return patch;
}
