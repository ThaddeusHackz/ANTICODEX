import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { buildImportPlan, planToRows, exportCodexConfig } from '../lib/configimport.js';
import { loadSkills, skillInstructions, resolveSkillMentions, extractSkillArchive, readSkillArchive, parseSkillsManifest } from '../lib/skills.js';
import { startEgressProxy, checkEgress, normalizeEgressPolicy, EGRESS_MODES, DEFAULT_ALLOW, egressEnv } from '../lib/egress.js';
import { discoverAgentDocs, describePolicy, normalizeSandboxPolicy, normalizeApprovalPolicy, decideApproval, SANDBOX_MODES, APPROVAL_MODES } from '../lib/workspace.js';
import { getPolicy, savePolicy, normalizePolicy, POLICY_FLAGS, policyAllows, describeWorkspacePolicy } from '../lib/policy.js';
import { MCP_CATALOG, McpClient, createClient, stdioSpec, isLocalMcp, probeServer, discoverAuth, registerClient, buildAuthorizeUrl, exchangeCode, refreshToken, pkcePair, collectTools, executeTool } from '../lib/mcp.js';
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
        if (!auth && !isDesktopLocal(req)) return json(res, 401, { error: 'sign in to test an endpoint', sign_in: '/login' });
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
      case 'mcp': return await handleMcp(body, res, req);
      case 'policy': return await handlePolicy(req, body, res);
      case 'import_config': return await handleImportConfig(req, body, res);
      case 'workspace': return await handleWorkspace(req, body, res);
      case 'skills': return await handleSkills(req, body, res);
      case 'egress': return await handleEgress(req, body, res);
      case 'export_config': return handleExportConfig(body, res);
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
  const expected = `adm_${await sha256(`${getKey('ADMIN_USERNAME') || 'Thaddeusadmin'}:${getKey('ADMIN_PASSWORD') || 'Thaddeusk12'}:anticodex`)}`;
  const sent = body?.token || (req?.headers?.['x-admin-token'] || '');
  return Boolean(sent) && sent === expected;
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
  const user = await authx.findByToken(auth) || await findOne('users', (u) => u.id === auth);
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
  const mine = (row) => row && (row.user_id === auth || (owner && (row.user_id === owner.id || row.user_email === owner.email)));
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

// A local MCP server (REA) is a child process. Serverless deployments cannot
// spawn one, and pretending otherwise is how a connector ends up looking
// "connected" while every tool call fails. Say so instead.
function canSpawnLocalMcp() {
  return !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME && !process.env.NETLIFY;
}

/** An MCP connection that would spawn a process on this machine. */
function isSpawnable(conn) {
  return isLocalMcp(conn?.url) || (conn?.stdio && /^(stdio|local):/.test(conn.url || ''));
}

/** Loopback + a process-capable host. An imported command from a user config is
 *  only ever run for the machine it came from, never for a remote caller. */
function localSpawnAllowed(req, conn) {
  if (!canSpawnLocalMcp()) return false;
  if (!isLoopback(req)) return false;
  if (conn && !stdioSpec(conn.url) && !conn.stdio) return false;
  return true;
}

async function currentUser(req, body) {
  const auth = (req?.headers?.authorization || '').replace(/^Bearer\s+/i, '') || body?.token;
  return auth ? authx.findByToken(auth) : null;
}

function noLocalMcpServer(why) {
  if (why === 'policy') {
    return {
      ok: false, error: 'Local MCP servers are turned off by your policy.',
      fix: 'Settings → Policy → turn on “Local MCP servers”, then connect again.',
      local_capable: true, blocked_by: 'policy'
    };
  }
  return {
    ok: false,
    error: 'This MCP server runs on your machine, so it needs the ANTICODEX desktop app (or a self-hosted `npm start`) — a serverless deployment cannot spawn a local process, and a remote caller is never allowed to run your commands.',
    fix: 'Open ANTICODEX desktop, or run the app locally, then connect REA again.',
    local_capable: false, blocked_by: 'environment'
  };
}

/** null = allowed, otherwise the refusal body to send. */
async function localRefusal(req, conn) {
  if (!canSpawnLocalMcp()) return 'environment';
  if (!isLoopback(req)) return 'environment';
  if (conn && !stdioSpec(conn.url) && !conn.stdio) return 'environment';
  const user = await currentUser(req, {});
  if (user && !policyAllows(await getPolicy(user.email), 'allow_local_mcp')) return 'policy';
  return null;
}

async function handleMcp(body, res, req) {
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
    if (isLocalMcp(body.url)) {
      const why = await localRefusal(req);
      if (why) return json(res, 200, noLocalMcpServer(why));
    }
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

    // Local (stdio) servers have no authorization server: connect = handshake.
    if (isLocalMcp(url)) {
      const why = await localRefusal(req);
      if (why) return json(res, 200, noLocalMcpServer(why));
      try {
        const probe = await probeServer(url);
        const spec = stdioSpec(url);
        const row = {
          id: body.connection_id || spec.id, name: probe.server?.name || spec.name || url,
          url, status: 'connected', enabled: true, local: true,
          tools: probe.tools, prompts: probe.prompts,
          server_version: probe.server?.version || null,
          protocol_version: probe.protocolVersion || null,
          connected_at: Date.now()
        };
        const existing = await findOne('mcp_connections', (x) => x.id === row.id);
        if (existing) await update('mcp_connections', (x) => x.id === row.id, row);
        else await insert('mcp_connections', row);
        return json(res, 200, { ok: true, connected: true, connection: row });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e), local: true });
      }
    }

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
    if (isSpawnable(conn)) {
      const why = await localRefusal(req, conn);
      if (why) return json(res, 200, noLocalMcpServer(why));
    }
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
      if (isSpawnable(conn)) {
        const why = await localRefusal(req, conn);
        if (why) return json(res, 200, noLocalMcpServer(why));
      }
      const client = createClient(conn);
      try {
        await client.initialize();
        const result = await client.callTool(body.tool, body.args || {});
        return json(res, 200, { ok: true, tool: body.tool, result });
      } finally {
        await client.close().catch(() => {});
      }
      return json(res, 200, { ok: true, tool: body.tool, result });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  return json(res, 400, { error: 'unknown mcp op' });
}

// --- policy ----------------------------------------------------------------


// --- egress ---------------------------------------------------------------
//
// The sandboxed-work story both desktop apps ship at a different layer: Codex
// gives the command runner a reduced token, Claude's `cowork-svc` gives it its
// own user-mode network. Here it is an allowlisting HTTP/CONNECT proxy plus the
// environment that points a spawned process at it. Starting one binds a port on
// this machine, so it is gated exactly like a local MCP server.

let egressProxy = null;

async function handleEgress(req, body, res) {
  try {
    return await egressOp(req, body, res);
  } catch (e) {
    // A bad mode or host is the caller's mistake, not ours: say which field.
    return json(res, 400, { ok: false, code: e.code || 'InvalidPolicy', error: String(e.message || e) });
  }
}

async function egressOp(req, body, res) {
  const op = body.op || 'status';
  const local = canSpawnLocalMcp() && isLoopback(req);

  if (op === 'presets') {
    return json(res, 200, { ok: true, modes: EGRESS_MODES, default_allow: DEFAULT_ALLOW, local });
  }

  if (op === 'check') {
    const policy = normalizeEgressPolicy({ mode: body.mode || 'allowlist', allow: body.allow || DEFAULT_ALLOW, deny: body.deny || [] });
    return json(res, 200, { ok: true, host: body.host, ...checkEgress(policy, body.host) });
  }

  if (op === 'status') {
    return json(res, 200, {
      ok: true,
      running: Boolean(egressProxy),
      local,
      url: egressProxy ? egressProxy.url : null,
      env: egressProxy ? egressProxy.env : egressEnv(0),
      ...(egressProxy ? egressProxy.stats() : { policy: normalizeEgressPolicy({ mode: 'off' }), allowed: 0, denied: 0, open_tunnels: 0, last: [] }),
      note: local ? null : 'Starting an egress proxy listens on the machine that runs the app — open the desktop build or a local `npm start`.'
    });
  }

  if (!local) {
    return needsLocal(res, 'An egress proxy listens on this machine, so it needs the desktop app or a local `npm start`.');
  }

  if (op === 'start') {
    const wanted = normalizeEgressPolicy({
      mode: body.mode || 'allowlist',
      allow: body.allow && body.allow.length ? body.allow : DEFAULT_ALLOW,
      deny: body.deny || []
    });
    if (egressProxy) {
      return json(res, 200, { ok: true, reused: true, url: egressProxy.url, port: egressProxy.port, env: egressProxy.env, ...egressProxy.stats(), policy: egressProxy.setPolicy(wanted) });
    }
    egressProxy = await startEgressProxy({ policy: wanted, port: Number(body.port) || 0 });
    return json(res, 200, { ok: true, url: egressProxy.url, port: egressProxy.port, env: egressProxy.env, ...egressProxy.stats() });
  }

  if (op === 'update') {
    if (!egressProxy) return json(res, 409, { ok: false, error: 'egress is not running' });
    const next = egressProxy.setPolicy({ mode: body.mode || 'allowlist', allow: body.allow || [], deny: body.deny || [] });
    return json(res, 200, { ok: true, policy: next, ...egressProxy.stats() });
  }

  if (op === 'stop') {
    if (!egressProxy) return json(res, 200, { ok: true, stopped: false });
    const stats = egressProxy.stats();
    await egressProxy.close();
    egressProxy = null;
    return json(res, 200, { ok: true, stopped: true, allowed: stats.allowed, denied: stats.denied });
  }

  return json(res, 400, { error: 'unknown egress op' });
}

// --- skills -----------------------------------------------------------------
//
// Discovery follows Codex's model: a root is a directory named `skills`, a skill
// is a subdirectory with a `SKILL.md`, a broken one is an error entry rather than
// a silent omission, and an earlier root shadows a later one by name.
//
// The repository's own `skills/` is part of the deployment, so it is readable
// anywhere. This machine's `~/.codex` and `~/.claude` are a filesystem read on
// the host, so — like AGENTS.md — they are only included for a loopback caller.

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function handleSkills(req, body, res) {
  const op = body.op || 'list';
  const local = canSpawnLocalMcp() && isLoopback(req);
  const extra = [path.join(REPO_ROOT, 'skills')];
  if (local && Array.isArray(body.extra_roots)) {
    for (const r of body.extra_roots.slice(0, 10)) if (typeof r === 'string') extra.push(r);
  }

  // Packaged `.skill` archives are read from a directory the caller names (and,
  // for a local caller, from this repo's own `skills/`). Listing never extracts
  // anything; `install` is the only op that writes.
  const archives = [path.join(REPO_ROOT, 'skills')];
  if (local && Array.isArray(body.archive_roots)) {
    for (const r of body.archive_roots.slice(0, 10)) if (typeof r === 'string') archives.push(r);
  }

  const loaded = loadSkills({
    cwd: local ? (body.cwd || REPO_ROOT) : null,
    codexHome: local ? body.codex_home : null,
    claudeHome: local ? body.claude_home : null,
    extra,
    archives
  });

  if (op === 'list') {
    return json(res, 200, {
      ok: true,
      local,
      count: loaded.count,
      skills: loaded.skills.map((s) => ({
        name: s.name, description: s.description, short_description: s.short_description ?? null,
        scope: s.scope, root_label: s.root_label, path: s.path_to_skills_md,
        bytes: s.bytes, allow_implicit_invocation: s.allow_implicit_invocation,
        dependencies: s.dependencies, products: s.products,
        packaged: Boolean(s.packaged), archive: s.archive || null,
        archive_bytes: s.archive_bytes ?? null, archive_files: s.archive_files ?? null,
        tier: s.tier ?? null, license: s.license ?? null
      })),
      errors: loaded.errors,
      duplicates: loaded.duplicates,
      roots: loaded.roots,
      note: local ? null : 'Only the bundled repository skills are visible here — open the desktop app (or run locally) to see this machine\'s ~/.codex and ~/.claude skills.'
    });
  }

  if (op === 'get') {
    const skill = loaded.skills.find((s) => s.name === body.name);
    if (!skill) return json(res, 404, { ok: false, error: `no skill named ${body.name}` });
    return json(res, 200, { ok: true, skill, instructions: skillInstructions(skill) });
  }

  if (op === 'resolve') {
    const matched = resolveSkillMentions(body.text || '', loaded.skills);
    return json(res, 200, {
      ok: true,
      matched: matched.map((s) => ({ name: s.name, instructions: skillInstructions(s) }))
    });
  }

  // Inspect one archive without installing it (size, entries, manifest entry).
  if (op === 'archive') {
    if (!local) return needsLocal(res, 'Reading a .skill file is a filesystem read on your machine.');
    const file = String(body.file || '');
    if (!path.isAbsolute(file) || !file.toLowerCase().endsWith('.skill')) {
      return json(res, 400, { ok: false, error: 'file must be an absolute path to a .skill archive' });
    }
    const one = readSkillArchive(file);
    return json(res, 200, {
      ok: one.errors.length === 0, archive: file,
      skills: one.skills.map((s) => ({ name: s.name, description: s.description, tier: s.tier, license: s.license, files: s.archive_files, bytes: s.bytes })),
      errors: one.errors
    });
  }

  // Install a `.skill` archive into this machine's skill root. This writes, so it
  // is desktop/local-only, and it refuses to overwrite an existing skill unless
  // the caller says so explicitly.
  if (op === 'install') {
    if (!local) return needsLocal(res, 'Installing a .skill writes to this machine, so it needs the desktop app or a local `npm start`.');
    const file = String(body.file || '');
    if (!path.isAbsolute(file) || !file.toLowerCase().endsWith('.skill')) {
      return json(res, 400, { ok: false, error: 'file must be an absolute path to a .skill archive' });
    }
    const dest = body.dest ? String(body.dest) : path.join(os.homedir(), '.codex', 'skills');
    if (!path.isAbsolute(dest)) return json(res, 400, { ok: false, error: 'dest must be an absolute directory' });
    try {
      const result = extractSkillArchive(file, dest, { overwrite: body.overwrite === true });
      return json(res, 200, { ok: true, ...result, dest });
    } catch (e) {
      return json(res, e.code === 'Exists' ? 409 : 400, { ok: false, code: e.code || 'InstallFailed', error: String(e.message || e) });
    }
  }

  if (op === 'manifest') {
    if (!local) return needsLocal(res, 'Reading a skills manifest is a filesystem read on your machine.');
    const dir = body.dir ? String(body.dir) : path.join(REPO_ROOT, 'skills');
    if (!path.isAbsolute(dir)) return json(res, 400, { ok: false, error: 'dir must be absolute' });
    const text = (() => { try { return fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'); } catch { return null; } })();
    return json(res, 200, { ok: true, dir, manifest: parseSkillsManifest(text) });
  }

  return json(res, 400, { error: 'unknown skills op' });
}

/** One shape for "this needs a real machine" refusals. */
function needsLocal(res, error) {
  return json(res, 200, { ok: false, needs_local: true, error });
}

// --- workspace (AGENTS.md, sandbox, approval) --------------------------------
//
// Reading a caller-supplied directory is a filesystem read on *this* machine, so
// it is gated exactly like a local MCP server: loopback + a process-capable host.
// A hosted deployment answers with `needs_local` instead of reading the server's
// own disk for a remote caller.

async function handleWorkspace(req, body, res) {
  const op = body.op || 'context';
  const user = await currentUser(req, body);

  if (op === 'context') {
    const cwd = body.cwd || process.cwd();
    if (!canSpawnLocalMcp() || !isLoopback(req)) {
      return json(res, 200, {
        ok: false, needs_local: true,
        error: 'Reading AGENTS.md is a filesystem read on your machine — it needs the desktop app or a local `npm start`.',
        sandbox_modes: SANDBOX_MODES, approval_modes: APPROVAL_MODES
      });
    }
    let isDir = false;
    try { isDir = fs.statSync(cwd).isDirectory(); } catch { isDir = false; }
    if (!isDir) return json(res, 400, { ok: false, error: `not a directory: ${cwd}` });

    const found = discoverAgentDocs({
      cwd,
      codexHome: body.codex_home,
      stopAt: body.root,
      nestedPaths: Array.isArray(body.nested_paths) ? body.nested_paths : []
    });
    const policy = await getPolicy(user?.email);
    const sandbox = body.sandbox ? normalizeSandboxPolicy(body.sandbox) : policy.defaults.sandbox_policy;
    const approval = body.approval ? normalizeApprovalPolicy(body.approval) : policy.defaults.approval_policy;
    return json(res, 200, {
      ok: true,
      cwd,
      documents: found.docs,
      instructions: found.instructions,
      composed: found.composed,
      bytes: found.bytes,
      truncated: found.truncated,
      max_bytes: found.max_bytes,
      sandbox,
      approval,
      describe: describePolicy({ sandbox, approval }),
      sandbox_modes: SANDBOX_MODES,
      approval_modes: APPROVAL_MODES,
      decisions: {
        read: decideApproval({ sandbox, approval, action: 'read' }),
        write: decideApproval({ sandbox, approval, action: 'write' }),
        exec: decideApproval({ sandbox, approval, action: 'exec' }),
        network: decideApproval({ sandbox, approval, action: 'network' })
      }
    });
  }

  if (op === 'set') {
    if (!user) return json(res, 401, { error: 'sign in to save workspace policy' });
    const current = await getPolicy(user.email);
    const patch = {
      ...current,
      defaults: {
        ...current.defaults,
        ...(body.sandbox !== undefined ? { sandbox_policy: normalizeSandboxPolicy(body.sandbox) } : {}),
        ...(body.approval !== undefined ? { approval_policy: normalizeApprovalPolicy(body.approval) } : {})
      }
    };
    const saved = await savePolicy(user.email, normalizePolicy(patch));
    return json(res, 200, { ok: true, ...saved, describe: describeWorkspacePolicy(saved.policy) });
  }

  return json(res, 400, { error: 'unknown workspace op' });
}

/** Emit a `~/.codex/config.toml` body from what this product already knows. */
function handleExportConfig(body, res) {
  try {
    const toml = exportCodexConfig(body.state || body);
    return json(res, 200, { ok: true, filename: 'config.toml', toml, bytes: Buffer.byteLength(toml) });
  } catch (e) {
    return json(res, 200, { ok: false, error: String(e.message || e) });
  }
}

async function handlePolicy(req, body, res) {
  const user = await currentUser(req, body);
  const op = body.op || 'get';
  if (op === 'get') {
    const policy = await getPolicy(user?.email);
    return json(res, 200, {
      ok: true,
      signed_in: Boolean(user),
      policy,
      flags: POLICY_FLAGS,
      note: user ? null : 'Showing the defaults — sign in to save your own policy.'
    });
  }
  if (op === 'set') {
    if (!user) return json(res, 401, { error: 'sign in to change policy' });
    const saved = await savePolicy(user.email, normalizePolicy(body.patch || body.policy || {}));
    return json(res, 200, { ok: true, ...saved, flags: POLICY_FLAGS });
  }
  return json(res, 400, { error: 'unknown policy op' });
}

// --- bring your own setup (Codex config.toml / Claude settings) -------------

/**
 * Dry-run by default. `apply:true` stores what is safe to store and returns the
 * rest for the client (custom providers and model aliases are a per-device
 * choice in this product, so they are not written into the account ledger).
 *
 * Secrets: a `.claude/settings.json` env token is reported as a boolean
 * (`has_token`) and never echoed back or persisted.
 */
async function handleImportConfig(req, body, res) {
  const plan = buildImportPlan({
    codex_toml: body.codex_toml,
    claude_settings: body.claude_settings,
    claude_policy: body.claude_policy
  });
  if (!plan.ok) return json(res, 400, plan);

  const rows = planToRows(plan);
  const out = {
    ok: true,
    mode: body.apply ? 'applied' : 'plan',
    summary: plan.summary,
    warnings: plan.warnings,
    providers: rows.providers,
    connections: rows.connections.map((c) => ({
      id: c.id, name: c.name, url: c.url, transport: c.stdio ? 'stdio' : 'http',
      ...(c.stdio ? { command: [c.stdio.command, ...(c.stdio.args || [])].join(' '), env_vars: c.env_vars } : {}),
      needs_local: Boolean(c.stdio)
    })),
    aliases: rows.aliases,
    flags: rows.flags,
    behaviour: plan.codex?.behaviour || null,
    migrations: plan.codex?.migrations || [],
    sandbox: plan.codex?.sandbox || null,
    notify_hook: plan.codex?.notify_hook || null
  };

  if (!body.apply) {
    out.note = 'Nothing was written. Approve to connect these servers and apply these flags.';
    return json(res, 200, out);
  }

  const user = await currentUser(req, body);
  if (!user) return json(res, 401, { error: 'sign in to apply an import' });

  const applied = [];
  const skipped = [];
  for (const c of rows.connections) {
    const spawnable = Boolean(c.stdio);
    if (spawnable && (await localRefusal(req, c))) {
      skipped.push({ id: c.id, reason: 'this server needs a command to run on your machine — open ANTICODEX desktop to use it' });
      continue;
    }
    const existing = await findOne('mcp_connections', (x) => x.id === c.id);
    const row = { ...c, status: 'disconnected', enabled: true, imported_at: new Date().toISOString() };
    if (existing) await update('mcp_connections', (x) => x.id === c.id, row);
    else await insert('mcp_connections', row);
    applied.push({ kind: 'mcp', id: c.id, name: c.name, transport: row.stdio ? 'stdio' : 'http' });
  }

  if (rows.flags.length) {
    const patch = { flags: Object.fromEntries(rows.flags.map((f) => [f.key, f.allowed])) };
    const saved = await savePolicy(user.email, normalizePolicy({ ...(await getPolicy(user.email)), ...patch }));
    applied.push({ kind: 'policy', flags: rows.flags.length, persisted: saved.persisted });
  }

  return json(res, 200, {
    ...out, mode: 'applied', applied, skipped,
    note: 'Providers and model aliases are returned for this device to add — they are not stored on your account.'
  });
}

// --- admin ------------------------------------------------------------------

async function handleAdmin(body, res) {
  const op = body.op || 'login';
  const expectedUser = getKey('ADMIN_USERNAME') || 'Thaddeusadmin';
  const expectedPass = getKey('ADMIN_PASSWORD') || 'Thaddeusk12';

  if (op === 'login') {
    const ok = timingSafeEqual(body.username || '', expectedUser) && timingSafeEqual(body.password || '', expectedPass);
    if (!ok) return json(res, 401, { error: 'Invalid admin credentials' });
    const token = `adm_${await sha256(expectedUser + ':' + expectedPass + ':anticodex')}`;
    await audit({ type: 'admin_login', ip: 'admin' });
    return json(res, 200, { ok: true, token });
  }

  const token = body.token || '';
  const valid = token === `adm_${await sha256(expectedUser + ':' + expectedPass + ':anticodex')}`;
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
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await insert('sessions', {
      id: uid('pair'), kind: 'desktop-pair', code, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), used: false
    });
    return json(res, 200, { code, expires_in: 600 });
  }
  if (op === 'adopt') {
    // The desktop app links a website-issued session into its own local ledger
    // so /me, threads and per-user keys work offline. Loopback only.
    if (!isLoopback(req)) return json(res, 403, { error: 'desktop-local op' });
    const out = await authx.adoptSession({ token: body.token, user: body.user });
    return json(res, 200, out);
  }
  if (op === 'claim') {
    // Called by the website after the user signs in (email or GitHub).
    const s = await findOne('sessions', (x) => x.kind === 'desktop-pair' && x.code === body.code && !x.used && new Date(x.expires_at) > new Date());
    if (!s) return json(res, 400, { error: 'Invalid or expired pairing code' });
    await update('sessions', (x) => x.id === s.id, {
      used: true, claimed_by: body.user_id || 'desktop',
      linked_token: body.user_token || null, linked_user: body.user || null,
      claimed_at: new Date().toISOString()
    });
    return json(res, 200, { ok: true, token: body.user_token || `dsk_${s.id}` });
  }
  if (op === 'status') {
    // Desktop polls this until the website claims the code. Once claimed, the
    // desktop receives the service keychain so it works identically to the site.
    const s = await findOne('sessions', (x) => x.kind === 'desktop-pair' && x.code === body.code);
    if (!s) return json(res, 404, { error: 'unknown code' });
    if (!s.used) return json(res, 200, { ok: true, claimed: false, expires_in: Math.max(0, Math.round((new Date(s.expires_at) - new Date()) / 1000)) });
    // Only provider/media keys travel to the desktop. Admin, owner and
    // service-level secrets (Supabase service role, OAuth secret, state
    // signing key) stay on the server.
    const NEVER_PAIR = /^(ADMIN_|OWNER_|BOOTSTRAP_|AUTH_STATE_SECRET$|SUPABASE_.*SERVICE.*$|.*SECRET$)/i;
    const service_keys = {};
    for (const k of allKeyEnvs()) {
      const v = getKey(k);
      if (v && !NEVER_PAIR.test(k) && !String(k).startsWith('ADMIN_')) service_keys[k] = v;
    }
    // The account's own keys replace the built-ins for this user.
    const ownKeys = await userKeyMap(s.linked_user?.email);
    Object.assign(service_keys, ownKeys);
    return json(res, 200, { ok: true, claimed: true, token: s.linked_token, user: s.linked_user, user_id: s.claimed_by, service_keys });
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
