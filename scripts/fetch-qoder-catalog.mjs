#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
import { trimCatalog, QODER_COMMIT, QODER_REPO } from '../lib/qoder-skills.js';
import { DATA_PATH } from '../lib/keys.js';
const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN||'';
const h={'User-Agent':'anticodex-qoder',Accept:'application/vnd.github+json',...(token?{Authorization:'Bearer '+token}:{})};
const tr=await fetch('https://api.github.com/repos/'+QODER_REPO+'/git/trees/'+QODER_COMMIT+':catalog',{headers:h});
if(!tr.ok){console.error('tree HTTP '+tr.status);process.exit(1);}
const tree=await tr.json(); const entry=(tree.tree||[]).find((t)=>t.path==='qoder.json');
if(!entry){console.error('catalog/qoder.json missing');process.exit(1);}
const br=await fetch('https://api.github.com/repos/'+QODER_REPO+'/git/blobs/'+entry.sha,{headers:{...h,Accept:'application/vnd.github.raw'}});
if(!br.ok){console.error('blob HTTP '+br.status);process.exit(1);}
const data=await br.json(); const trimmed=trimCatalog(data);
fs.mkdirSync(DATA_PATH,{recursive:true});
const out=path.join(DATA_PATH,'qoder-catalog.json'); fs.writeFileSync(out,JSON.stringify(trimmed));
console.log('qoder catalog: '+trimmed.length+' skills -> '+out);
