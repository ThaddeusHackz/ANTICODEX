import crypto from 'node:crypto';
import { adminCredentials, issueAdminToken, verifyAdminToken } from '../lib/admin-auth.js';
import { json, readBody } from '../lib/util.js';
import { listProviders, chat, testEndpoint, directoryWithStatus, syncModels, resolveModelRef, modelIndex, explainProviderError, pickLiveModel, liveAlternatives, normalizeProviderDefs, isPrivateGateway, PROVIDER_DEFS_KEY } from '../lib/providers.js';
import { webSearch } from '../lib/search.js';
import { generateImage } from '../lib/flux.js';
import { startVideo, queryVideo } from '../lib/minimax.js';
import { VERSION, getKey, saveRuntime, CATALOG } from '../lib/keys.js';
import { allKeyEnvs, PROVIDER_DIRECTORY } from '../lib/catalog.js';
import { insert, findOne, find, update, remove, audit, saveUserKey, userKeyMap, deleteUserKey } from '../lib/store.js';
import * as authx from '../lib/authx.js';
import { handleExtras, builtinTools, runBuiltin } from '../lib/extras.js';
import { MCP_CATALOG, McpClient, probeServer, discoverAuth, registerClient, buildAuthorizeUrl, exchangeCode, refreshToken, pkcePair, collectTools, executeTool } from '../lib/mcp.js';
import { sha256, timingSafeEqual, otp6, uid, clientIp } from '../lib/util.js';

// ---------------------------------------------------------------------------
// Everything routes through /api/bridge with {action:...} so the same handlers
// work on Vercel serverless functions and the local Node server.
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const body = await readBody(req).catch(() => ({}));
  const raw = (req.url || '');
  const pathOnly = raw.split('?')[0];
  const qs = new URLSearchParams(raw.slice(pathOnly.length + 1));
  const action = body.action || qs.get('action') || pathOnly.split('/').pop();
  // Where this request is being served from — used to build OAuth callbacks so
  // preview deployments and the desktop app work without extra env vars.
  const origin = requestOrigin(req);
  try {
    switch (action) {
      case 'health': return json(res, 200, { ok: true, version: VERSION, name: 'ANTICODEX', time: new Date().toISOString() });
      case 'config': {
        const keys = await mergedKeys(req, body);
        return json(res, 200, await publicConfig(keys, {
          accountEnvs: new Set(await accountKeyEnvs(req, body)),
          defsNote: defsNote(keys),
          allowPrivate: isDesktopLocal(req)
        }));
      }
      case 'models': {
        // Whose keys count: the account on this request, then any explicit keys
        // (the desktop keychain sends those). Without this the UI could not see
        // a per-user key and reported a configured provider as "needs key".
        const keys = await mergedKeys(req, body);
        const mine = new Set(await accountKeyEnvs(req, body));
        const own = (p) => (mine.has(p.key_env) ? 'you' : (p.configured ? 'shared' : null));
        return json(res, 200, {
          providers: listProviders(keys).map((p) => ({ id: p.id, name: p.name, configured: p.configured, kind: p.kind, key_env: p.key_env, key_owner: own(p), models: p.models })),
          directory: directoryWithStatus(keys),
          picker: modelIndex(keys),
          catalog: CATALOG,
          ...(defsNote(keys) ? { provider_defs_note: defsNote(keys) } : {})
        });
      }
      case 'sync_models': {
        const keys = await mergedKeys(req, body);
        // Same rule as test_endpoint: "ask this URL for its model list" is an open
        // relay unless the address is one we can be told about. A browser may name a
        // public gateway; only the desktop app on that same machine may name a
        // private/LAN one (Ollama at 127.0.0.1, vLLM at 192.168.x.x).
        if (body.endpoint && isPrivateGateway(body.endpoint) && !isDesktopLocal(req)) return privateEndpointRefusal(res);
        return json(res, 200, await syncModels({ ...body, keys }));
      }
      case 'save_provider_key': {
        // This writes SERVER-WIDE config, so it belongs to the admin console
        // only. Users put keys in Settings → Providers (per account), which is
        // what chat/search/image/video actually resolve against.
        if (!await isAdmin(req, body)) return json(res, 401, { error: 'Global keys are admin-only. Save yours in Settings → Providers — your own key replaces the default for your account.', sign_in: '/login' });
        if (!body.key_env || typeof body.key_env !== 'string') return json(res, 400, { error: 'key_env required' });
        if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(body.key_env)) return json(res, 400, { error: 'key_env must look like an env var name (e.g. NVIDIA_API_KEY)' });
        if (!allKeyEnvs().includes(body.key_env)) return json(res, 400, { error: `${body.key_env} is not a managed key slot`, allowed: allKeyEnvs().slice(0, 40) });
        const patch = {}; patch[body.key_env] = String(body.value || '');
        let persisted = true;
        try { saveRuntime(patch); } catch { persisted = false; }
        if (!persisted) {
          // Read-only filesystem (Vercel / packaged app): keep it for this warm
          // instance instead of pretending the save happened.
          process.env[body.key_env] = patch[body.key_env];
        }
        return json(res, 200, { ok: true, key_env: body.key_env, persisted, message: persisted ? 'Saved to server config.' : 'This server is read-only, so the key lives in memory for now — restart and it is gone.' });
      }
      case 'test_endpoint': {
        // An open "fetch this URL for me" endpoint is an SSRF relay, so two things
        // must be true: the caller is accountable (a signed-in account, or this
        // machine's own desktop instance — a per-install secret that only a loopback
        // peer can present, and any proxied request carries x-forwarded-for, so a
        // forwarded "127.0.0.1" is never believed), and the address itself is not
        // private unless the caller IS the machine behind that address.
        const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
        if (!await authx.findByToken(auth) && !isDesktopLocal(req)) return json(res, 401, { error: 'sign in to test an endpoint', sign_in: '/login' });
        if (body.endpoint && isPrivateGateway(body.endpoint) && !isDesktopLocal(req)) return privateEndpointRefusal(res);
        return json(res, 200, await testEndpoint({ ...body, keys: await mergedKeys(req, body) }));
      }
      case 'chat': return await handleChat(body, res, req);
      case 'search': return json(res, 200, await webSearch({ ...body, keys: await mergedKeys(req, body) }));
      case 'image': return json(res, 200, await generateImage({ ...body, keys: await mergedKeys(req, body) }));
      case 'video_start': return json(res, 200, await startVideo({ ...body, keys: await mergedKeys(req, body) }));
      case 'video_status': return json(res, 200, await queryVideo(body.id));
      case 'user_keys': return await handleUserKeys(req, body, res);
      case 'register': return json(res, 200, await safeAuth(() => authx.register(body)));
      case 'verify_code': return json(res, 200, await safeAuth(() => authx.verifyCode(body)));
      case 'resend_code': return json(res, 200, await safeAuth(() => authx.resendCode(body)));
      case 'login': return json(res, 200, await safeAuth(() => authx.login(body)));
      case 'logout': return await handleLogout(req, body, res);
      case 'me': return await handleMe(req, body, res);
      case 'forgot': return json(res, 200, await safeAuth(() => authx.forgot(body)));
      case 'reset': {
        // The admin console can reset any account without the emailed code.
        const privileged = await isAdmin(req, body);
        return json(res, 200, await safeAuth(() => authx.resetPassword({
          email: body.email, code: body.code, token_hash: body.token_hash, token: body.token,
          password: body.new_password || body.password, privileged
        })));
      }
      case 'github_login': return json(res, 200, await safeAuth(() => authx.githubAuth({ ...body, origin })));
      case 'oauth_callback': return json(res, 200, await safeAuth(() => authx.oauthExchange({
        code: body.code || qs.get('code'), state: body.state || qs.get('state'),
        redirect_to: body.redirect_to, origin
      })));
      case 'threads': return await handleThreads(req, body, res);
      case 'mcp': return await handleMcp(body, res);
      case 'admin': return await handleAdmin(body, res);
      case 'pair': return await handlePair(body, res, req);
      case 'extras': return json(res, 200, await handleExtras(body));
      case 'update_check': return await handleUpdateCheck(body, res);
      default: return json(res, 404, { error: `unknown action: ${action}` });
    }
  } catch (e) {
    // Never forward internals (auth provider / DB chatter) to the browser.
    const detail = String(e?.message || e);
    const msg = process.env.NODE_ENV === 'production'
      ? 'Something went wrong on our side — try again.'
      : `Something went wrong on our side — ${detail.slice(0, 160)}`;
    return json(res, 500, { error: authx.humanize(detail, msg) });
  }
}

// --- auth plumbing ----------------------------------------------------------

/** Requests may arrive from a proxy, a preview URL or the desktop app; derive
 *  the public origin so OAuth callbacks match without extra configuration. */
function requestOrigin(req) {
  const fwdHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(fwdHost) ? fwdHost[0] : fwdHost) || req.headers.host || '';
  if (!host) return '';
  const rawProto = req.headers['x-forwarded-proto'];
  const proto = String(Array.isArray(rawProto) ? rawProto[0] : (rawProto || '')).split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|(\d+\.){3}\d+)$/.test(host.split(':')[0]);
  return `${proto || (local ? 'http' : 'https')}://${host}`;
}

/** The packaged .exe runs this same bridge in-process on 127.0.0.1 and mints a
 *  per-install secret (memory only, never written to disk) to hand to it. That is
 *  how an offline desktop — signed out, or signed in to a site it cannot reach —
 *  can still test endpoints, sync model lists and use a gateway on its own LAN,
 *  while a public deployment (which never sets this env var) keeps every gate. */
function isDesktopLocal(req) {
  const tok = process.env.ANTICODEX_LOCAL_TOKEN;
  if (!tok || String(tok).length < 16) return false;
  if (String(req?.headers?.['x-anticodex-local'] || '') !== String(tok)) return false;
  return isLoopback(req);
}

function isLoopback(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  if (fwd) return false;
  const ip = String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

/** Sign-in must survive any failure mode of the email provider: an exception
 *  from a dependency becomes a friendly, retryable answer instead of a 500. */
async function safeAuth(run) {
  try {
    const out = await run();
    return out || { ok: false, error: 'No response from the auth service — try again.' };
  } catch (e) {
    return { ok: false, error: authx.humanize(String(e?.message || e), 'Sign-in is temporarily unavailable — try again in a moment.') };
  }
}

async function isAdmin(req, body) {
  return verifyAdminToken(body?.token || req?.headers?.['x-admin-token']);
}

async function handleLogout(req, body, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
  const out = await authx.logout({ token });
  return json(res, 200, out);
}

// --- config -----------------------------------------------------------------

async function publicConfig(keys = {}, opts = {}) {
  const gh = { clientId: Boolean(getKey('GITHUB_CLIENT_ID') || process.env.GITHUB_CLIENT_ID), secret: Boolean(getKey('GITHUB_CLIENT_SECRET') || process.env.GITHUB_CLIENT_SECRET) };
  const supa = authx.supabaseInfo();
  return {
    name: 'ANTICODEX',
    version: VERSION,
    admin_username: getKey('ADMIN_USERNAME') || 'Thaddeusadmin',
    features: {
      chat: true, codex: true, claude_agent: true, images: true, video: true,
      mcp: true, computer_use: true,
      // 'oauth' when the whole round-trip is ready, 'setup' when it is half
      // configured (the UI then shows the exact steps instead of a dead button).
      github_login: gh.clientId && gh.secret ? 'oauth' : (gh.clientId || supa.hasAuth ? 'setup' : 'off'),
      github_ready: Boolean(gh.clientId && gh.secret) || supa.hasAuth,
      email_reset: true,
      email_auth: true,
      email_verification_required: /^(1|true|yes|on)$/i.test(String(getKey('REQUIRE_EMAIL_VERIFICATION') || process.env.REQUIRE_EMAIL_VERIFICATION || '')),
      supabase_auth: Boolean(supa.hasAuth),
      mailer_dev_codes: /^(1|true|yes|on)$/i.test(String(getKey('EXPOSE_RESET_CODES') || process.env.EXPOSE_RESET_CODES || ''))
    },
    // `configured` must reflect the ACCOUNT's keys, and each entry carries the
    // model list + key slot, otherwise the topbar menu could only ever send
    // "<provider>::default" — which every real provider rejects.
    // `key_owner` tells the UI "this is YOUR key" from "the shared default" —
    // the difference between a card that means 'ready' and one that lies.
    providers: listProviders(keys).map((p) => ({
      id: p.id, name: p.name, configured: p.configured, kind: p.kind,
      key_env: p.key_env || null, model_count: (p.models || []).length,
      key_owner: opts.accountEnvs?.has(p.key_env) ? 'you' : (p.configured ? 'shared' : null),
      // true once the endpoint itself listed these ids (test / sync), so the UI
      // can promise a model works instead of hoping the catalog guessed right
      verified: Boolean(p.models_verified),
      models: (p.models || []).slice(0, 60)
    })),
    // Which identity backend is wired up (a label, not a secret): the web UI
    // and the auth tests use it to confirm they are talking to the right
    // server before they assert on behaviours that differ per backend.
    auth_mode: supa.hasAuth ? 'supabase' : 'local',
    provider_count: PROVIDER_DIRECTORY.length,
    search_configured: Boolean(getKey('TAVILY_API_KEY') || getKey('EXA_API_KEY')),
    extras: {
      elevenlabs: Boolean(getKey('ELEVENLABS_API_KEY')), whisper: Boolean(getKey('OPENAI_API_KEY')),
      unsplash: Boolean(getKey('UNSPLASH_ACCESS_KEY')), openweather: Boolean(getKey('OPENWEATHER_API_KEY')),
      windy: Boolean(getKey('WINDY_API_KEY')), opensky: Boolean(getKey('OPENSKY_CLIENT_ID')),
      youtube: Boolean(getKey('YOUTUBE_API_KEY')), groq: Boolean(getKey('GROQ_API_KEY'))
    },
    flux_configured: Boolean(getKey('CF_API_TOKEN') && getKey('CF_ACCOUNT_ID')),
    minimax_configured: Boolean(getKey('MINIMAX_API_KEY')),
    // Key material never leaves the server — not even which optional
    // infrastructure is wired up; nothing in the client read these flags.
    account_keys: (opts.accountEnvs && [...opts.accountEnvs]) || [],
    ...(opts.defsNote ? { provider_defs_note: opts.defsNote } : {}),
    // the desktop app reports whether this instance can use a gateway on the LAN
    local_gateway_allowed: Boolean(opts.allowPrivate)
  };
}

// --- chat -------------------------------------------------------------------

// Resolve the keychain for a request: the account's own keys REPLACE the
// built-in defaults automatically; explicit per-call keys win overall.
async function mergedKeys(req, body) {
  const auth = (req?.headers?.authorization || '').replace(/^Bearer\s+/i, '') || body?.token;
  const user = auth ? await authx.findByToken(auth) : null;
  const uKeys = user ? await userKeyMap(user.email) : {};
  const keys = { ...uKeys, ...(body?.provider_keys || {}) };
  // Gateways this device knows about (Ollama/LM Studio/vLLM on the LAN). Private
  // addresses are only honoured for the local desktop instance — see above.
  const { defs, dropped, dropped_ids } = normalizeProviderDefs(body?.provider_defs, { allowPrivate: isDesktopLocal(req) });
  if (defs.length) keys[PROVIDER_DEFS_KEY] = defs;
  if (dropped) keys.__provider_defs_dropped__ = dropped;
  // A gateway this device named but that had to be ignored must never be answered
  // with a silent swap to the demo engine — "the model menu lists your gateway" and
  // then Demo Core replies is exactly the betrayal this whole path exists to end.
  if (dropped_ids?.length) keys.__provider_defs_dropped_ids__ = dropped_ids;
  return keys;
}

function privateEndpointRefusal(res) {
  return json(res, 403, {
    ok: false, verdict: 'blocked',
    error: 'That address is private or on a local network, so this server will not open a connection to it — a public multi-tenant host must not become a relay into someone\'s LAN or its cloud metadata service.',
    fix: 'desktop',
    hint: 'ANTICODEX Desktop runs the same bridge on your own machine and will happily dial 127.0.0.1 or your LAN: install it and add the gateway in Settings → Providers.'
  });
}

/** One line of honesty for the UI when a device's own gateway had to be ignored. */
function defsNote(keys) {
  return keys?.__provider_defs_dropped__
    ? `${keys.__provider_defs_dropped__} custom gateway(s) point at a private/LAN address, which this server will not dial for a browser. The desktop app can — install it for Ollama, LM Studio or a LAN box.`
    : null;
}

// Which key slots the ACCOUNT itself supplied (as opposed to the shared
// server defaults). Display metadata only — resolution order is unchanged.
async function accountKeyEnvs(req, body) {
  const auth = (req?.headers?.authorization || '').replace(/^Bearer\s+/i, '') || body?.token;
  const user = auth ? await authx.findByToken(auth) : null;
  return user ? Object.keys(await userKeyMap(user.email)) : [];
}

async function handleUserKeys(req, body, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
  const user = await authx.findByToken(auth);
  if (!user) return json(res, 401, { error: 'sign in to manage your API keys' });
  const op = body.op || 'get';
  if (op === 'get') {
    const map = await userKeyMap(user.email);
    const masked = {};
    for (const [k, v] of Object.entries(map)) masked[k] = v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '•••';
    return json(res, 200, { ok: true, keys: masked, count: Object.keys(map).length, email: user.email });
  }
  if (op === 'save') {
    if (!body.key_env || typeof body.value !== 'string' || !body.value.trim()) return json(res, 400, { error: 'key_env and value required' });
    await saveUserKey(user.email, String(body.key_env), String(body.value).trim());
    return json(res, 200, { ok: true, key_env: body.key_env, message: 'Your key now replaces the built-in default for your account.' });
  }
  if (op === 'delete') {
    await deleteUserKey(user.email, String(body.key_env));
    return json(res, 200, { ok: true, message: 'Reverted to the built-in default.' });
  }
  return json(res, 400, { error: 'unknown user_keys op' });
}

async function handleChat(body, res, req) {
  const { messages, model, system, temperature, max_tokens, images, provider, use_mcp } = body;
  let msgs = (messages || []).map((m) => ({ ...m, images: m.images || (m.role === 'user' ? images : undefined) }));
  const keys = await mergedKeys(req, body);
  if (provider && (keys.__provider_defs_dropped_ids__ || []).includes(provider)) {
    return json(res, 200, {
      ok: false, provider, model: model || null, verdict: 'blocked', fix: 'desktop',
      error: `"${provider}" points at a private or local-network address, so this server will not connect to it — and it will not answer you with a different model behind your back.`,
      hint: 'ANTICODEX Desktop runs this same bridge on your machine, where a gateway on 127.0.0.1 or your LAN is just your own server. Open Settings → Providers there and the same gateway works, keys and all.',
      settings_link: '/settings'
    });
  }

  if (use_mcp !== false) {
    const conns = (await find('mcp_connections', (c) => c.status === 'connected' && c.enabled !== false, 50)).slice(0, 12);
    const builtins = builtinTools();
    if (conns.length || builtins.length) {
      const tools = [...builtins, ...(await collectTools(conns)).filter((t) => !t._error)].slice(0, 40);
      if (tools.length) {
        let out;
        try {
          out = await chat({ messages: msgs, model, system, temperature, max_tokens, provider, keys, tools });
        } catch (e) { return json(res, 200, (await describeChatFailure(e, provider, model, keys)).payload); }
        // Tool-call loop (max 4 rounds) — the assistant can drive connected MCPs.
        let rounds = 0;
        while (out.tool_calls?.length && rounds < 4) {
          rounds++;
          msgs = [...msgs, { role: 'assistant', content: out.content || '', tool_calls: out.tool_calls }];
          for (const tc of out.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty */ }
            let result;
            try {
              const fname = tc.function?.name || '';
              result = builtins.some((b) => b.function.name === fname)
                ? await runBuiltin(fname, args)
                : await executeTool(conns, fname, args);
            } catch (e) { result = { error: String(e.message || e) }; }
            msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: JSON.stringify(result).slice(0, 12000) });
          }
          let next;
          try {
            next = await chat({ messages: msgs, model, system, temperature, max_tokens, provider, keys, tools });
          } catch (e) { return json(res, 200, (await describeChatFailure(e, provider, model, keys)).payload); }
          Object.assign(out, next);
          if (!next.tool_calls?.length) break;
        }
        return json(res, 200, out);
      }
    }
  }
  try {
    const out = await chat({ messages: msgs, model, system, temperature, max_tokens, provider, keys });
    return json(res, 200, out);
  } catch (e) {
    const { payload, retry_with } = await describeChatFailure(e, provider, model, keys);
    if (retry_with) {
      try {
        const again = await chat({ messages: msgs, model: retry_with, system, temperature, max_tokens, provider, keys });
        // Honest about what happened: the model you asked for does not exist
        // there, so this answered instead — and the picker now knows the list.
        return json(res, 200, {
          ...again, model: retry_with, retried_with: retry_with, asked_for: payload.model,
          note: `${provider || 'that provider'} has no model called "${payload.model}" — answered with "${retry_with}" from its live list instead.`
        });
      } catch (e2) {
        const second = await describeChatFailure(e2, provider, retry_with, keys);
        return json(res, 200, { ...second.payload, tried_models: [payload.model, retry_with] });
      }
    }
    return json(res, 200, payload);
  }
}

/** Provider failures used to arrive as an unhandled throw (a bare 500 on Vercel)
 *  or a raw "NVIDIA NIM returned 400: {...}". Turn them into one sentence plus
 *  the thing that fixes it — and when the *model* was the problem, look up an id
 *  the endpoint actually serves and offer it (retrying once ourselves below),
 *  because a catalog guess + a working key used to read as a broken key. */
async function describeChatFailure(e, provider, model, keys) {
  const ref = provider ? `${provider}::${model}` : String(model || '');
  let shown = ref.includes('::') ? ref.split('::').slice(1).join('::') : ref;
  const pid = provider || (ref.includes('::') ? ref.split('::')[0] : null);
  // Name the id that was really sent, not the "default" the client asked with —
  // otherwise the sentence and the retry both talk about the wrong model.
  try {
    const eff = resolveModelRef(ref, keys);
    if (eff && eff.model && eff.model.id && eff.model.id !== shown) shown = eff.model.id;
  } catch { /* resolution itself failed; the raw ref is the best we have */ }
  const { error, fix, verdict } = explainProviderError(e, pid || 'the provider', shown);
  const payload = {
    ok: false, error, fix, verdict: verdict || fix, provider: pid || null, model: shown || null,
    ...(fix === 'key' || fix === 'endpoint' ? { settings_link: '/settings' } : {}),
    ...(fix === 'model' ? { model_picker: true } : {})
  };
  let retry_with = null;
  if (fix === 'model' && pid && pid !== 'demo') {
    retry_with = pickLiveModel(pid, shown);
    if (!retry_with) {
      // Nothing cached for this provider — go ask it, then decide again.
      const synced = await syncModels({ provider: pid, keys });
      if (synced && synced.ok) retry_with = pickLiveModel(pid, shown);
    }
    const alts = liveAlternatives(pid, shown);
    if (alts.length) payload.fallback = alts;
  }
  return { payload, retry_with };
}

// --- auth -------------------------------------------------------------------

function githubAuthUrl() {
  const clientId = process.env.GITHUB_CLIENT_ID || getKey('GITHUB_CLIENT_ID');
  if (!clientId) return { configured: false, url: '', note: 'Set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET (Supabase Auth → Providers → GitHub) to enable one-click GitHub login.' };
  const redirect = process.env.AUTH_REDIRECT || getKey('AUTH_REDIRECT') || 'http://localhost:8787/auth/callback';
  return {
    configured: true,
    url: `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&scope=read:user user:email`
  };
}

async function handleMe(req, body, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
  if (!auth) return json(res, 401, { error: 'not authenticated', sign_in: '/login' });
  const user = await authx.findByToken(auth);
  if (!user) return json(res, 401, { error: 'Your session expired — sign in again.', sign_in: '/login' });
  return json(res, 200, { user: authx.sanitizeUser(user), ok: true });
}

// --- threads ----------------------------------------------------------------

async function handleThreads(req, body, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.token;
  const op = body.op || 'list';
  // Threads belong to the ACCOUNT, not to one session token, so chats survive
  // signing out and back in. Rows saved by the old token-keyed version are
  // still matched.
  const owner = await authx.findByToken(auth);
  if (!owner) return json(res, 401, { error: 'Sign in to access threads' });
  const mine = (row) => row && (row.user_id === owner.id || row.user_email === owner.email);
  if (op === 'list') {
    return json(res, 200, { threads: await find('threads', mine, 500) });
  }
  if (op === 'save') {
    const t = body.thread;
    if (!t?.id) return json(res, 400, { error: 'thread.id required' });
    const existing = await findOne('threads', (x) => x.id === t.id);
    if (existing && !mine(existing)) return json(res, 403, { error: 'that thread belongs to another account' });
    const row = { ...t, user_id: owner?.id || auth, user_email: owner?.email || null, updated_at: new Date().toISOString() };
    if (existing) await update('threads', (x) => x.id === t.id, row);
    else await insert('threads', row);
    return json(res, 200, { ok: true, thread: row });
  }
  if (op === 'delete') {
    const { remove } = await import('../lib/store.js');
    await remove('threads', (t) => t.id === body.id && mine(t));
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: 'unknown threads op' });
}

// --- MCP (real Model Context Protocol) --------------------------------------

async function handleMcp(body, res) {
  const op = body.op || 'list';
  if (op === 'catalog') return json(res, 200, { catalog: MCP_CATALOG, gateways: MCP_CATALOG.filter((c) => c.gateway) });

  if (op === 'list') return json(res, 200, { connections: await find('mcp_connections', () => true, 500) });

  if (op === 'save') {
    const c = { ...body.connection, id: body.connection?.id || uid('mcp'), updated_at: new Date().toISOString() };
    const existing = await findOne('mcp_connections', (x) => x.id === c.id);
    if (existing) await update('mcp_connections', (x) => x.id === c.id, c);
    else await insert('mcp_connections', { status: 'disconnected', enabled: true, permissions: { tools: true, resources: true, prompts: true, read: true, write: false }, ...c });
    return json(res, 200, { ok: true, connection: c });
  }

  if (op === 'delete') {
    await remove('mcp_connections', (x) => x.id === body.id);
    return json(res, 200, { ok: true });
  }

  if (op === 'probe') {
    // Live handshake — initialize + tools/list against the real server.
    try {
      const result = await probeServer(body.url, body.token);
      return json(res, 200, result);
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (op === 'connect_begin') {
    // Start the browser OAuth dance. Returns the provider's authorization URL
    // (the sign-in / permissions page) to open in the user's browser.
    const conn = await findOne('mcp_connections', (x) => x.id === body.connection_id);
    const url = body.url || conn?.url;
    if (!url) return json(res, 400, { error: 'url or connection_id required' });
    const meta = await discoverAuth(url);
    const redirectUri = body.redirect_uri || `${getKey('SITE_URL') || 'http://localhost:8787'}/mcp/callback`;
    const state = uid('st');
    const { verifier, challenge } = pkcePair();
    if (meta?.authorization_endpoint) {
      const client = await registerClient(meta, { redirectUris: [redirectUri] }) || {};
      const clientId = client.client_id || body.client_id;
      if (!clientId) {
        return json(res, 200, {
          ok: true, needs_key: true,
          message: 'This server needs OAuth. Its authorization server has no dynamic registration — paste a client id from the provider’s developer page, or use the managed gateway link.'
        });
      }
      await insert('sessions', {
        id: state, kind: 'mcp-oauth', connection_id: body.connection_id, url,
        verifier, client_id: clientId, client_secret: client.client_secret, meta,
        redirect_uri: redirectUri, created_at: Date.now()
      });
      const authorize_url = buildAuthorizeUrl(meta, {
        clientId, redirectUri, scope: body.scope || meta.scopes_supported?.slice(0, 8).join(' '),
        state, codeChallenge: challenge
      });
      return json(res, 200, { ok: true, authorize_url, state, requires_browser: true });
    }
    // Public / tokenless server — connect directly.
    try {
      const probe = await probeServer(url, body.token);
      const row = {
        id: body.connection_id || uid('mcp'), name: probe.server?.name || url, url, status: 'connected',
        enabled: true, token: body.token || null, tools: probe.tools, connected_at: Date.now()
      };
      const existing = await findOne('mcp_connections', (x) => x.id === row.id);
      if (existing) await update('mcp_connections', (x) => x.id === row.id, row);
      else await insert('mcp_connections', row);
      return json(res, 200, { ok: true, connected: true, connection: row });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (op === 'connect_callback') {
    const s = await findOne('sessions', (x) => x.id === body.state && x.kind === 'mcp-oauth');
    if (!s) return json(res, 404, { error: 'unknown OAuth state — start Connect again' });
    const tokens = await exchangeCode(s.meta, {
      code: body.code, redirectUri: s.redirect_uri,
      codeVerifier: s.verifier, clientId: s.client_id, clientSecret: s.client_secret
    });
    const probe = await probeServer(s.url, tokens.access_token);
    const row = {
      id: s.connection_id || uid('mcp'), name: probe.server?.name || s.url, url: s.url, status: 'connected',
      enabled: true, access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      tools: probe.tools, connected_at: Date.now()
    };
    const existing = await findOne('mcp_connections', (x) => x.id === row.id);
    if (existing) await update('mcp_connections', (x) => x.id === row.id, row);
    else await insert('mcp_connections', row);
    await update('sessions', (x) => x.id === s.id, { used: true });
    return json(res, 200, { ok: true, connection: row });
  }

  if (op === 'test') {
    const conn = await findOne('mcp_connections', (x) => x.id === body.connection_id);
    if (!conn) return json(res, 404, { error: 'connection not found' });
    try {
      const probe = await probeServer(conn.url, conn.access_token || conn.token);
      await update('mcp_connections', (x) => x.id === conn.id, { tools: probe.tools, last_test: Date.now(), last_error: null });
      return json(res, 200, { ok: true, ...probe });
    } catch (e) {
      await update('mcp_connections', (x) => x.id === conn.id, { last_error: String(e.message || e) });
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (op === 'call') {
    const conn = await findOne('mcp_connections', (x) => x.id === body.connection_id);
    if (!conn) return json(res, 404, { error: 'connection not found' });
    try {
      const client = new McpClient(conn.url, { token: conn.access_token || conn.token });
      await client.initialize();
      const result = await client.callTool(body.tool, body.args || {});
      await client.close();
      return json(res, 200, { ok: true, tool: body.tool, result });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  return json(res, 400, { error: 'unknown mcp op' });
}

// --- admin ------------------------------------------------------------------

async function handleAdmin(body, res) {
  const op = body.op || 'login';
  const credentials = adminCredentials();
  if (!credentials) return json(res, 401, { error: 'Administrator access is not configured on this server.' });
  const { username: expectedUser, password: expectedPass } = credentials;

  if (op === 'login') {
    const ok = timingSafeEqual(body.username || '', expectedUser) && timingSafeEqual(body.password || '', expectedPass);
    if (!ok) return json(res, 401, { error: 'Invalid admin credentials' });
    const token = issueAdminToken();
    await audit({ type: 'admin_login', ip: 'admin' });
    return json(res, 200, { ok: true, token });
  }

  const token = body.token || '';
  const valid = verifyAdminToken(token);
  if (!valid) return json(res, 401, { error: 'admin token required' });

  if (op === 'stats') {
    const users = await find('users', () => true, 10000);
    const threads = await find('threads', () => true, 10000);
    const mcp = await find('mcp_connections', () => true, 10000);
    return json(res, 200, {
      users: users.length,
      threads: threads.length,
      mcp_connections: mcp.length,
      versions: { app: VERSION },
      providers: listProviders().map((p) => ({ id: p.id, name: p.name, configured: p.configured })),
      recent: (await find('audit', () => true, 50)).reverse()
    });
  }
  if (op === 'users') return json(res, 200, { users: (await find('users', () => true, 10000)).map(authx.sanitizeUser) });
  if (op === 'ensure_owner') {
    // Materialise/repair the owner account (role=admin) in the ledger so the
    // admin can sign in to the app itself. Idempotent.
    const out = await authx.ensureBootstrapAccounts();
    await audit({ type: 'admin_ensure_owner', ip: 'admin' });
    return json(res, 200, { ...out, users: (await find('users', () => true, 10000)).map(authx.sanitizeUser) });
  }
  if (op === 'reset_user') {
    // Admin-side password reset: no emailed code required.
    if (!body.email) return json(res, 400, { error: 'email required' });
    const out = await authx.resetPassword({ email: body.email, password: body.password, privileged: true });
    await audit({ type: 'admin_reset_user', email: String(body.email).toLowerCase(), ip: 'admin' });
    return json(res, 200, out);
  }
  if (op === 'verify_user') {
    const row = await findOne('users', (u) => u.email === String(body.email || '').toLowerCase());
    if (!row) return json(res, 404, { error: 'no such user' });
    await update('users', (u) => u.id === row.id, { confirmed: true });
    return json(res, 200, { ok: true, user: authx.sanitizeUser({ ...row, confirmed: true }) });
  }
  if (op === 'set_keys') {
    const allowed = allKeyEnvs();
    const patch = {};
    for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
    saveRuntime(patch);
    await audit({ type: 'admin_set_keys', keys: Object.keys(patch) });
    return json(res, 200, { ok: true, saved: Object.keys(patch) });
  }
  if (op === 'get_keys') {
    const keys = {};
    for (const k of allKeyEnvs()) {
      const v = getKey(k);
      keys[k] = v ? `${v.slice(0, 4)}…${v.slice(-3)} (${v.length} chars)` : '(not set)';
    }
    return json(res, 200, { keys });
  }
  if (op === 'broadcast') {
    await insert('audit', { id: uid('bc'), type: 'broadcast', message: body.message, at: new Date().toISOString() });
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: 'unknown admin op' });
}

// --- desktop pairing & updates ----------------------------------------------

async function handlePair(body, res, req) {
  const op = body.op || 'create';
  if (op === 'create') {
    const code = String(crypto.randomInt(100000, 1000000));
    const deviceSecret = crypto.randomBytes(32).toString('hex');
    await insert('sessions', {
      id: 'pair_' + await sha256(deviceSecret), kind: 'desktop-pair', code,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), used: false
    });
    return json(res, 200, { code, device_secret: deviceSecret, expires_in: 600 });
  }
  if (op === 'adopt') {
    if (!isDesktopLocal(req)) return json(res, 403, { error: 'desktop-local op' });
    return json(res, 200, await authx.adoptSession({ token: body.token, user: body.user }));
  }
  if (op === 'claim') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || body.user_token || body.token;
    const user = await authx.findByToken(token);
    if (!user) return json(res, 401, { error: 'Sign in before linking a desktop' });
    const s = await findOne('sessions', (x) => x.kind === 'desktop-pair' && x.code === body.code && !x.used && new Date(x.expires_at) > new Date());
    if (!s) return json(res, 400, { error: 'Invalid or expired pairing code' });
    await update('sessions', (x) => x.id === s.id && !x.used, {
      used: true, claimed_by: user.id, linked_token: token,
      linked_user: authx.sanitizeUser(user), claimed_at: new Date().toISOString()
    });
    return json(res, 200, { ok: true });
  }
  if (op === 'status') {
    if (typeof body.device_secret !== 'string' || !/^[a-f0-9]{64}$/.test(body.device_secret)) return json(res, 403, { error: 'Device proof required. Restart desktop sign-in.' });
    const id = 'pair_' + await sha256(body.device_secret);
    const s = await findOne('sessions', (x) => x.id === id && x.kind === 'desktop-pair' && x.code === body.code && new Date(x.expires_at) > new Date());
    if (!s) return json(res, 404, { error: 'Pairing expired or already collected' });
    if (!s.used) return json(res, 200, { ok: true, claimed: false });
    const user = await authx.findByToken(s.linked_token);
    if (!user || user.id !== s.claimed_by) return json(res, 401, { error: 'Linked session expired' });
    // Collect once; global server credentials must never leave the server.
    await remove('sessions', (x) => x.id === s.id);
    return json(res, 200, { ok: true, claimed: true, token: s.linked_token, user: authx.sanitizeUser(user), user_id: user.id });
  }
  return json(res, 400, { error: 'unknown pair op' });
}

async function handleUpdateCheck(body, res) {
  try {
    const r = await fetch('https://api.github.com/repos/ThaddeusHackz/ANTICODEX/releases/latest', {
      headers: { 'User-Agent': 'ANTICODEX-Updater', Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) return json(res, 200, { ok: false, error: `github ${r.status}` });
    const rel = await r.json();
    return json(res, 200, {
      ok: true,
      version: (rel.tag_name || '').replace(/^v/, ''),
      notes: rel.body || '',
      published_at: rel.published_at,
      assets: (rel.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }))
    });
  } catch (e) {
    return json(res, 200, { ok: false, error: String(e.message || e) });
  }
}
