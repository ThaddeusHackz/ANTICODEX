#!/usr/bin/env node
// ANTICODEX local server: static SPA + /api/bridge. Also powers the desktop app
// and the sandbox preview. Bind 0.0.0.0 so live previews work.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
  const type = MIME[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' };

  // Compress the things that are big and textual. The skill atlas index is 2 MB of
  // JSON and 0.28 MB gzipped — on a phone over a hotspot that is the difference
  // between the Skills page appearing and not. Streamed, so a large body never sits
  // in memory; below 1 KB the framing costs more than it saves.
  const compressible = /\.(json|js|css|svg|txt|webmanifest|map)$/.test(ext) || type.startsWith('text/');
  const accept = String(req.headers['accept-encoding'] || '');
  const encoding = !compressible ? null : /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  const size = fs.statSync(filePath).size;
  const useEncoding = encoding && size > 1024 ? encoding : null;

  if (!useEncoding) {
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    return fs.createReadStream(filePath).pipe(res);
  }
  headers['Vary'] = 'Accept-Encoding';
  headers['Content-Encoding'] = useEncoding;
  res.writeHead(200, headers);
  const coder = useEncoding === 'br'
    ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } })
    : zlib.createGzip({ level: 6 });
  const stream = fs.createReadStream(filePath).pipe(coder);
  // A truncated gzip stream is worse than no compression: if the client hangs up
  // mid-body, drop the pipe instead of writing to a dead socket.
  stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
  res.on('close', () => { try { stream.destroy(); } catch { /* gone */ } });
  stream.pipe(res);
});

function fallbackPage() {
  return `<!doctype html><html><body style="font-family:system-ui;background:#0b0d12;color:#e6e9f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center"><h1>ANTICODEX</h1><p>Web bundle not built yet. Run <code>npm run build</code> (or <code>npm run dev:web</code>).</p></div></body></html>`;
}

server.listen(PORT, HOST, () => {
  console.log(`ANTICODEX server → http://${HOST}:${PORT}`);
});
