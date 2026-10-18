#!/usr/bin/env node
// ANTICODEX local server: static SPA + /api/bridge. Also powers the desktop app
// and the sandbox preview. Bind 0.0.0.0 so live previews work.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.ANTICODEX_WEB_DIST || path.join(__dirname, 'web', 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm'
};

const bridge = (await import(pathToFileURL(path.join(__dirname, 'api', 'bridge.js')))).default;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    req.url = url.pathname + url.search;
    return bridge(req, res);
  }

  // SPA static serving with history-fallback.
  let filePath = path.join(WEB_DIST, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(WEB_DIST)) {
    res.writeHead(403); return res.end('forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WEB_DIST, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fallbackPage());
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(filePath).pipe(res);
});

function fallbackPage() {
  return `<!doctype html><html><body style="font-family:system-ui;background:#0b0d12;color:#e6e9f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center"><h1>ANTICODEX</h1><p>Web bundle not built yet. Run <code>npm run build</code> (or <code>npm run dev:web</code>).</p></div></body></html>`;
}

server.listen(PORT, HOST, () => {
  console.log(`ANTICODEX server → http://${HOST}:${PORT}`);
});
