const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|api[_-]?key|.*token.*|.*secret.*|password|credential)(?:$|[_-])/i;
const USAGE_KEY = /(?:^|[_-])(max|total|first|input|output|cached|prompt|completion|token_count|token_usage|token_ms)(?:$|[_-])/i;

export function redactText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:[^=&]*(?:token|secret|key|password)[^=&]*)=)[^&#\s]*/gi, '$1[REDACTED]')
    .slice(0, 8000);
}

export function redactSensitive(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) && !USAGE_KEY.test(key) ? '[REDACTED]' : redactSensitive(item, seen);
  }
  return out;
}

export function publicMcpConnection(connection) {
  if (!connection) return null;
  const hasToken = Boolean(
    connection.token || connection.access_token || connection.refresh_token || connection.client_secret ||
    Object.keys(connection.headers || {}).some((key) => /authorization|token|secret|api[_-]?key/i.test(key))
  );
  const allowed = [
    'id', 'user_id', 'name', 'transport', 'url', 'status', 'enabled', 'permissions', 'scopes',
    'created_at', 'updated_at', 'expires_at', 'tools', 'prompts', 'connected_at', 'last_test',
    'last_error', 'server_version', 'protocol_version', 'local', 'all_tools', 'max_tools',
    'tool_allowlist', 'imported_at'
  ];
  const out = {};
  for (const key of allowed) if (connection[key] !== undefined) out[key] = redactSensitive(connection[key]);
  out.has_token = hasToken;
  return out;
}
