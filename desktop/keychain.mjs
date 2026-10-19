// Where the .exe keeps the provider keys it stores on this machine.
//
// Electron's safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on
// Linux) when it is available; when it is not, the value stays plaintext but this
// module reports `encrypted:false`, so the UI can say that out loud instead of
// pretending the keys are protected. No silent half-measures — the whole point is
// that "saved on this device" means something checkable.
//
// Deliberately Electron-free (safeStorage and the state file are injected) so
// `tests/test-desktop.mjs` can exercise the real logic, including the migration
// from the older plaintext layout.
//
// Contract with the caller: `readState()` returns the state object, and
// `writeState(patch)` MERGES the patch into it (that is how main.mjs's saveState
// behaves); `null` clears a field.

const PLAIN_FIELD = 'providerKeys';        // legacy layout: plaintext map
const ENC_FIELD = 'providerKeysEnc';      // current layout: base64 ciphertext of a JSON map
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,60}$/;

function cleanMap(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    const env = String(k || '').trim();
    const value = String(v == null ? '' : v).trim();
    if (ENV_NAME.test(env) && value) out[env] = value;
  }
  return out;
}

export function createKeychain({ safeStorage, readState, writeState, log = () => {} } = {}) {
  const available = Boolean(safeStorage?.isEncryptionAvailable?.());

  function decrypt(raw) {
    if (!raw || raw === 'null') return {};
    // The legacy layout was a plain object in the state file; the current one is a
    // base64 blob. Tolerate both on read so an upgrade never loses a key.
    if (typeof raw === 'object') return cleanMap(raw);
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
      try { return cleanMap(JSON.parse(raw)); } catch { return {}; }
    }
    if (!available) {
      try { return cleanMap(JSON.parse(raw)); } catch { return {}; }
    }
    try {
      return cleanMap(JSON.parse(safeStorage.decryptString(Buffer.from(String(raw), 'base64'))));
    } catch (e) {
      // A DPAPI blob is bound to the Windows user account (and a Keychain item to
      // this login), so a copied profile cannot be read. Say so and come up empty
      // rather than handing a provider garbage and calling it "your key is wrong".
      log(`keychain unreadable (${e.message || e}) — starting with no saved keys`);
      return {};
    }
  }

  /** Write one map, in whichever form this machine can honour. */
  function persist(map) {
    const clean = cleanMap(map);
    if (available) {
      writeState({ [ENC_FIELD]: Buffer.from(safeStorage.encryptString(JSON.stringify(clean))).toString('base64'), [PLAIN_FIELD]: null });
      return { ok: true, encrypted: true, saved: Object.keys(clean) };
    }
    writeState({ [PLAIN_FIELD]: clean, [ENC_FIELD]: null });
    return { ok: true, encrypted: false, saved: Object.keys(clean) };
  }

  function load() {
    const state = readState() || {};
    if (state[ENC_FIELD]) return { keys: decrypt(state[ENC_FIELD]), encrypted: true };
    const legacy = state[PLAIN_FIELD];
    const keys = decrypt(legacy);
    // (decrypt handles both an object and a JSON string, so a state file written
    // by an older build is read by this one without a special case.)
    if (legacy && available && Object.keys(keys).length) {
      // One-time upgrade off the plaintext field.
      persist(keys);
      return { keys, encrypted: true, migrated: true };
    }
    return { keys, encrypted: available };
  }

  function setOne(env, value) {
    const next = { ...load().keys, [String(env || '').trim()]: String(value == null ? '' : value).trim() };
    if (!next[String(env || '').trim()]) delete next[String(env || '').trim()];
    const out = persist(next);
    return { ...out, count: Object.keys(next).length };
  }

  function remove(env) {
    const next = { ...load().keys };
    delete next[String(env || '').trim()];
    const out = persist(next);
    return { ...out, count: Object.keys(next).length };
  }

  return {
    load,
    save: (map) => persist(map),
    setOne,
    remove,
    status: () => ({ available, encrypted: available, backend: available ? 'safeStorage' : 'plaintext-file' })
  };
}
