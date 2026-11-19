import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import zlib from 'node:zlib';
import { DATA_PATH } from './keys.js';
export const QODER_COMMIT='ee2951cfe1'; export const QODER_REPO='ThaddeusHackz/The-Open-Agent-Skills-Ecosystem';
const CATALOG_FILE=process.env.QODER_CATALOG||path.join(DATA_PATH,'qoder-catalog.json');
let cache=null;
export function trimCatalog(raw){const skills=Array.isArray(raw)?raw:(raw.skills||[]);return skills.map((s)=>({id:s.id||('qoder:'+(s.skill_id||s.name)),name:String(s.name||'').slice(0,120),description:String(s.description||'').slice(0,400),category:s.category||'',installs:Number(s.installs)||0,path:s.path||'',download_url:s.download_url||'',sha256:s.sha256||''})).filter((s)=>s.name);}
export function loadQoderCatalog(){if(cache)return cache;try{cache=trimCatalog(JSON.parse(fs.readFileSync(CATALOG_FILE,'utf8')));}catch{cache=[];}return cache;}
export function searchQoder(query,limit=8){const q=String(query||'').toLowerCase().trim();if(!q)return[];const terms=q.split(/\s+/).filter(Boolean);const cat=loadQoderCatalog();const scored=[];for(const s of cat){const name=s.name.toLowerCase();const desc=s.description.toLowerCase();let score=0;for(const t of terms){if(name===t)score+=40;else if(name.includes(t))score+=18;if(desc.includes(t))score+=6;}if(score>0)scored.push({...s,score:score+Math.min(5,Math.log10(1+s.installs))});}scored.sort((a,b)=>b.score-a.score);return scored.slice(0,limit);}
export function readZip(buf,wantName){const eocd=buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));if(eocd<0)throw new Error('not a zip');const cdOffset=buf.readUInt32LE(eocd+16);const cdCount=buf.readUInt16LE(eocd+10);let p=cdOffset;for(let i=0;i<cdCount;i++){if(buf.readUInt32LE(p)!==0x02014b50)break;const method=buf.readUInt16LE(p+10);const csize=buf.readUInt32LE(p+20);const nameLen=buf.readUInt16LE(p+28);const extraLen=buf.readUInt16LE(p+30);const commentLen=buf.readUInt16LE(p+32);const localOffset=buf.readUInt32LE(p+42);const name=buf.slice(p+46,p+46+nameLen).toString('utf8');if(name===wantName||name.endsWith('/'+wantName)){const lh=localOffset;if(buf.readUInt32LE(lh)!==0x04034b50)throw new Error('bad local header');const lNameLen=buf.readUInt16LE(lh+26);const lExtraLen=buf.readUInt16LE(lh+28);const start=lh+30+lNameLen+lExtraLen;const data=buf.slice(start,start+csize);return method===0?data:zlib.inflateRawSync(data);}p+=46+nameLen+extraLen+commentLen;}throw new Error('entry not found: '+wantName);}
export async function fetchQoderBody(skill,{fetchImpl=fetch}={}){if(!skill.download_url)throw new Error('no download_url');const r=await fetchImpl(skill.download_url);if(!r.ok)throw new Error('download HTTP '+r.status);const buf=Buffer.from(await r.arrayBuffer());if(skill.sha256){const got=crypto.createHash('sha256').update(buf).digest('hex');if(got!==skill.sha256)throw new Error('sha256 mismatch');}return readZip(buf,'SKILL.md').toString('utf8');}

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill';
export const QODER_SOURCE = Object.freeze({ id: 'qoder-ecosystem', label: 'Qoder Skills Ecosystem', repo: QODER_REPO, license: 'MIT', tier: 'extra', commit: QODER_COMMIT });
export function toAtlasEntries(raw, { commit = QODER_COMMIT } = {}) {
  const rows = Array.isArray(raw) ? raw : (raw.skills || []);
  const seen = new Set(); const out = [];
  for (const s of rows) {
    const name = slugify(s.name); if (!s.name) continue;
    const suffix = String(s.skill_id || s.id || '').replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
    const slug = (name + '-q' + suffix).slice(0, 100);
    if (seen.has(slug)) continue; seen.add(slug);
    const cat = slugify(s.category || 'general');
    out.push({ slug, name, display: String(s.name).slice(0, 120), description: String(s.description || '').slice(0, 200),
      tier: 'extra', tags: [...new Set([cat, 'qoder'])],
      source: { id: QODER_SOURCE.id, label: QODER_SOURCE.label, commit, path: (s.path || '') + '/SKILL.md', url: 'https://github.com/' + QODER_REPO + '/blob/' + commit + '/' + (s.path || '') + '/SKILL.md' },
      bytes: Number(s.bytes) || 0, truncated: false, resources: [], resource_count: Math.max(0, (Number(s.files_in_package) || 1) - 1),
      flags: [], also: [], shard: 'qoder', lazy: true, download_url: s.download_url || '', sha256: s.sha256 || '', installs: Number(s.installs) || 0 });
  }
  return out;
}
