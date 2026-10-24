// Egress policy: an allowlisting proxy an agent-spawned process is pointed at.
//
// Run: node tests/test-egress.mjs

import http from 'node:http';
import net from 'node:net';
import {
  EGRESS_MODES, DEFAULT_ALLOW, matchHost, normalizeEgressPolicy, checkEgress,
  egressEnv, startEgressProxy
} from '../lib/egress.js';

let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

console.log('\nHost rules');
{
  ok('an exact host matches', matchHost(['api.anthropic.com'], 'api.anthropic.com') === 'api.anthropic.com');
  ok('matching is case-insensitive and ignores a trailing dot', matchHost(['API.Anthropic.com'], 'api.anthropic.com.') === 'api.anthropic.com');
  ok('a wildcard covers subdomains only', matchHost(['*.anthropic.com'], 'a.b.anthropic.com') === '*.anthropic.com' && matchHost(['*.anthropic.com'], 'anthropic.com') === null);
  ok('a wildcard does not match a lookalike suffix', matchHost(['*.anthropic.com'], 'evil-anthropic.com') === null);
  ok('`*` is everything', matchHost(['*'], 'anything.example') === '*');
  ok('an empty rule list matches nothing', matchHost([], 'example.com') === null);
}

console.log('\nPolicy');
{
  ok('modes are the three documented ones', EGRESS_MODES.join(',') === 'off,allowlist,open');
  ok('an unknown mode is refused', (() => { try { normalizeEgressPolicy({ mode: 'yolo' }); return false; } catch (e) { return e.code === 'InvalidPolicy'; } })());
  const p = normalizeEgressPolicy({ mode: 'allowlist', allow: ['  API.OpenAI.com ', 'api.openai.com', 'bad rule!', ''] });
  ok('rules are trimmed, lowercased and de-duplicated', p.allow.join(',') === 'api.openai.com');
  ok('a malformed rule is dropped, not honoured', !p.allow.includes('bad rule!'));
  ok('deny beats allow', checkEgress({ mode: 'allowlist', allow: ['api.openai.com'], deny: ['api.openai.com'] }, 'api.openai.com').allowed === false);
  ok('off allows nothing', checkEgress({ mode: 'off' }, 'api.openai.com').allowed === false);
  ok('open allows everything', checkEgress({ mode: 'open' }, 'example.com').allowed === true);
  ok('allowlist admits a listed host', checkEgress({ mode: 'allowlist', allow: ['api.openai.com'] }, 'api.openai.com').allowed === true);
  ok('allowlist refuses an unlisted host with a reason', (() => {
    const v = checkEgress({ mode: 'allowlist', allow: ['api.openai.com'] }, 'example.com');
    return v.allowed === false && /allowlist/.test(v.reason);
  })());
  ok('the defaults name the model APIs and the two package registries',
    DEFAULT_ALLOW.includes('api.anthropic.com') && DEFAULT_ALLOW.includes('api.openai.com') && DEFAULT_ALLOW.includes('registry.npmjs.org'));
}

console.log('\nEnvironment');
{
  const env = egressEnv(4321);
  ok('every proxy spelling is set', env.HTTP_PROXY === 'http://127.0.0.1:4321' && env.HTTPS_PROXY === env.HTTP_PROXY && env.https_proxy === env.HTTP_PROXY);
  ok('loopback is excluded so local calls still work', /127\.0\.0\.1/.test(env.NO_PROXY) && /localhost/.test(env.NO_PROXY));
}

console.log('\nLive proxy');
{
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`origin says ${req.url}`);
  });
  const originPort = await listen(origin);
  const echo = net.createServer((socket) => socket.on('data', (d) => socket.write(d)));
  const echoPort = await listen(echo);

  const proxy = await startEgressProxy({ policy: { mode: 'allowlist', allow: ['127.0.0.1'] } });
  ok('it binds a port', proxy.port > 0);
  ok('it advertises its policy', proxy.policy.mode === 'allowlist');

  const through = (path, port = originPort) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxy.port, method: 'GET',
      path: `http://127.0.0.1:${port}${path}`,
      headers: { host: `127.0.0.1:${port}` }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  const good = await through('/hello');
  ok('an allowed host is proxied', good.status === 200 && good.body === 'origin says /hello');
  ok('the proxy count records it', proxy.stats().allowed >= 1);

  proxy.setPolicy({ mode: 'allowlist', allow: ['nope.example'] });
  const blocked = await through('/hello');
  ok('a host that is not on the list is refused', blocked.status === 403);
  ok('…with a reason the caller can show', (() => { try { return /allowlist/.test(JSON.parse(blocked.body).reason); } catch { return false; } })());
  ok('…and it is counted as denied', proxy.stats().denied >= 1);
  ok('…and remembered for the UI', proxy.stats().last.some((e) => e.host === '127.0.0.1' && e.allowed === false));

  proxy.setPolicy({ mode: 'allowlist', allow: ['127.0.0.1'] });
  const tunnel = await new Promise((resolve) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    });
    let stage = 0;
    let buffer = '';
    socket.on('data', (d) => {
      buffer += d.toString('latin1');
      if (stage === 0 && buffer.includes('\r\n\r\n')) {
        stage = 1;
        buffer = '';
        socket.write('ping');
        return;
      }
      if (stage === 1) { resolve({ handshake: '200', echoed: buffer.includes('ping') }); socket.destroy(); }
    });
    socket.on('error', () => resolve({ handshake: 'error', echoed: false }));
    setTimeout(() => resolve({ handshake: 'timeout', echoed: false }), 3000);
  });
  ok('CONNECT opens a tunnel for an allowed host', tunnel.handshake === '200' && tunnel.echoed);

  proxy.setPolicy({ mode: 'off' });
  const deniedTunnel = await new Promise((resolve) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
    });
    let buffer = '';
    socket.on('data', (d) => { buffer += d.toString('latin1'); });
    socket.on('close', () => resolve(buffer));
    setTimeout(() => { socket.destroy(); resolve(buffer); }, 2000);
  });
  ok('CONNECT is refused when egress is off', /403/.test(deniedTunnel));

  proxy.setPolicy({ mode: 'open' });
  ok('open mode flips the same proxy without a restart', (await through('/again')).status === 200);

  await proxy.close();
  ok('closing the proxy frees the port', await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(proxy.port, '127.0.0.1', () => probe.close(() => resolve(true)));
  }));

  await close(origin);
  await close(echo);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
