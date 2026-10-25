import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, readBody } from '../lib/util.js';
import { listProviders, chat, chatStream, probeModel, testEndpoint, directoryWithStatus, syncModels, resolveModelRef, modelIndex, explainProviderError, pickLiveModel, liveAlternatives, normalizeProviderDefs, isPrivateGateway, PROVIDER_DEFS_KEY } from '../lib/providers.js';
import { allHealth, clearHealth, summary as healthSummary, modelRef } from '../lib/model-health.js';
import {
  ENGINE_HELP,
  REA_CLIENTS,
  REA_SERVER_NAME,
  buildArgs as reaArgs,
  buildDoctorArgs as reaDoctorArgs,
  checkRegistration,
  describeAction as describeReaAction,
  envOnlyEngines,
  missingEngines,
  nodeStatus as reaNodeStatus,
  parseDoctorOutput,
  parseSetupOutput,
  planFingerprint,
  runRea
} from '../lib/rea.js';
import {
  QODER_AGENT_REF,
  QODER_PAT_ENVS,
  QCA_BASE,
  createAcpClient,
  agentPrompt,
  explainAcpError,
  isAgentRef,
  qcaEvents,
  qcaPage,
  qcaRequest,
  qcaStream,
  qcaUrl,
  qoderActionWorkflow,
  qoderCliStatus,
  qoderStatus,
  refreshQoderCli,
  streamAcpAnswer
} from '../lib/qoder.js';
import { QODER_REPOS, atlasTally as qoderAtlasTally } from '../lib/qoder-repos.js';
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
import {
  ARTIFACT_KINDS,
  discoverTemplates,
  extensionOf,
  familyOf,
  normalizeRequest,
  offer,
  resolveSelection,
  templateRoots
} from '../lib/artifacts.js';
import { discoverAgentDocs, describePolicy, normalizeSandboxPolicy, normalizeApprovalPolicy, decideApproval, SANDBOX_MODES, APPROVAL_MODES } from '../lib/workspace.js';
import { getPolicy, savePolicy, normalizePolicy, POLICY_FLAGS, policyAllows, describeWorkspacePolicy } from '../lib/policy.js';
import { MCP_CATALOG, McpClient, createClient, stdioSpec, isLocalMcp, probeServer, discoverAuth, registerClient, buildAuthorizeUrl, exchangeCode, refreshToken, pkcePair, collectTools, executeTool } from '../lib/mcp.js';
import { toolsFor, forgetTools, toolCacheSummary } from '../lib/tool-cache.js';
import { sandboxStatus, runSandbox, readSandboxFile, clearSandbox, listRuns } from '../lib/sandbox.js';
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
        // A local agent is a provider with no key: detecting it costs one
        // `qodercli --version` (cached for five minutes), and only a machine
        // that can spawn processes is asked.
        if (canSpawnLocalMcp() && isLoopback(req)) await refreshQoderCli().catch(() => {});
        // Whose keys count: the account on this request, then any explicit keys
        // (the desktop keychain sends those). Without this the UI could not see
        // a per-user key and reported a configured provider as "needs key".
        const keys = await mergedKeys(req, body);
        const mine = new Set(await accountKeyEnvs(req, body));
        const own = (p) => (mine.has(p.key_env) ? 'you' : (p.configured ? 'shared' : null));
        return json(res, 200, {
          providers: listProviders(keys).map((p) => ({ id: p.id, name: p.name, configured: p.configured, kind: p.kind, key_env: p.key_env, key_owner: own(p), models: p.models })),
          directory: directoryWithStatus(keys),
          picker: modelIndex(keys, { includeHidden: body.include_hidden === true, strictLive: body.strict_live !== false }),
          health: healthSummary(),
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
      case 'artifacts': return await handleArtifacts(req, body, res);
      case 'chat_stream': return await handleChatStream(req, res, body);
      case 'model_health': return await handleModelHealth(req, body, res);
      case 'rea': return await handleRea(req, body, res);
      case 'qoder': return await handleQoder(req, body, res);
      case 'sandbox': return await handleSandbox(req, body, res);
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

// A chosen artifact template travels with the turn as three short strings. It is
// model-facing text, so it is flattened and capped: a template title must not be
// able to smuggle instructions (or a newline-delimited fake system block) into
// the prompt.
function normalizeChatTemplate(template) {
  if (!template || typeof template !== 'object') return null;
  const clean = (value, max) =>
    typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '';
  const title = clean(template.title, 120);
  const artifactKind = clean(template.artifact_kind, 32);
  const skillName = clean(template.skill_name, 120);
  if (!title || !ARTIFACT_KINDS.has(artifactKind)) return null;
  return { title, artifactKind, skillName };
}

function withTemplate(system, template) {
  if (!template) return system;
  const line = `The user picked the "${template.title}" ${template.artifactKind} template${
    template.skillName ? ` (skill ${template.skillName})` : ''
  }; follow its structure and styling.`;
  return [system, line].filter(Boolean).join('\n');
}

async function handleChat(body, res, req) {
  const { messages, model, system, temperature, max_tokens, images, provider, use_mcp, effort } = body;
  const systemPrompt = withTemplate(system, normalizeChatTemplate(body.template));
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
      // Cached schemas, and never on the critical path: see lib/tool-cache.js.
      const listed = conns.length ? await toolsFor(conns) : { tools: [] };
      const tools = [...builtins, ...listed.tools].slice(0, 40);
      if (tools.length) {
        let out;
        try {
          out = await chat({ messages: msgs, model, system: systemPrompt, temperature, max_tokens, provider, keys, tools, effort });
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
            next = await chat({ messages: msgs, model, system: systemPrompt, temperature, max_tokens, provider, keys, tools });
          } catch (e) { return json(res, 200, (await describeChatFailure(e, provider, model, keys)).payload); }
          Object.assign(out, next);
          if (!next.tool_calls?.length) break;
        }
        return json(res, 200, out);
      }
    }
  }
  try {
    const out = await chat({ messages: msgs, model, system: systemPrompt, temperature, max_tokens, provider, keys });
    return json(res, 200, out);
  } catch (e) {
    const { payload, retry_with } = await describeChatFailure(e, provider, model, keys);
    if (retry_with) {
      try {
        const again = await chat({ messages: msgs, model: retry_with, system: systemPrompt, temperature, max_tokens, provider, keys });
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

  if (op === 'list') return json(res, 200, { connections: await find('mcp_connections', () => true, 500), tool_cache: toolCacheSummary() });

  if (op === 'save') {
    const c = { ...body.connection, id: body.connection?.id || uid('mcp'), updated_at: new Date().toISOString() };
    const existing = await findOne('mcp_connections', (x) => x.id === c.id);
    if (existing) await update('mcp_connections', (x) => x.id === c.id, c);
    else await insert('mcp_connections', { status: 'disconnected', enabled: true, permissions: { tools: true, resources: true, prompts: true, read: true, write: false }, ...c });
    // Its tool list may have changed with it; the next chat re-reads once.
    forgetTools();
    return json(res, 200, { ok: true, connection: c });
  }

  if (op === 'delete') {
    await remove('mcp_connections', (x) => x.id === body.id);
    forgetTools();
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



// --- streamed chat ------------------------------------------------------------
//
// The old chat call answered once, at the end: nothing on screen for a minute,
// and no way to tell a slow model from a dead one. This is the same request with
// server-sent events: phases, a heartbeat every few seconds, then deltas.
//
// Events (one JSON object per `data:` line):
//   {type:'phase', phase}        contacting → connected → streaming
//   {type:'heartbeat', elapsed_ms, waiting_on}
//   {type:'delta', text}
//   {type:'tool', name, ok}      only when a connected MCP server is driven
//   {type:'done', elapsed_ms, first_token_ms, chars, model}
//   {type:'error', error, state} or {type:'aborted'}

function sse(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    send(obj) {
      if (closed) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { closed = true; }
    },
    end() { if (!closed) { try { res.end(); } catch { /* gone */ } closed = true; } },
    get closed() { return closed; }
  };
}

async function handleChatStream(req, res, body) {
  const { messages, model, system, temperature, max_tokens, images, provider, use_mcp, effort } = body;
  const stream = sse(res);
  const controller = new AbortController();
  // The client hanging up is the cancel button; stop paying for tokens.
  req.on('close', () => controller.abort());

  let msgs = (messages || []).map((m) => ({ ...m, images: m.images || (m.role === 'user' ? images : undefined) }));
  const systemPrompt = withTemplate(system, normalizeChatTemplate(body.template));

  // A local agent instead of an HTTP model. Same SSE frames, so Chat renders it
  // exactly like any other answer — including the reasoning panel.
  if (isAgentRef(model)) {
    const t0 = Date.now();
    const local = canSpawnLocalMcp() && isLoopback(req);
    if (!local) {
      stream.send({ type: 'error', state: 'local', error: 'The Qoder CLI agent runs on the machine you are using — open the desktop app, or run this server locally.' });
      return stream.end();
    }
    const cli = await refreshQoderCli().catch(() => null);
    if (!cli?.found) {
      stream.send({
        type: 'error', state: 'install',
        error: cli?.timed_out ? '`qodercli --version` did not answer, so the agent was not started.' : 'qodercli is not installed on this machine.',
        fix: cli?.install || 'npm i -g @qoder-ai/qodercli',
        next: 'Sign in once with `qodercli login`, then ask again.'
      });
      return stream.end();
    }
    const promptText = agentPrompt({ system: systemPrompt, messages: msgs });
    if (!promptText) {
      stream.send({ type: 'error', state: 'input', error: 'Nothing to send: the message is empty.' });
      return stream.end();
    }
    stream.send({ type: 'phase', phase: 'contacting', ref: QODER_AGENT_REF, at: t0 });
    let chars = 0;
    let textOut = '';
    let thinkingChars = 0;
    try {
      for await (const evt of streamAcpAnswer({
        text: promptText,
        cwd: os.tmpdir(),
        signal: controller.signal,
        allowTools: body.allow_tools === true
      })) {
        if (controller.signal.aborted) break;
        if (evt.type === 'delta') { chars += evt.text.length; textOut += evt.text; }
        if (evt.type === 'thinking') thinkingChars += evt.text.length;
        if (evt.type === 'done') break;
        stream.send(evt);
      }
      if (controller.signal.aborted) { stream.send({ type: 'aborted' }); return stream.end(); }
      stream.send({
        type: 'done', elapsed_ms: Date.now() - t0, chars,
        reasoning_chars: thinkingChars || null,
        model: QODER_AGENT_REF, agent: 'qodercli', text: textOut
      });
    } catch (e) {
      if (controller.signal.aborted) { stream.send({ type: 'aborted' }); return stream.end(); }
      const auth = e?.code === -32000 && /auth/i.test(String(e.message || ''));
      stream.send({
        type: 'error', state: auth ? 'auth' : 'agent',
        error: explainAcpError(e),
        ...(auth ? { fix: 'Run `qodercli login` on this machine, or set QODER_PERSONAL_ACCESS_TOKEN.' } : {})
      });
    }
    return stream.end();
  }
  let keys;
  try { keys = await mergedKeys(req, body); } catch (e) {
    stream.send({ type: 'error', error: String(e.message || e), state: 'auth' });
    return stream.end();
  }

  if (provider && (keys.__provider_defs_dropped_ids__ || []).includes(provider)) {
    stream.send({ type: 'error', state: 'endpoint', error: `"${provider}" points at a private or local-network address, so this server will not connect to it.` });
    return stream.end();
  }

  // Tools, if the user has connected any. Streaming with tools means the first
  // leg can end in tool calls: those are emitted as events, run here, and the
  // answer is streamed on the next leg.
  let tools = [];
  let conns = [];
  if (use_mcp !== false) {
    try {
      conns = (await find('mcp_connections', (c) => c.status === 'connected' && c.enabled !== false, 50)).slice(0, 12);
      const builtins = builtinTools();
      if (conns.length || builtins.length) {
        const listed = conns.length ? await toolsFor(conns) : { tools: [] };
        tools = [...builtins, ...listed.tools].slice(0, 40);
        // Cold cache: say so once, so "why did the tool not run this time" has an
        // answer that is not a guess.
        if (listed.warming) stream.send({ type: 'phase', phase: 'tools-warming', detail: 'reading MCP tool lists in the background — this answer goes without them' });
      }
    } catch { tools = []; }
  }

  try {
    let out = await chatStream(
      { messages: msgs, model, system: systemPrompt, temperature, max_tokens, provider, keys, effort, tools: tools.length ? tools : undefined },
      { onEvent: (evt) => stream.send(evt), signal: controller.signal }
    );
    if (out?.aborted) return stream.end();

    let rounds = 0;
    while (out?.tool_calls?.length && rounds < 4 && !controller.signal.aborted) {
      rounds += 1;
      stream.send({ type: 'phase', phase: 'tools', round: rounds, count: out.tool_calls.length });
      msgs = [...msgs, { role: 'assistant', content: out.content || '', tool_calls: out.tool_calls }];
      for (const tc of out.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty */ }
        const name = tc.function?.name || '';
        stream.send({ type: 'tool', name, status: 'running' });
        let result;
        try {
          result = tools.some((b) => (b.function?.name || b.name) === name) && builtinTools().some((b) => b.function.name === name)
            ? await runBuiltin(name, args)
            : await executeTool(conns, name, args);
          stream.send({ type: 'tool', name, status: 'ok' });
        } catch (e) {
          result = { error: String(e.message || e) };
          stream.send({ type: 'tool', name, status: 'error', error: String(e.message || e) });
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, name, content: JSON.stringify(result).slice(0, 12000) });
      }
      out = await chat(
        { messages: msgs, model, system: systemPrompt, temperature, max_tokens, provider, keys, tools },
        // no signal here: this leg is not streamed, and an abort between legs is
        // checked above before the next one starts.
      );
      if (!out?.tool_calls?.length) {
        if (out?.text) stream.send({ type: 'delta', text: out.text });
        stream.send({ type: 'done', elapsed_ms: null, chars: (out?.text || '').length, model: out?.model, after_tools: true });
        return stream.end();
      }
    }
    return stream.end();
  } catch (e) {
    if (controller.signal.aborted) {
      stream.send({ type: 'aborted' });
      return stream.end();
    }
    const { payload } = await describeChatFailure(e, provider, model, keys);
    stream.send({ type: 'error', ...payload });
    return stream.end();
  }
}

// --- sandbox -----------------------------------------------------------------

/** Code that runs is code that runs *somewhere*: this is the machine the bridge
 *  is on, so a remote caller does not get to do it. The desktop app's bridge is
 *  loopback by construction, which is why the feature exists there first. */
function sandboxAllowed(req) {
  if (String(process.env.ANTICODEX_SANDBOX || '').toLowerCase() === 'remote') return true;
  return isLoopback(req);
}

async function handleSandbox(req, body, res) {
  if (!sandboxAllowed(req)) {
    return json(res, 403, {
      ok: false, fix: 'desktop', verdict: 'blocked',
      error: 'Running generated code happens on the machine that owns it, so a remote request cannot do it here.',
      hint: 'Install ANTICODEX Desktop (or run this server yourself) — the same Sandbox page then compiles and runs on your own machine, with your own Node and Python.',
      settings_link: '/sandbox'
    });
  }
  const op = body.op || 'status';
  if (op === 'status') return json(res, 200, { ok: true, ...sandboxStatus(), runs: listRuns() });
  if (op === 'run') {
    const out = await runSandbox({
      language: body.language, code: body.code, timeout_ms: body.timeout_ms,
      files: body.files, stdin: body.stdin
    });
    await audit({
      type: 'sandbox.run', language: out.language || body.language, ok: Boolean(out.ok),
      exit_code: out.exit_code ?? null, timed_out: Boolean(out.timed_out), duration_ms: out.duration_ms ?? null,
      ip: clientIp(req)
    }).catch(() => {});
    return json(res, 200, out);
  }
  if (op === 'read') return json(res, 200, readSandboxFile(body.run_id, body.name));
  if (op === 'clear') return json(res, 200, clearSandbox(body.run_id));
  return json(res, 400, { ok: false, error: `Unknown sandbox op "${op}".` });
}

// --- model health -------------------------------------------------------------

async function handleModelHealth(req, body, res) {
  const op = body.op || 'list';
  if (op === 'list') {
    return json(res, 200, {
      ok: true,
      summary: healthSummary(),
      models: allHealth().slice(0, 400),
      // What the picker is doing with them right now, so the page and the picker
      // cannot disagree about how many ids were removed.
      policy: { hide_rejected: true, hide_unverified_when_live: body.strict_live !== false }
    });
  }
  if (op === 'clear') {
    if (body.ref && !isLoopback(req) && !isDesktopLocal(req)) {
      return json(res, 403, { ok: false, error: 'Only this machine can forget a model verdict for a single id.' });
    }
    clearHealth(body.ref || null);
    return json(res, 200, { ok: true, cleared: body.ref || 'all', summary: healthSummary() });
  }
  if (op === 'probe') {
    // A real eight-token call per model — the only honest answer to "does this
    // one work?". Bounded: at most eight models per request.
    if (!canSpawnLocalMcp() && !process.env.ALLOW_REMOTE_PROBE) {
      return json(res, 200, { ok: false, error: 'Probing models spends tokens, so it only runs on the desktop app or a local server.' });
    }
    const keys = await mergedKeys(req, body);
    const wanted = Array.isArray(body.models) ? body.models.slice(0, 8) : [];
    if (!wanted.length) return json(res, 400, { ok: false, error: 'models[] required' });
    const results = await Promise.all(wanted.map((m) => probeModel({
      model: m.model || m.id, provider: m.provider, keys, timeoutMs: Number(body.timeout_ms) || 20000
    })));
    return json(res, 200, { ok: true, results, summary: healthSummary() });
  }
  return json(res, 400, { ok: false, error: 'unknown model_health op' });
}

// --- REA (Reverse Engineer Anything) -------------------------------------------
//
// REA registers itself with an agent CLI (`setup`) and serves its 207 tools over
// MCP (`mcp`). Both are local processes, so everything here is loopback-only and
// a hosted deployment answers `needs_local`.
//
// The approval gate is the point: `plan` runs `setup --dry-run`, the UI shows the
// resolved actions, and `apply` will only run a plan whose fingerprint matches the
// one that was shown. A plan that changes between preview and apply is refused
// rather than silently executed.

const reaPlans = new Map();   // fingerprint -> { at, plan }

async function handleRea(req, body, res) {
  const op = body.op || 'status';
  const local = canSpawnLocalMcp() && isLoopback(req);
  const client = REA_CLIENTS.includes(body.client) ? body.client : 'codex';

  const connection = await findOne('mcp_connections', (c) => c.id === REA_SERVER_NAME || c.url === `stdio:${REA_SERVER_NAME}`);

  if (op === 'status') {
    let probe = null;
    if (local && connection?.status === 'connected') {
      probe = {
        tools: (connection.tools || []).length,
        server: connection.server_version || null,
        connected_at: connection.connected_at || null
      };
    }
    return json(res, 200, {
      ok: true,
      local,
      node: reaNodeStatus(),
      client,
      server_name: REA_SERVER_NAME,
      registered: Boolean(connection),
      connection: connection
        ? { id: connection.id, name: connection.name, status: connection.status, enabled: connection.enabled !== false, url: connection.url }
        : null,
      probe,
      registration: local ? checkRegistration(client) : null,
      plans: reaPlans.size,
      note: local ? null : 'REA runs on your machine: setup spawns npx and the MCP server is a local process. Open the desktop app or run `npm start` locally.'
    });
  }

  if (op === 'engines') {
    // REA ships no decompiler. `doctor` is the honest answer to "will it actually
    // take a binary apart?", so it is asked directly instead of being guessed at
    // from the plan — the plan says nothing about engines.
    if (!local) return needsLocal(res, 'Engine checks run REA on this machine — open the desktop app or run this server locally.');
    const run = await runRea(reaDoctorArgs(), { timeoutMs: Number(body.timeout_ms) || 120000 });
    const report = parseDoctorOutput(run.stdout || run.stderr);
    const missing = missingEngines(report);
    if (report.parse_error && !report.checks.length) {
      return json(res, 200, {
        ok: false, command: run.command, ms: run.ms,
        error: `Could not read REA's doctor output (${run.spawn_error || (run.stderr || '').slice(-300) || `exit ${run.code}`})`,
        stdout_tail: (run.stdout || '').slice(-1500), stderr_tail: (run.stderr || '').slice(-1500)
      });
    }
    return json(res, 200, {
      ok: true,
      command: run.command,
      ms: run.ms,
      healthy: report.healthy,
      environment_healthy: report.environment_healthy,
      host: report.host,
      checks: report.checks,
      missing,
      // The answer to "so how do I fix it?": every engine REA knows about, with
      // the variable it reads. Shown even when all of them are configured.
      help: ENGINE_HELP,
      // Not doctor-checkable, but still an engine you need: listed separately so
      // "all configured" never means "the half we could check".
      optional: envOnlyEngines(),
      note: missing.length
        ? `${missing.length} analysis engine${missing.length === 1 ? '' : 's'} not configured — REA's file inspectors still work, but it cannot decompile without one.`
        : 'Every analysis engine REA knows about is configured on this machine.',
      parse_error: report.parse_error
    });
  }

  if (!local) return needsLocal(res, 'REA setup and its MCP server are local processes — open the desktop app or run this server on your own machine.');

  if (op === 'plan') {
    const node = reaNodeStatus();
    if (!node.ok) return json(res, 200, { ok: false, node, error: node.message });
    const args = reaArgs('plan', { client, skill: body.skill !== false });
    const run = await runRea(args, { timeoutMs: Number(body.timeout_ms) || 180000 });
    const parsed = parseSetupOutput(run.stdout || run.stderr);
    if (!run.ok && !parsed.status) {
      return json(res, 200, {
        ok: false, node, command: run.command, ms: run.ms, timed_out: Boolean(run.timed_out),
        error: `REA setup --dry-run did not produce a plan (${run.spawn_error || (run.stderr || '').slice(-400) || `exit ${run.code}`})`,
        stdout_tail: (run.stdout || '').slice(-1500), stderr_tail: (run.stderr || '').slice(-1500)
      });
    }
    const planId = planFingerprint(parsed);
    reaPlans.set(planId, { at: Date.now(), plan: parsed, client });
    // Keep this bounded; it is a preview cache, not a history.
    if (reaPlans.size > 8) reaPlans.delete([...reaPlans.keys()][0]);
    return json(res, 200, {
      ok: true,
      node,
      client,
      command: run.command,
      ms: run.ms,
      plan_id: planId,
      status: parsed.status,
      actions: parsed.planned.map((a) => ({ ...a, summary: describeReaAction(a) })),
      doctor: parsed.doctor,
      parse_error: parsed.parse_error,
      nothing_to_do: parsed.planned.length === 0,
      requires_approval: parsed.planned.length > 0,
      stderr_tail: (run.stderr || '').slice(-1200) || null
    });
  }

  if (op === 'apply') {
    if (body.approve !== true) {
      return json(res, 403, { ok: false, error: 'Setup must be approved: send { approve: true } after showing the plan.' });
    }
    const cached = reaPlans.get(String(body.plan_id || ''));
    if (!cached) {
      return json(res, 409, { ok: false, error: 'Unknown or expired plan — fetch the plan again and show it before applying.' });
    }
    if (Date.now() - cached.at > 30 * 60 * 1000) {
      reaPlans.delete(String(body.plan_id));
      return json(res, 409, { ok: false, error: 'That plan is more than 30 minutes old — fetch it again so you approve what is on disk now.' });
    }
    // Re-plan first: the fingerprint must still match what the user approved.
    const fresh = await runRea(reaArgs('plan', { client: cached.client, skill: true }), { timeoutMs: 120000 });
    const freshPlan = parseSetupOutput(fresh.stdout || fresh.stderr);
    const freshId = planFingerprint(freshPlan);
    if (freshId !== String(body.plan_id)) {
      return json(res, 409, {
        ok: false, changed: true, plan_id: freshId,
        error: 'The plan changed since it was shown — nothing was written. Review the new plan and approve it again.',
        actions: freshPlan.planned.map((a) => ({ ...a, summary: describeReaAction(a) }))
      });
    }
    const run = await runRea(reaArgs('apply', { client: cached.client, skill: true }), { timeoutMs: 300000 });
    const applied = parseSetupOutput(run.stdout || run.stderr);
    return json(res, run.ok ? 200 : 500, {
      ok: run.ok,
      plan_id: freshId,
      command: run.command,
      ms: run.ms,
      applied: applied.applied.map((a) => ({ ...a, summary: describeReaAction(a) })),
      status: applied.status,
      doctor: applied.doctor,
      error: run.ok ? null : (run.spawn_error || (run.stderr || '').slice(-600) || `exit ${run.code}`),
      stdout_tail: (run.stdout || '').slice(-2000),
      stderr_tail: (run.stderr || '').slice(-2000)
    });
  }

  if (op === 'verify') {
    // Two independent proofs: REA's own config file has the registration, and a
    // real MCP handshake with the local server lists its tools.
    const registration = checkRegistration(client);
    let handshake;
    try {
      const probe = await probeServer(`stdio:${REA_SERVER_NAME}`);
      handshake = {
        ok: true,
        server: probe.server,
        protocol: probe.protocolVersion,
        tools: (probe.tools || []).length,
        sample_tools: (probe.tools || []).slice(0, 12).map((t) => t.name)
      };
    } catch (e) {
      handshake = { ok: false, error: String(e.message || e) };
    }
    return json(res, 200, {
      ok: Boolean(handshake.ok && (registration.present !== false)),
      node: reaNodeStatus(),
      registration,
      handshake,
      registered: Boolean(connection)
    });
  }

  if (op === 'register') {
    // Register (or refresh) the connection row this app uses to call REA.
    const why = await localRefusal(req);
    if (why) return json(res, 200, noLocalMcpServer(why));
    try {
      const probe = await probeServer(`stdio:${REA_SERVER_NAME}`);
      const row = {
        id: REA_SERVER_NAME,
        name: REA_SERVER_NAME,
        url: `stdio:${REA_SERVER_NAME}`,
        status: 'connected',
        enabled: true,
        local: true,
        tools: probe.tools,
        server_version: probe.server?.version || null,
        protocol_version: probe.protocolVersion || null,
        connected_at: Date.now()
      };
      const existing = await findOne('mcp_connections', (x) => x.id === row.id);
      if (existing) await update('mcp_connections', (x) => x.id === row.id, row);
      else await insert('mcp_connections', { ...row, permissions: { tools: true, resources: true, prompts: true, read: true, write: false } });
      forgetTools();
      await audit({ type: 'rea.register', tools: (probe.tools || []).length, ip: clientIp(req) }).catch(() => {});
      return json(res, 200, { ok: true, connection: row, tools: (probe.tools || []).length });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (op === 'tools') {
    const conn = connection || { id: REA_SERVER_NAME, url: `stdio:${REA_SERVER_NAME}`, enabled: true };
    try {
      const probe = await probeServer(conn.url);
      return json(res, 200, { ok: true, tools: probe.tools, server: probe.server, count: (probe.tools || []).length });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (op === 'run') {
    // One tool, called the way chat would call it.
    if (typeof body.tool !== 'string' || !/^[a-z0-9_]+$/i.test(body.tool)) {
      return json(res, 400, { ok: false, error: 'tool name required' });
    }
    const conn = connection || { id: REA_SERVER_NAME, url: `stdio:${REA_SERVER_NAME}`, enabled: true };
    const started = Date.now();
    try {
      const result = await executeTool([conn], `mcp__${REA_SERVER_NAME}__${body.tool}`, body.args || {});
      return json(res, 200, { ok: true, tool: body.tool, ms: Date.now() - started, result });
    } catch (e) {
      return json(res, 200, { ok: false, tool: body.tool, ms: Date.now() - started, error: String(e.message || e) });
    }
  }

  return json(res, 400, { ok: false, error: 'unknown rea op' });
}

// --- Qoder -----------------------------------------------------------------
//
// Two integrations behind one action, because they answer the same question —
// "what of Qoder can this app actually do?":
//
//   cloud.*   the Cloud Agents APIs (Forward + Managed), driven from the server
//             with the user's own QODER_PAT so the browser never holds a token;
//   acp.*     the local `qodercli --acp` agent, which only exists on a machine
//             that can spawn processes, so it is loopback-only.
//
// Neither is a proxy for arbitrary URLs: paths are built from constants plus
// validated ids, so a request cannot address a host of its choosing.

const QODER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function qoderId(value, field) {
  if (typeof value !== 'string' || !QODER_ID.test(value)) {
    const e = new Error(`${field} is not a valid Qoder id`);
    e.status = 400;
    throw e;
  }
  return encodeURIComponent(value);
}

/** A signed-in user's own key, falling back to the deployment's. */
async function qoderKeyGetter(req, body) {
  const user = await currentUser(req, body).catch(() => null);
  const own = user?.email ? await userKeyMap(user.email).catch(() => ({})) : {};
  return { user, get: (name) => (own && own[name]) || getKey(name) };
}

async function handleQoder(req, body, res) {
  const op = body.op || 'status';
  const local = canSpawnLocalMcp() && isLoopback(req);
  const { user, get } = await qoderKeyGetter(req, body);

  // Cloud Agents act on somebody's Qoder account: a signed-in user or a local
  // install, never an anonymous remote caller.
  if (String(op).startsWith('cloud.') && !user && !local) {
    return json(res, 401, { ok: false, error: 'Sign in to use Qoder Cloud Agents.', sign_in: '/login' });
  }

  if (op === 'status') {
    const cli = await qoderCliStatus().catch((e) => ({ found: false, error: String(e.message || e) }));
    return json(res, 200, {
      ok: true,
      local,
      ...qoderStatus(get),
      cli,
      atlas: qoderAtlasTally(),
      cloud: { forwards: Object.keys(QCA_BASE), key_envs: QODER_PAT_ENVS, base: QCA_BASE.forward.replace('/api/v1/forward', '') },
      ascp_hint: cli.found ? null : 'Install qodercli to use the local ACP agent: npm i -g @qoder-ai/qodercli'
    });
  }

  if (op === 'repos') return json(res, 200, { ok: true, repos: QODER_REPOS, tally: qoderAtlasTally(), owner: 'qoderAI' });

  if (op === 'action.workflow') {
    const yaml = qoderActionWorkflow({
      prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.slice(0, 2000) : undefined,
      version: typeof body.version === 'string' && /^\d+\.\d+\.\d+$/.test(body.version) ? body.version : undefined,
      mcp: body.mcp !== false,
      flags: typeof body.flags === 'string' ? body.flags.slice(0, 200) : '',
      trigger: ['pull_request', 'issue_comment', 'workflow_dispatch'].includes(body.trigger) ? body.trigger : 'pull_request'
    });
    return json(res, 200, { ok: true, path: '.github/workflows/qoder.yml', yaml, source: 'https://github.com/qoderAI/qoder-action' });
  }

  // --- local ACP agent ------------------------------------------------------
  if (op === 'acp.probe') {
    if (!local) return needsLocal(res, 'qodercli is a local process — open the desktop app or run this server on your machine.');
    const started = Date.now();
    const client = createAcpClient({ cwd: os.tmpdir(), allowTools: false });
    try {
      const init = await client.initialize();
      return json(res, 200, {
        ok: true,
        ms: Date.now() - started,
        agent: init?.agentInfo || null,
        protocol: init?.protocolVersion ?? null,
        auth_methods: init?.authMethods || [],
        capabilities: init?.agentCapabilities || null,
        signed_in: !(init?.authMethods || []).length
      });
    } catch (e) {
      return json(res, 200, { ok: false, ms: Date.now() - started, code: e.code ?? null, error: explainAcpError(e), stderr: client.state.stderr.slice(-800) });
    } finally {
      await client.close().catch(() => {});
    }
  }

  if (op === 'acp.prompt') {
    if (!local) return needsLocal(res, 'qodercli is a local process — open the desktop app or run this server on your machine.');
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { ok: false, error: 'text is required' });
    const allowTools = body.allow_tools === true;
    const updates = [];
    const sessionCwd = typeof body.cwd === 'string' && path.isAbsolute(body.cwd) ? body.cwd : os.tmpdir();
    const client = createAcpClient({
      cwd: sessionCwd,
      allowTools,
      clientVersion: VERSION,
      onUpdate: (params) => {
        // Bounded: an agent can emit thousands of chunks and this is a preview.
        if (updates.length < 500) updates.push(params?.update || params);
      }
    });
    const started = Date.now();
    try {
      const init = await client.initialize();
      let session;
      try {
        session = await client.newSession({ cwd: sessionCwd });
      } catch (e) {
        return json(res, 200, {
          ok: false, ms: Date.now() - started, auth_required: /auth/i.test(String(e.message || '')),
          agent: init?.agentInfo || null, error: explainAcpError(e), stderr: client.state.stderr.slice(-800)
        });
      }
      const result = await client.prompt({ text, sessionId: session?.sessionId });
      const answer = updates
        .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
        .map((u) => (u.content?.text || ''))
        .join('');
      return json(res, 200, {
        ok: true,
        ms: Date.now() - started,
        session_id: session?.sessionId || null,
        stop_reason: result?.stopReason ?? null,
        text: answer,
        updates: updates.slice(0, 200),
        chunks: updates.length,
        tools_requested: updates.filter((u) => u?.sessionUpdate === 'tool_call').length,
        allow_tools: allowTools,
        stderr: client.state.stderr ? client.state.stderr.slice(-800) : undefined
      });
    } catch (e) {
      return json(res, 200, { ok: false, ms: Date.now() - started, code: e.code ?? null, error: explainAcpError(e), stderr: client.state.stderr.slice(-800) });
    } finally {
      await client.close().catch(() => {});
    }
  }

  // --- Cloud Agents ---------------------------------------------------------
  const pat = get('QODER_PAT') || get('QODER_ACCESS_TOKEN');
  const call = (mode, p, options = {}) => qcaRequest(mode, p, { token: pat, ...options });

  if (op === 'cloud.whoami') {
    const r = await call('forward', 'templates', { query: { limit: 1 } });
    return json(res, 200, { ...r, key_source: pat ? 'server' : null, error: r.ok ? undefined : r.error });
  }

  if (op === 'cloud.identities') {
    if (body.method === 'create') {
      const externalId = String(body.external_id || '').trim();
      if (!externalId) return json(res, 400, { ok: false, error: 'external_id is required' });
      const r = await call('forward', 'identities', { method: 'POST', body: { external_id: externalId.slice(0, 128), name: body.name ? String(body.name).slice(0, 128) : undefined } });
      return json(res, 200, { ...r, data: r.ok ? r.data : undefined });
    }
    const r = await call('forward', 'identities', { query: { limit: Number(body.limit) || 20 } });
    return json(res, 200, r.ok ? { ...r, ...qcaPage(r.data) } : r);
  }

  if (op === 'cloud.templates') {
    const r = await call('forward', 'templates', { query: { limit: Number(body.limit) || 20 } });
    return json(res, 200, r.ok ? { ...r, ...qcaPage(r.data) } : r);
  }

  if (op === 'cloud.sessions') {
    if (body.method === 'create') {
      const identityId = qoderId(body.identity_id, 'identity_id');
      const templateId = qoderId(body.template_id, 'template_id');
      const r = await call('forward', 'sessions', {
        method: 'POST',
        body: { identity_id: decodeURIComponent(identityId), template_id: decodeURIComponent(templateId), title: body.title ? String(body.title).slice(0, 200) : undefined }
      });
      return json(res, 200, r.ok ? { ok: true, session: r.data } : r);
    }
    const r = await call('forward', 'sessions', { query: { limit: Number(body.limit) || 20 } });
    return json(res, 200, r.ok ? { ...r, ...qcaPage(r.data) } : r);
  }

  if (op === 'cloud.session') {
    const r = await call('forward', `sessions/${qoderId(body.session_id, 'session_id')}`);
    return json(res, 200, r.ok ? { ok: true, session: r.data } : r);
  }

  if (op === 'cloud.events') {
    const r = await call('forward', `sessions/${qoderId(body.session_id, 'session_id')}/events`, { query: { limit: Number(body.limit) || 50, order: body.order === 'desc' ? 'desc' : 'asc' } });
    return json(res, 200, r.ok ? { ...r, ...qcaPage(r.data) } : r);
  }

  if (op === 'cloud.send') {
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { ok: false, error: 'text is required' });
    const r = await call('forward', `sessions/${qoderId(body.session_id, 'session_id')}/events`, {
      method: 'POST',
      body: { events: [{ type: 'user.message', content: [{ type: 'text', text: text.slice(0, 20000) }] }] }
    });
    return json(res, 200, r.ok ? { ok: true, accepted: r.data } : r);
  }

  if (op === 'cloud.stream') {
    // Collect a bounded window of the SSE feed instead of holding a socket open
    // through the bridge: the page polls this, so a reload cannot leak a stream.
    const controller = new AbortController();
    const budget = Math.min(Math.max(Number(body.ms) || 8000, 1000), 20000);
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      // Built from a re-validated id and opened through `qcaStream`, which
      // asserts the origin: the host is never allowed to come from the request.
      const streamPath = `sessions/${encodeURIComponent(qoderId(body.session_id, 'session_id'))}/events/stream`;
      let res2;
      try {
        res2 = await qcaStream('forward', streamPath, {
          headers: { Authorization: `Bearer ${pat}` }, signal: controller.signal
        });
      } catch (e) {
        if (e?.status === 400) return json(res, 400, { ok: false, error: 'That session id would address another host.' });
        throw e;
      }
      if (!res2.ok) return json(res, 200, { ok: false, status: res2.status, error: `Qoder returned ${res2.status}` });
      const collected = [];
      for await (const event of qcaEvents(res2, { signal: controller.signal })) {
        collected.push(event);
        if (collected.length >= 200) break;
      }
      return json(res, 200, { ok: true, events: collected, ms: budget });
    } catch (e) {
      if (e?.name === 'AbortError') return json(res, 200, { ok: true, events: [], ms: budget, note: 'No new events in the window.' });
      return json(res, 200, { ok: false, error: String(e.message || e) });
    } finally {
      clearTimeout(timer);
    }
  }

  return json(res, 400, { ok: false, error: `unknown qoder op: ${op}` });
}

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


// --- artifact templates ------------------------------------------------------
//
// The ChatGPT app answers "what style should this document use?" with a picture
// grid built from templates on disk (openai_artifact_template_picker). The same
// grid here offers whatever templates are installed in the ChatGPT/Codex home,
// checked by lib/artifacts.js before a single byte of preview reaches the page.
// Reading that home only happens for a local caller — a hosted deployment has no
// templates, and says so rather than showing an empty grid.

async function handleArtifacts(req, body, res) {
  const op = body.op || 'kinds';
  const local = canSpawnLocalMcp() && isLoopback(req);

  if (op === 'kinds') {
    return json(res, 200, {
      ok: true,
      local,
      kinds: [...ARTIFACT_KINDS.keys()].map((id) => ({ id, family: familyOf(id), extension: extensionOf(id) }))
    });
  }

  if (!local) {
    return json(res, 200, {
      ok: true,
      local: false,
      cards: [],
      count: 0,
      note: 'Artifact templates live in the ChatGPT/Codex home on this machine — open the desktop app or a local `npm start`.'
    });
  }

  try {
    if (op === 'roots') {
      return json(res, 200, { ok: true, ...templateRoots(body.codex_home || undefined) });
    }

    const kind = body.artifact_kind || 'document';
    const request = normalizeRequest(kind, body.request);
    const templates = await discoverTemplates({ codexHome: body.codex_home || undefined, artifactKind: kind });

    if (op === 'list') {
      return json(res, 200, { ok: true, artifact_kind: kind, request, count: templates.length, cards: offer(templates) });
    }
    if (op === 'choose') {
      const chosen = resolveSelection(templates, body.selection);
      return json(res, 200, { ok: true, ...chosen });
    }
    return json(res, 400, { ok: false, error: 'unknown artifacts op' });
  } catch (e) {
    return json(res, 400, { ok: false, code: e.code || 'InvalidTemplate', error: String(e.message || e) });
  }
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
