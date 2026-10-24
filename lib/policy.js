// ANTICODEX — feature policy.
//
// The shape is taken from the shipped Claude desktop's `policy-limits.json`:
// every capability is a named restriction with an explicit `allowed`, plus
// `compliance_taints`, `monitoring_notice` and `defaults`. A flag that is not
// listed is *not* silently allowed — the resolver falls back to a default that
// is written down here, so the UI can show why something is off.

import { insert, findOne, update } from './store.js';
import { normalizeSandboxPolicy, normalizeApprovalPolicy, describePolicy } from './workspace.js';

export const POLICY_FLAGS = {
  // Local MCP servers (REA). Off means no child process is ever spawned.
  allow_local_mcp: { default: true, label: 'Local MCP servers', detail: 'Run MCP servers on this machine (REA reverse-engineering tools).' },
  allow_remote_control: { default: false, label: 'Remote control', detail: 'Let another device drive this session.' },
  allow_routines: { default: false, label: 'Routines', detail: 'Scheduled/unattended agent runs.' },
  allow_quick_web_setup: { default: false, label: 'Quick web setup', detail: 'One-click connector setup that skips the permission review.' },
  enforce_web_search_mcp_isolation: { default: false, label: 'Isolate web search from MCP', detail: 'Search results never flow back into an MCP tool call.' },
  require_write_approval: { default: true, label: 'Approve writes', detail: 'Agent file writes and shell commands need an explicit approval.' },
  telemetry: { default: false, label: 'Telemetry', detail: 'Send usage counters off this device.' }
};

export const DEFAULT_POLICY = {
  flags: Object.fromEntries(Object.entries(POLICY_FLAGS).map(([k, v]) => [k, v.default])),
  compliance_taints: [],
  monitoring_notice: null,
  defaults: {
    remote_control_at_startup: false,
    follow_up_queue_mode: 'queue',
    // Codex names, so one config means one thing on both sides.
    sandbox_policy: 'workspace-write',
    approval_policy: 'on-request'
  }
};

/** Coerce anything into a policy this product understands. */
export function normalizePolicy(input = {}) {
  const flags = { ...DEFAULT_POLICY.flags };
  const src = input.flags && typeof input.flags === 'object' ? input.flags : input;
  for (const key of Object.keys(POLICY_FLAGS)) {
    if (typeof src[key] === 'boolean') flags[key] = src[key];
    else if (src[key] && typeof src[key] === 'object' && typeof src[key].allowed === 'boolean') flags[key] = src[key].allowed;
  }
  return {
    flags,
    compliance_taints: Array.isArray(input.compliance_taints) ? input.compliance_taints.slice(0, 50) : [],
    monitoring_notice: typeof input.monitoring_notice === 'string' ? input.monitoring_notice : null,
    defaults: {
      remote_control_at_startup: Boolean(input.defaults?.remote_control_at_startup),
      follow_up_queue_mode: input.defaults?.follow_up_queue_mode === 'steer' ? 'steer' : 'queue',
      sandbox_policy: normalizeSandboxPolicy(input.defaults?.sandbox_policy),
      approval_policy: normalizeApprovalPolicy(input.defaults?.approval_policy)
    }
  };
}

export function policyAllows(policy, key) {
  if (!(key in POLICY_FLAGS)) return false;
  const p = normalizePolicy(policy || DEFAULT_POLICY);
  return p.flags[key] === true;
}

/** Stored per account; a missing row is the documented default, not an error. */
export async function getPolicy(email) {
  if (!email) return { ...DEFAULT_POLICY };
  try {
    const row = await findOne('policy', (r) => r.email === email);
    return row ? normalizePolicy(row) : { ...DEFAULT_POLICY };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function savePolicy(email, patch = {}) {
  const next = normalizePolicy({ ...(await getPolicy(email)), ...patch });
  try {
    const existing = await findOne('policy', (r) => r.email === email);
    const row = { email, ...next, updated_at: new Date().toISOString() };
    if (existing) await update('policy', (r) => r.email === email, row);
    else await insert('policy', { id: `policy_${email}`, ...row });
    return { ok: true, policy: next, persisted: true };
  } catch (e) {
    // Read-only filesystem (Vercel, packaged .exe) — still answer with the new
    // policy so the session behaves, but say it was not stored.
    return { ok: true, policy: next, persisted: false, note: String(e.message || e) };
  }
}

/** The one-liner the UI prints for the current workspace policy. */
export function describeWorkspacePolicy(policy) {
  const p = normalizePolicy(policy || DEFAULT_POLICY);
  return describePolicy({ sandbox: p.defaults.sandbox_policy, approval: p.defaults.approval_policy });
}

/** `restrictions.*.allowed` from an imported policy-limits.json. */
export function flagsFromRestrictions(restrictions = {}) {
  const out = {};
  for (const [key, v] of Object.entries(restrictions || {})) {
    if (v && typeof v === 'object' && 'allowed' in v) out[key] = v.allowed !== false;
  }
  return out;
}
