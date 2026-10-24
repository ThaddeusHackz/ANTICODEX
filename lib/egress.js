// ANTICODEX — egress policy for agent-spawned work.
//
// Evidence this is built from (see docs/REA-EVIDENCE.md):
//
//   * `codex-command-runner.exe` (Rust, 8.2 MB) imports CreateRestrictedToken,
//     AdjustTokenPrivileges, SetTokenInformation(TokenDefaultDacl) and
//     CreateProcessW: the command it runs is a *reduced* process, not this one.
//   * `cowork-svc.exe` is a Go service whose module table is a user-mode network
//     stack — gvisor.dev/gvisor/pkg/tcpip, gvisor-tap-vsock, DHCP, DNS, an
//     anthropics HTTP proxy fork, go-winio — i.e. sandboxed work gets its own
//     network path rather than the machine's.
//   * `codex-windows-sandbox-setup.exe` carries `--launch-payload`,
//     `sandbox-secrets`, `sandboxlog` and a token-usage telemetry endpoint.
//
// Both products decided that a sandbox is also a *network* boundary. This module
// is the same idea at the layer available here: an allowlisting HTTP/CONNECT
// proxy that a spawned process is pointed at, plus the environment that points it
// there. It is a policy, not a kernel: a process that ignores the environment
// variables is not contained, and the code says so wherever it could be misread.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

export const EGRESS_MODES = ['off', 'allowlist', 'open'];
export const DEFAULT_ALLOW = ['api.anthropic.com', 'api.openai.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'];

export class EgressError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * A rule is an exact host, a `*.suffix` wildcard, or `*`.
 * Returns the rule that matched, or null.
 */
export function matchHost(rules, host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  for (const raw of rules || []) {
    const rule = String(raw || '').trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return rule;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return rule;
      continue;
    }
    if (rule === h) return rule;
  }
  return null;
}

/** Normalise a caller-supplied policy without inventing permissions. */
export function normalizeEgressPolicy({ mode = 'off', allow = [], deny = [] } = {}) {
  if (!EGRESS_MODES.includes(mode)) {
    throw new EgressError('InvalidPolicy', `mode must be one of ${EGRESS_MODES.join(', ')}`);
  }
  const clean = (list) => [...new Set((Array.isArray(list) ? list : [])
    .map((r) => String(r || '').trim().toLowerCase())
    .filter((r) => r && r.length <= 253 && /^(\*|\*\.[a-z0-9.-]+|[a-z0-9.-]+)$/.test(r)))]
    .slice(0, 200);
  return { mode, allow: clean(allow), deny: clean(deny) };
}

/** Decide one host against a policy. Deny always wins. */
export function checkEgress(policy, host) {
  const p = normalizeEgressPolicy(policy);
  const blocked = matchHost(p.deny, host);
  if (blocked) return { allowed: false, reason: 'deny', rule: blocked, mode: p.mode };
  if (p.mode === 'off') return { allowed: false, reason: 'egress is off', rule: null, mode: p.mode };
  if (p.mode === 'open') return { allowed: true, reason: 'open', rule: '*', mode: p.mode };
  const matched = matchHost(p.allow, host);
  return matched
    ? { allowed: true, reason: 'allow', rule: matched, mode: p.mode }
    : { allowed: false, reason: 'not on the allowlist', rule: null, mode: p.mode };
}

/** The environment that points a child process at the proxy (and nothing else). */
export function egressEnv(port, { host = '127.0.0.1', extraNoProxy = [] } = {}) {
  const url = `http://${host}:${port}`;
  const noProxy = ['localhost', '127.0.0.1', '::1', ...extraNoProxy].join(',');
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, http_proxy: url, https_proxy: url, all_proxy: url,
    NO_PROXY: noProxy, no_proxy: noProxy
  };
}

const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

/**
 * Start the proxy. `onDecision` receives every verdict so a UI can show what an
 * agent tried to reach; the counters are the same information in aggregate.
 */
export async function startEgressProxy({ policy, port = 0, host = '127.0.0.1', onDecision = () => {} } = {}) {
  const state = {
    policy: normalizeEgressPolicy(policy),
    allowed: 0,
    denied: 0,
    last: [],
    connections: new Set(),
    started_at: Date.now()
  };
  const record = (verdict, hostname, kind) => {
    if (verdict.allowed) state.allowed++; else state.denied++;
    state.last.unshift({ at: Date.now(), host: hostname, kind, ...verdict });
    if (state.last.length > 60) state.last.length = 60;
    try { onDecision({ host: hostname, kind, ...verdict }); } catch { /* a UI callback must not break the proxy */ }
  };

  const server = http.createServer((req, res) => {
    // Plain HTTP through a proxy arrives as an absolute URI.
    let target;
    try { target = new URL(req.url); }
    catch { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('proxy expects an absolute URI'); }
    const verdict = checkEgress(state.policy, target.hostname);
    record(verdict, target.hostname, 'http');
    if (!verdict.allowed) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'blocked by egress policy', host: target.hostname, ...verdict }));
    }
    const headers = { ...req.headers };
    for (const k of Object.keys(headers)) if (HOP_BY_HOP.has(k.toLowerCase())) delete headers[k];
    const upstream = http.request({
      host: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `upstream failed: ${e.message}` }));
    });
    req.pipe(upstream);
  });

  // HTTPS through a proxy is a CONNECT tunnel: the host is all we can see, which
  // is exactly what an allowlist needs.
  server.on('connect', (req, socket, head) => {
    const [rawHost, rawPort] = String(req.url || '').split(':');
    const hostname = rawHost;
    const portNum = Number(rawPort) || 443;
    const verdict = checkEgress(state.policy, hostname);
    record(verdict, hostname, 'connect');
    if (!verdict.allowed) {
      socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error: 'blocked by egress policy', host: hostname, ...verdict })}`);
      return socket.end();
    }
    const upstream = net.connect(portNum, hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    state.connections.add(upstream);
    const close = () => { state.connections.delete(upstream); socket.destroy(); upstream.destroy(); };
    upstream.on('error', () => { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); close(); });
    socket.on('error', close);
    socket.on('close', () => { state.connections.delete(upstream); upstream.destroy(); });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const bound = server.address();
  return {
    port: bound.port,
    host,
    url: `http://${host}:${bound.port}`,
    policy: state.policy,
    env: egressEnv(bound.port, { host }),
    stats: () => ({
      policy: state.policy,
      allowed: state.allowed,
      denied: state.denied,
      open_tunnels: state.connections.size,
      last: state.last,
      started_at: state.started_at
    }),
    setPolicy: (next) => { state.policy = normalizeEgressPolicy(next); return state.policy; },
    close: () => new Promise((resolve) => {
      for (const c of state.connections) c.destroy();
      state.connections.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}
