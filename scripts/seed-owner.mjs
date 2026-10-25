#!/usr/bin/env node
// ANTICODEX — one-shot account bootstrap.
//
// Creates (or repairs) a sign-in in whatever ledger this environment uses:
// Supabase Postgres when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are present,
// otherwise the local data/db.json store (dev server, packaged desktop app).
// Re-running only fills in what is missing, so it can never wipe a password
// that a user already chose — pass --reset-password to take over deliberately.
//
//   node scripts/seed-owner.mjs                       # the owner account
//   node scripts/seed-owner.mjs --reset-password      # force the configured pw
//   node scripts/seed-owner.mjs --email=ops@x.com --name=Ops --password=longenough
//   ANTICODEX_DATA=<userData>/data node scripts/seed-owner.mjs   # a desktop install
//
// Defaults come from OWNER_EMAIL / OWNER_PASSWORD / OWNER_NAME / OWNER_ROLE
// (see lib/keys.js) or the environment.

import { getKey } from '../lib/keys.js';
import { find, updateById } from '../lib/store.js';
import * as authx from '../lib/authx.js';

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...rest] = a.slice(2).split('='); return [k, rest.join('=') || 'true']; }));

const email = String(args.email || getKey('OWNER_EMAIL') || '').trim().toLowerCase();
const name = String(args.name || getKey('OWNER_NAME') || email.split('@')[0]).trim();
const role = String(args.role || getKey('OWNER_ROLE') || 'admin').trim();
const password = String(args.password || getKey('OWNER_PASSWORD') || '');
const force = args['reset-password'] === 'true';
const isOwner = Boolean(getKey('OWNER_EMAIL')) && email === String(getKey('OWNER_EMAIL')).trim().toLowerCase();

const mask = (v) => (v.length > 6 ? `${v.slice(0, 2)}••••${v.slice(-2)}` : '••••');

async function ledgerRow() {
  const rows = await find('users', (u) => u.email === email, 5);
  return rows[0] || null;
}

async function main() {
  if (!email || !email.includes('@')) {
    console.error('✗ Set OWNER_EMAIL or pass --email=.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('✗ The password (OWNER_PASSWORD or --password=) must be at least 8 characters.');
    process.exit(1);
  }
  const onSupabase = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || getKey('SUPABASE_SERVICE_ROLE_KEY')));
  console.log(`ANTICODEX seed — ${email} · name "${name}" · role ${role} · password ${mask(password)}`);
  console.log(`  ledger: ${onSupabase ? `${String(process.env.SUPABASE_URL).replace(/\/+$/, '')} (Supabase Postgres)` : 'local data dir (data/db.json)'}`);

  let status = '';
  if (isOwner) {
    // The owner row is a control credential: it is created from OWNER_* config
    // and its password is kept in sync with that config (pass --keep-password to
    // leave an existing hash alone), so the owner can never be locked out by a
    // half-finished sign-up or a wiped row.
    const out = await authx.ensureBootstrapAccounts();
    status = out.created?.includes(email) ? 'created from OWNER_* config' : 'already present';
    if (args['keep-password'] !== 'true') await authx.resetPassword({ email, password, privileged: true });
  } else {
    const existing = await ledgerRow();
    if (!existing) {
      const made = await authx.register({ email, password, name });
      if (!made.ok) { console.error(`✗ Could not create the account: ${made.error}`); process.exit(1); }
      status = 'created';
    } else if (force) {
      const reset = await authx.resetPassword({ email, password, privileged: true });
      if (!reset.ok) { console.error(`✗ ${reset.error}`); process.exit(1); }
      status = 'existing (password forced)';
    } else {
      status = 'already present (password kept — pass --reset-password to change it)';
    }
  }

  let row = await ledgerRow();
  if (!row) {
    console.error('✗ The account was not written. If this ledger is Supabase, apply supabase/schema.sql first.');
    process.exit(1);
  }
  if (row.role !== role || row.name !== name || row.confirmed === false) {
    await updateById('users', row.id, { role, name, confirmed: true });
    row = { ...row, role, name, confirmed: true };
  }
  console.log(`  ✓ ${status} · id=${row.id} · role=${role} · confirmed=true`);

  const login = await authx.login({ email, password });
  if (!login.ok) {
    console.error(`✗ Sign-in check failed: ${login.error}`);
    console.error('  A different password is already set for this email. Re-run with --reset-password to take it over.');
    process.exit(1);
  }
  console.log(`✓ sign-in works → token ${String(login.token).slice(0, 12)}… · user=${login.user.name} <${login.user.email}> · role=${login.role}`);
  console.log(`✓ protected endpoints accept the session: ${Boolean(await authx.findByToken(login.token))}`);
  console.log('\nDone. This account signs in on the website and in the desktop app;');
  console.log('the admin console keeps its own ADMIN_USERNAME / ADMIN_PASSWORD.');
}

main().catch((e) => { console.error(`✗ ${e.message || e}`); process.exit(1); });
