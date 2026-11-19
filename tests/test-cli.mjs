import { parseArgs, runCli } from '../lib/cli.js';
let p=0,f=0; const ok=(n,c)=>{ if(c){p++;console.log('  + '+n);} else {f++;console.log('  FAIL '+n);} };
console.log('--- ANTICODEX CLI ---');
ok('help', parseArgs(['--help']).help===true);
ok('prompt joins', parseArgs(['fix','tests']).prompt==='fix tests');
ok('agent flag', parseArgs(['-a','plan','x']).agent==='plan');
ok('yes', parseArgs(['--yes','x']).yes===true);
ok('default build', parseArgs(['x']).agent==='build');
{ const lines=[]; const res=await runCli({ argv:['make a file'], callModel:async()=>({content:'Done: a.txt',tool_calls:[]}), ask:async()=>'allow', out:(s)=>lines.push(s), err:()=>{} }); ok('runs to answer', res.ok && /Done/.test(res.text)); ok('prints', lines.some(l=>/Done/.test(l))); }
{ const sc=[{content:'',tool_calls:[{id:'c1',function:{name:'write',arguments:JSON.stringify({file_path:'x.txt',content:'hi'})}}]},{content:'stopped'}]; let i=0; const res=await runCli({ argv:['write x'], callModel:async()=>sc[Math.min(i++,sc.length-1)], ask:null, out:()=>{}, err:()=>{} }); ok('non-TTY fail closed finishes', res.ok); }
{ const res=await runCli({ argv:[], callModel:async()=>({content:''}), out:()=>{}, err:()=>{} }); ok('empty exits 1', res.code===1); }
console.log(p+' passed, '+f+' failed'); process.exit(f?1:0);
