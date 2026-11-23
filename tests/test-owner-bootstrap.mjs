import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-owner-'));
process.env.ANTICODEX_DATA = path.join(TMP, 'data');
// A hermetic run: no operator credentials, no Supabase, no network.
for (const k of ['OWNER_EMAIL','OWNER_PASSWORD','BOOTSTRAP_ACCOUNTS','BOOTSTRAP_PASSWORD','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
const { isBootstrapEmail, ensureBootstrapAccounts } = await import('../lib/authx.js');
let p=0,f=0; const ok=(n,c,x)=>{ if(c){p++;console.log('  + '+n);} else {f++;console.log('  FAIL '+n+' '+(x||''));} };
console.log('--- owner bootstrap has no published default ---');
const keys = read('lib/keys.js');
ok('OWNER_EMAIL slot is empty in source', /OWNER_EMAIL: ''/.test(keys));
ok('OWNER_PASSWORD slot is empty in source', /OWNER_PASSWORD: ''/.test(keys));
ok('ADMIN_USERNAME slot is empty in source', /ADMIN_USERNAME: ''/.test(keys));
ok('ADMIN_PASSWORD slot is empty in source', /ADMIN_PASSWORD: ''/.test(keys));
const authx = read('lib/authx.js');
ok('bootstrap requires BOTH email and password', /if \(email && password\)/.test(authx));
ok('no literal password in the auth module', !/Thaddeusk12/.test(authx));
console.log('--- unset credentials mean no bootstrap account ---');
ok('an arbitrary email is not a bootstrap email', isBootstrapEmail('someone@example.com') === false);
ok('the previously published address is not a bootstrap email', isBootstrapEmail('tthaddeus75@gmail.com') === false);
{ const r = await ensureBootstrapAccounts();
  ok('materialising with nothing configured creates nothing', r.ok === true && r.created.length === 0, JSON.stringify(r)); }
console.log('--- the README no longer publishes a credential ---');
const readme = read('README.md');
ok('README does not print the old password', !/Thaddeusk12/.test(readme));
ok('README states there is no default', /no default owner credential/i.test(readme));
ok('README still documents the variables', /OWNER_EMAIL/.test(readme) && /OWNER_PASSWORD/.test(readme));
console.log('--- setting credentials explicitly still works (positive control) ---');
process.env.OWNER_EMAIL = 'operator@example.com';
process.env.OWNER_PASSWORD = 'a-password-chosen-by-the-operator';
ok('the configured email becomes a bootstrap email', isBootstrapEmail('operator@example.com') === true);
ok('an unrelated email is still not one', isBootstrapEmail('other@example.com') === false);
{ const r = await ensureBootstrapAccounts();
  ok('the configured account is materialised', r.ok === true && r.created.includes('operator@example.com'), JSON.stringify(r)); }
console.log('--- the old canaries still guard source and bundle ---');
const tw = read('tests/test-web.mjs');
ok('test-web still forbids the literal in keys.js', tw.includes("!keysSrc.includes('Thaddeusk12')"));
ok('test-web still forbids the literal in the bundle', tw.includes("!js.includes('Thaddeusk12')"));
console.log(p+' passed, '+f+' failed');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(f?1:0);
