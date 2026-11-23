import { runTeam, validateGoal, abortable } from './teams.js';
import { sitePrompt, parseSiteResponse, renderSite, SITE_STYLES } from './sites.js';
export async function handleV3(req, body, res, { action, account, local, resolveTarget, callModel }) {
  const fail = (code, error) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error })); };
  if (!account) return fail(401, 'Sign in to use Teams and Sites.');
  try {
    if (action === 'teams') {
      validateGoal(body.goal);
      if (resolveTarget(body.target).mode === 'local' && !local) return fail(403, 'A local team needs the desktop app. Configure Daytona for a hosted workspace.');
    } else { sitePrompt(body.prompt); if (body.style && !SITE_STYLES.includes(body.style)) return fail(400, 'Unknown site style.'); }
  } catch (e) { return fail(400, e.message); }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
  const send = (event) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders?.();
  const close = () => controller.abort(); res.on('close', close);
  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 8000); heartbeat.unref?.();
  try {
    if (action === 'teams') {
      for await (const event of runTeam({ goal: body.goal, target: body.target, account, callModel, signal })) { if (signal.aborted) break; send(event); }
    } else {
      send({ type: 'phase', phase: 'Writing your site content' });
      const out = await abortable(callModel({ messages: sitePrompt(body.prompt), tools: [], signal, phase: 'site' }), signal);
      const site = parseSiteResponse(out?.content);
      send({ type: 'done', ok: true, site, html: renderSite(site, body.style || 'editorial') });
    }
  } catch (e) { send({ type: signal.aborted ? 'aborted' : 'error', ok: false, error: String(e.message || e) }); }
  finally { clearInterval(heartbeat); res.removeListener('close', close); controller.abort(); if (!res.writableEnded) res.end(); }
}
