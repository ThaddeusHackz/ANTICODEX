#!/usr/bin/env node
// Generates desktop/icons/icon.icns from the existing desktop/icons/icon.png —
// no new dependencies, no new artwork. electron-packager's darwin path only
// copies an icon when it is a real .icns (see node_modules/electron-packager/
// src/mac.js copyIcon → normalizeIconExtension('.icns')); a bare .png is
// silently skipped, which would ship the generic Electron icon.
//
// The ICNS container here uses the PNG-compressed OSTypes that macOS 10.7+
// accepts (the same set png2icons emits): ic11=32, ic12=64, ic07=128,
// ic08/ic13=256, ic09/ic14=512, ic10=1024. Pixels are box-averaged downscales
// of the ONE source logo — nothing is drawn or invented.
//
// Run standalone:  node desktop/make-icns.mjs [src.png] [dest.icns]
// Or import:       import { makeIcns } from './make-icns.mjs'

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal PNG reader (8-bit RGB/RGBA, non-interlaced — what the logo is).
// ---------------------------------------------------------------------------
export function decodePng(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${depth}, color type ${color}, interlace ${interlace}); need 8-bit RGB/RGBA non-interlaced`);
  }
  const ch = color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  return { w, h, ch, px };
}

// Box-average downscale: every destination pixel averages the exact source
// rectangle it covers, so small sizes stay faithful to the logo.
export function resize(img, tw, th) {
  const { w, h, ch, px } = img;
  const out = Buffer.alloc(tw * th * ch);
  for (let y = 0; y < th; y++) {
    const sy0 = Math.floor(y * h / th), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / th));
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor(x * w / tw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / tw));
      const n = (sy1 - sy0) * (sx1 - sx0);
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          const row = sy * w * ch;
          for (let sx = sx0; sx < sx1; sx++) sum += px[row + sx * ch + c];
        }
        out[(y * tw + x) * ch + c] = Math.round(sum / n);
      }
    }
  }
  return { w: tw, h: th, ch, px: out };
}

// ---------------------------------------------------------------------------
// Minimal PNG writer (filter 0, 8-bit RGB/RGBA).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePng(img) {
  const { w, h, ch, px } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2; // bit depth, color type
  const stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// ICNS container: 'icns' + total size, then (OSType, size, PNG) entries.
// ---------------------------------------------------------------------------
const ICNS_ENTRIES = [
  ['ic11', 32],   // 16@2x
  ['ic12', 64],   // 32@2x
  ['ic07', 128],
  ['ic08', 256],
  ['ic13', 256],  // 128@2x
  ['ic09', 512],
  ['ic14', 512],  // 256@2x
  ['ic10', 1024]  // 512@2x
];

export function makeIcns(srcPng, destIcns) {
  const img = decodePng(fs.readFileSync(srcPng));
  const entries = ICNS_ENTRIES.map(([type, size]) => {
    const png = encodePng(resize(img, size, size));
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = 8 + entries.reduce((n, e) => n + e.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(total, 4);
  const out = Buffer.concat([header, ...entries]);
  fs.mkdirSync(path.dirname(destIcns), { recursive: true });
  fs.writeFileSync(destIcns, out);
  return { bytes: out.length, entries: ICNS_ENTRIES.map(([t, s]) => `${t}:${s}`) };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = process.argv[2] || path.join(__dirname, 'icons', 'icon.png');
  const dest = process.argv[3] || path.join(__dirname, 'icons', 'icon.icns');
  try {
    const r = makeIcns(src, dest);
    console.log(`✓ ${dest} (${r.bytes} bytes; ${r.entries.join(', ')}) from ${src}`);
  } catch (e) {
    console.error(`✗ icns generation failed: ${e.message || e}`);
    process.exit(1);
  }
}