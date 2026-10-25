import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-security-'));
process.env.ANTICODEX_DATA = dataDir;
process.env.NODE_ENV = 'test';
process.env.REQUIRE_EMAIL_VERIFICATION = '';
process.env.EXPOSE_RESET_CODES = 'true';

const {
  ADMIN_TOKEN_TTL_SECONDS,
  adminLoginStatus,
  issueAdminToken,
  recordAdminLoginFailure,
  resetAdminSecurityStateForTests,
  revokeAdminToken,
  verifyAdminToken
} = await import('../lib/admin-auth.js');
const { assertSafeUrl, guardedFetch, isPrivateAddress } = await import('../lib/net-guard.js');
const { consumeQuota, resetQuotasForTests } = await import('../lib/quota.js');
const { redactSensitive, publicMcpConnection } = await import('../lib/redact.js');
const { resolveSkillMentions } = await import('../lib/skills.js');
const bridge = (await import('../api/bridge.js')).default;

let passed = 0;
const test = async (name, run) => {
  try { await run(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name} — ${error.stack || error}`); process.exitCode = 1; }
};

console.log('— admin capabilities —');
await test('admin token has the required payload and 30-minute lifetime', () => {
  const now = Date.now();
  const token = issueAdminToken('root', { now, secret: 'a'.repeat(32), jti: 'one' });
  const payload = verifyAdminToken(token, { now, secret: 'a'.repeat(32), subject: 'root' });
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'jti', 'sub']);
  assert.equal(payload.exp - payload.iat, ADMIN_TOKEN_TTL_SECONDS);
});
await test('expired, tampered, wrong-secret, and alg-confused tokens fail', () => {
  const now = Date.now();
  const secret = 'b'.repeat(32);
  const token = issueAdminToken('root', { now, secret, jti: 'two' });
  assert.equal(verifyAdminToken(token, { now: now + ADMIN_TOKEN_TTL_SECONDS * 1000 + 1, secret }), null);
  assert.equal(verifyAdminToken(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'), { now, secret }), null);
  assert.equal(verifyAdminToken(token, { now, secret: 'c'.repeat(32) }), null);
  const parts = token.slice(4).split('.');
  parts[0] = Buffer.from(JSON.stringify({ alg: 'none', typ: 'ACX-ADMIN' })).toString('base64url');
  assert.equal(verifyAdminToken(`adm_${parts.join('.')}`, { now, secret }), null);
});
await test('logout revokes a jti until its expiry', () => {
  resetAdminSecurityStateForTests();
  const token = issueAdminToken('root', { secret: 'd'.repeat(32), jti: 'logout' });
  assert.ok(verifyAdminToken(token, { secret: 'd'.repeat(32) }));
  assert.equal(revokeAdminToken(token, { secret: 'd'.repeat(32) }), true);
  assert.equal(verifyAdminToken(token, { secret: 'd'.repeat(32) }), null);
});
await test('five failed logins lock an IP and username', () => {
  resetAdminSecurityStateForTests();
  for (let i = 0; i < 5; i += 1) recordAdminLoginFailure('203.0.113.8', 'root', 1000);
  const status = adminLoginStatus('203.0.113.8', 'root', 1000);
  assert.equal(status.allowed, false);
  assert.ok(status.retryAfter > 0);
});

console.log('— network guard —');
await test('private, metadata, CGNAT, multicast and local IPv6 ranges are classified', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', 'ff02::1']) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});
await test('DNS results are checked, not just hostname strings', async () => {
  const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(() => assertSafeUrl('https://public.example/path', { lookup }), /private/);
});
await test('redirect targets are rechecked and HTTPS downgrade is rejected', async () => {
  const lookup = async () => [{ address: '203.0.113.20', family: 4 }];
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://next.example/' } });
  await assert.rejects(() => guardedFetch('https://start.example/', {}, { lookup, fetchImpl }), /downgrade/);
});
await test('local fixture is blocked by default and works only with allowPrivate', async () => {
  const server = http.createServer((_req, res) => { res.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await assert.rejects(() => guardedFetch(url), /private/);
    const response = await guardedFetch(url, {}, { allowPrivate: true });
    assert.equal(await response.text(), 'ok');
  } finally { server.close(); }
});
await test('responses over five megabytes are refused', async () => {
  const lookup = async () => [{ address: '203.0.113.21', family: 4 }];
  const fetchImpl = async () => new Response('12345');
  await assert.rejects(() => guardedFetch('https://size.example/', {}, { lookup, fetchImpl, maxBytes: 4 }), /exceeds/);
});

console.log('— quotas, skills, and redaction —');
await test('token buckets limit and refill anonymous and user identities', () => {
  resetQuotasForTests();
  const config = {
    anonymous: { capacity: 1, refillPerMinute: 1 },
    ip: { capacity: 1, refillPerMinute: 1 },
    user: { capacity: 1, refillPerMinute: 1 }
  };
  assert.equal(consumeQuota({ action: 'chat', ip: '1', now: 0, config }).allowed, true);
  assert.equal(consumeQuota({ action: 'chat', ip: '1', now: 0, config }).allowed, false);
  assert.equal(consumeQuota({ action: 'chat', ip: '1', now: 60000, config }).allowed, true);
  assert.equal(consumeQuota({ action: 'search', ip: '2', userId: 'u', now: 0, config }).allowed, true);
  assert.equal(consumeQuota({ action: 'search', ip: '2', userId: 'u', now: 0, config }).allowed, false);
});
await test('disabled skills and implicit-disabled skills are excluded', () => {
  const skills = [
    { name: 'disabled', enabled: false, allow_implicit_invocation: true },
    { name: 'explicit', enabled: true, allow_implicit_invocation: false },
    { name: 'implicit', enabled: true, allow_implicit_invocation: true }
  ];
  assert.deepEqual(resolveSkillMentions('$disabled', skills), []);
  assert.deepEqual(resolveSkillMentions('explicit', skills), []);
  assert.equal(resolveSkillMentions('$explicit', skills)[0].name, 'explicit');
  assert.equal(resolveSkillMentions('please use implicit now', skills)[0].name, 'implicit');
});
await test('MCP public records and nested values never expose secrets', () => {
  const row = publicMcpConnection({ id: 'x', url: 'https://x.test/?token=raw', access_token: 'raw', headers: { Authorization: 'Bearer raw' } });
  const encoded = JSON.stringify(row);
  assert.equal(row.has_token, true);
  assert.equal(encoded.includes('raw'), false);
  assert.equal(JSON.stringify(redactSensitive({ refresh_token: 'raw', nested: { authorization: 'Bearer raw' } })).includes('raw'), false);
  const usage = redactSensitive({
    max_tokens: 8, total_tokens: 120, first_token_ms: 50, input_tokens: 10, output_tokens: 20,
    token_count: 3, token_usage: { total: 3 }, access_token: 'raw'
  });
  assert.equal(usage.max_tokens, 8);
  assert.equal(usage.total_tokens, 120);
  assert.equal(usage.first_token_ms, 50);
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.token_count, 3);
  assert.deepEqual(usage.token_usage, { total: 3 });
  assert.equal(usage.access_token, '[REDACTED]');
});

console.log('— MCP tenant integration —');
const server = http.createServer((req, res) => bridge(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(action, body = {}, token = '') {
  const response = await fetch(`${base}/api/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...body })
  });
  return { status: response.status, data: await response.json() };
}
try {
  const aEmail = `a-${Date.now()}@example.test`;
  const bEmail = `b-${Date.now()}@example.test`;
  const a = await call('register', { email: aEmail, password: 'Correct-horse-123!', name: 'Alpha' });
  const b = await call('register', { email: bEmail, password: 'Correct-horse-123!', name: 'Beta' });
  const tokenA = a.data.token;
  const tokenB = b.data.token;
  await test('user A can save an MCP without receiving its secret back', async () => {
    const result = await call('mcp', { op: 'save', connection: { id: 'tenant-a', name: 'A', url: 'https://example.com/mcp', token: 'never-return-this', headers: { Authorization: 'Bearer never-return-this' } } }, tokenA);
    assert.equal(result.status, 200);
    assert.equal(result.data.connection.has_token, true);
    assert.equal(JSON.stringify(result.data).includes('never-return-this'), false);
  });
  await test('user B cannot see, use, or delete user A MCP records', async () => {
    const list = await call('mcp', { op: 'list' }, tokenB);
    assert.equal(list.data.connections.some((item) => item.id === 'tenant-a'), false);
    assert.equal((await call('mcp', { op: 'call', connection_id: 'tenant-a', tool: 'x' }, tokenB)).status, 404);
    assert.equal((await call('mcp', { op: 'delete', id: 'tenant-a' }, tokenB)).status, 404);
    const ownerList = await call('mcp', { op: 'list' }, tokenA);
    assert.equal(ownerList.data.connections.some((item) => item.id === 'tenant-a'), true);
    assert.equal(JSON.stringify(ownerList.data).includes('never-return-this'), false);
  });
  await test('skill disable state is persisted and enforced by get/resolve', async () => {
    const disabled = await call('skills', { op: 'configure', name: 'reverse-engineer-anything', enabled: false }, tokenA);
    assert.equal(disabled.status, 200);
    assert.equal((await call('skills', { op: 'get', name: 'reverse-engineer-anything' }, tokenA)).status, 404);
    assert.equal((await call('skills', { op: 'resolve', text: '$reverse-engineer-anything' }, tokenA)).data.matched.length, 0);
    await call('skills', { op: 'configure', name: 'reverse-engineer-anything', enabled: true }, tokenA);
    assert.equal((await call('skills', { op: 'get', name: 'reverse-engineer-anything' }, tokenA)).status, 200);
  });
} finally {
  server.close();
}

console.log(`\n${passed} passed, ${process.exitCode ? 1 : 0} failed`);
