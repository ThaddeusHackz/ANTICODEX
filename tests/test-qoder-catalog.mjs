import zlib from 'node:zlib'; import crypto from 'node:crypto';
import { trimCatalog, readZip, fetchQoderBody, QODER_COMMIT } from '../lib/qoder-skills.js';
let p=0,f=0; const ok=(n,c)=>{ if(c){p++;console.log('  + '+n);} else {f++;console.log('  FAIL '+n);} };
console.log('--- Qoder catalog ---');
ok('pinned', QODER_COMMIT==='ee2951cfe1');
const raw={skills:[{id:'qoder:a',name:'deep-research',description:'research',installs:100,download_url:'https://x/a.zip',sha256:'abc'},{id:'qoder:b',name:'kubernetes-diag',description:'diagnose k8s',installs:5}]};
ok('trims', trimCatalog(raw).length===2);
function makeZip(name,content){const data=Buffer.from(content);const comp=zlib.deflateRawSync(data);const nb=Buffer.from(name);const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(8,8);lh.writeUInt32LE(comp.length,18);lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(nb.length,26);const local=Buffer.concat([lh,nb,comp]);const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50,0);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(8,10);cd.writeUInt32LE(comp.length,20);cd.writeUInt32LE(data.length,24);cd.writeUInt16LE(nb.length,28);cd.writeUInt32LE(0,42);const central=Buffer.concat([cd,nb]);const eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(1,8);eocd.writeUInt16LE(1,10);eocd.writeUInt32LE(central.length,12);eocd.writeUInt32LE(local.length,16);return Buffer.concat([local,central,eocd]);}
const zip=makeZip('SKILL.md','# Test Skill\nbody here');
ok('readZip', /Test Skill/.test(readZip(zip,'SKILL.md').toString()));
const sha=crypto.createHash('sha256').update(zip).digest('hex');
const fake=async()=>({ok:true,status:200,arrayBuffer:async()=>zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.byteLength)});
const body=await fetchQoderBody({download_url:'https://f/t.zip',sha256:sha},{fetchImpl:fake});
ok('verify+extract', /body here/.test(body));
let rej=false; try{await fetchQoderBody({download_url:'https://f/t.zip',sha256:'dead'},{fetchImpl:fake});}catch{rej=true;}
ok('sha mismatch refused', rej);
console.log(p+' passed, '+f+' failed'); process.exit(f?1:0);
