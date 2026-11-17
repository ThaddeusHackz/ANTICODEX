// Remote SSH sandbox contract.
//
// These assertions are deliberately about the seam that could hurt: profile
// validation, per-account isolation, and the promise that no secret is stored.
// Nothing here opens a socket — a real SSH test is a UI action, not a unit test.
//
// Run: node tests/test-remote.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// lib/keys.js reads ANTICODEX_DATA at import time, so the fixture directory has
// to exist before the dynamic import below.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-remote-'));
process.env.ANTICODEX_DATA = path.join(tmp, 'data');

const {
  validateProfile, saveRemoteProfile, listRemoteProfiles, deleteRemoteProfile,
  getRemoteProfile, remoteStatus, runRemoteCode, testRemoteProfile, REMOTE_LANGUAGES,
  parseSshTarget, isAccessString
} = await import('../lib/remote.js');

let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\n— profile validation —');
{
  ok('missing host is refused', Boolean(validateProfile({ username: 'u' }).error));
  ok('a host with an underscore is refused', Boolean(validateProfile({ host: 'bad_host', username: 'u' }).error));
  ok('port 0 is refused', Boolean(validateProfile({ host: 'example.com', port: 0, username: 'u' }).error));
  ok('port 70000 is refused', Boolean(validateProfile({ host: 'example.com', port: 70000, username: 'u' }).error));
  ok('a missing username is refused', Boolean(validateProfile({ host: 'example.com' }).error));
  ok('a username with a space is refused', Boolean(validateProfile({ host: 'example.com', username: 'bad user' }).error));
  ok('a label with control characters is refused',
    Boolean(validateProfile({ host: 'example.com', username: 'u', label: 'bad\nlabel' }).error));
  ok('a relative key path is refused',
    Boolean(validateProfile({ host: 'example.com', username: 'u', key_path: 'keys/id_ed25519' }).error));
  ok('a key path that does not exist is refused',
    Boolean(validateProfile({ host: 'example.com', username: 'u', key_path: path.join(tmp, 'nope') }).error));

  const v = validateProfile({ host: 'ssh.app.daytona.io', port: '22', username: 'daytona', label: '' });
  ok('a valid profile is normalised', v.profile && v.profile.host === 'ssh.app.daytona.io' && v.profile.port === 22);
  ok('the default label names the identity', v.profile.label === 'daytona@ssh.app.daytona.io');
  ok('auth defaults to local SSH config and keys', v.profile.auth === 'keys');
  ok('an explicit agent auth is kept',
    validateProfile({ host: 'example.com', username: 'u', auth: 'agent' }).profile.auth === 'agent');
  ok('a nonsense auth falls back to keys',
    validateProfile({ host: 'example.com', username: 'u', auth: 'password' }).profile.auth === 'keys');

  // The whole line a Daytona dashboard gives you is what people paste. The old
  // form asked for a username they did not have, so the connection never ran.
  const token = 'At2WqTIyeKZBKedyYw9UE8pDsGCYymJK';
  const p = parseSshTarget(`ssh ${token}@ssh.app.daytona.io`);
  ok('a full ssh command parses into host and username',
    p.ok && p.username === token && p.host === 'ssh.app.daytona.io' && p.port === 22);
  ok('ssh -p is honoured', parseSshTarget('ssh -p 2222 me@example.com').port === 2222);
  ok('user@host:port is honoured',
    (() => { const x = parseSshTarget('me@example.com:2200'); return x.ok && x.port === 2200 && x.host === 'example.com'; })());
  ok('an unsupported ssh flag is refused instead of ignored',
    parseSshTarget('ssh -o ProxyCommand=evil me@example.com').ok === false);
  ok('a missing username is refused', parseSshTarget('ssh example.com').ok === false);
  ok('the Daytona access string is recognised as a credential',
    isAccessString('ssh.app.daytona.io', token) && !isAccessString('example.com', token));
  const fromCommand = validateProfile({ ssh_command: `ssh ${token}@ssh.app.daytona.io`, label: 'Daytona' });
  ok('validateProfile accepts the pasted command', fromCommand.profile && fromCommand.profile.host === 'ssh.app.daytona.io');
  ok('the default label never contains the access string',
    !validateProfile({ ssh_command: `ssh ${token}@ssh.app.daytona.io` }).profile.label.includes(token));
}

console.log('\n— storage: per account, no secrets —');
{
  const alice = saveRemoteProfile('alice', {
    host: 'ssh.app.daytona.io', port: 22, username: 'daytona', label: 'Daytona',
    password: 'hunter2', private_key: '-----BEGIN OPENSSH PRIVATE KEY-----'
  });
  ok('a profile saves', alice.ok === true && alice.profile.id.startsWith('ssh-'));
  ok('the public profile carries no password', !('password' in alice.profile));
  ok('the public profile carries no key material', !('private_key' in alice.profile));
  ok('account A sees its profile', listRemoteProfiles('alice').length === 1);
  ok('account B does not', listRemoteProfiles('bob').length === 0);

  const store = path.join(process.env.ANTICODEX_DATA, 'remote.json');
  const raw = fs.readFileSync(store, 'utf8');
  ok('the JSON on disk never contains the pasted password', !raw.includes('hunter2'));
  ok('the JSON on disk never contains PEM key material', !raw.includes('BEGIN OPENSSH'));

  const updated = saveRemoteProfile('alice', {
    id: alice.profile.id, host: 'ssh.app.daytona.io', port: 2222, username: 'daytona', label: 'Daytona 2222'
  });
  ok('saving with an id updates instead of duplicating', updated.ok && listRemoteProfiles('alice').length === 1);
  ok('the update is visible', getRemoteProfile('alice', alice.profile.id).port === 2222);
  ok('updating keeps added_at', updated.profile.added_at === alice.profile.added_at);

  if (process.platform !== 'win32') {
    const mode = fs.statSync(store).mode & 0o777;
    ok('the profile store is mode 0600', mode === 0o600, `got 0${mode.toString(8)}`);
  }

  ok('deleting a profile works', deleteRemoteProfile('alice', alice.profile.id).ok === true);
  ok('the account is empty afterwards', listRemoteProfiles('alice').length === 0);
  ok('deleting an unknown id is an honest error', deleteRemoteProfile('alice', 'ssh-nope').ok === false);
}

console.log('\n— a Daytona access string is stored, but never echoed —');
{
  const token = 'At2WqTIyeKZBKedyYw9UE8pDsGCYymJK';
  const saved = saveRemoteProfile('carol', {
    ssh_command: `ssh ${token}@ssh.app.daytona.io`, label: 'Daytona workspace'
  });
  ok('the pasted command saves as one profile', saved.ok === true && saved.profile.host === 'ssh.app.daytona.io');
  ok('the public profile hides the access string', saved.profile.username === '' && saved.profile.has_credential === true);
  ok('the hint identifies it without revealing it', saved.profile.username_hint === 'At2W…ymJK');
  ok('the listing hides it too', listRemoteProfiles('carol')[0].username === '');
  ok('the raw profile still has what ssh needs', getRemoteProfile('carol', saved.profile.id).username === token);

  const kept = saveRemoteProfile('carol', {
    id: saved.profile.id, label: 'Daytona workspace', host: 'ssh.app.daytona.io', port: 22, username: ''
  });
  ok('editing with an empty username keeps the credential', kept.ok === true && listRemoteProfiles('carol').length === 1);
  ok('and keeps it usable', getRemoteProfile('carol', saved.profile.id).username === token);

  const store = fs.readFileSync(path.join(process.env.ANTICODEX_DATA, 'remote.json'), 'utf8');
  ok('the store is mode 0600 because it does hold the credential', (fs.statSync(path.join(process.env.ANTICODEX_DATA, 'remote.json')).mode & 0o777) === 0o600);
  ok('no access string is written to any public listing', !JSON.stringify(listRemoteProfiles('carol')).includes(token));
}

console.log('\n— status and safe refusal paths —');
{
  const status = remoteStatus('alice');
  ok('status names the Daytona gateway as a hint', status.defaults.host === 'ssh.app.daytona.io');
  ok('status reports whether OpenSSH exists as a boolean', typeof status.available === 'boolean');
  ok('status explains the auth model', /BatchMode=yes/.test(status.note));
  ok('status lists the saved profiles', Array.isArray(status.profiles) && status.profiles.length === 0);

  const langs = REMOTE_LANGUAGES.map((l) => l.id).sort().join(',');
  ok('the fixed language table is node,python,bash', langs === 'bash,node,python');

  const noProfile = await runRemoteCode('alice', { language: 'node', code: 'console.log(1)' });
  ok('a run without a profile refuses before spawning ssh',
    noProfile.ok === false && /No saved SSH profile/.test(noProfile.error));

  const bad = await testRemoteProfile('alice', { host: '', username: '' });
  ok('an invalid unsaved test refuses before spawning ssh', bad.ok === false && Boolean(bad.error));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
