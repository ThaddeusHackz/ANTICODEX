import { compactMessages, messageChars, isSafeBoundary, summarize, COMPACT_MARKER } from '../lib/compact.js';
import { buildAttention, nextSteps, skillSuggestion } from '../lib/attention.js';
import { runAgent, AGENT_LIMITS } from '../lib/agent.js';
let p=0,f=0; const ok=(n,c,x)=>{ if(c){p++;console.log('  + '+n);} else {f++;console.log('  FAIL '+n+' '+(x||''));} };
const big=(n)=>'x'.repeat(n);
console.log('--- compaction (Qoder 0.1.8 / 0.5.13) ---');
{ const ms=[{role:'system',content:'sys'},{role:'user',content:'hi'}];
  const r=compactMessages(ms,{maxChars:1000});
  ok('under budget is a no-op', r.compacted===false && r.messages===ms); }
{ const ms=[{role:'system',content:'sys'}];
  for (let i=0;i<40;i++){ ms.push({role:'user',content:'q'+i+big(400)}); ms.push({role:'assistant',content:'a'+i+big(400)}); }
  const r=compactMessages(ms,{maxChars:5000,keepRecent:6});
  ok('over budget compacts', r.compacted===true);
  ok('shrinks the payload', r.chars_after<r.chars_before);
  ok('keeps the system head', r.messages[0].content==='sys');
  ok('marks the summary honestly', r.messages[1].content.startsWith(COMPACT_MARKER));
  ok('reports how many turns went', r.removed>0); }
{ const ms=[{role:'system',content:'s'}];
  for (let i=0;i<30;i++){ ms.push({role:'user',content:'q'+i+big(500)}); ms.push({role:'assistant',content:'a'+i+big(500)}); }
  ms.push({role:'assistant',content:'',tool_calls:[{id:'t1',function:{name:'read',arguments:'{}'}}]});
  ms.push({role:'tool',tool_call_id:'t1',name:'read',content:'{"ok":true}'});
  ms.push({role:'assistant',content:'tail'+big(500)});
  const out=compactMessages(ms,{maxChars:4000,keepRecent:2}).messages;
  const ids=new Set(out.filter(m=>m.role==='assistant'&&m.tool_calls).flatMap(m=>m.tool_calls.map(c=>c.id)));
  const answered=new Set(out.filter(m=>m.role==='tool').map(m=>m.tool_call_id));
  ok('no orphaned tool response', [...answered].every(id=>ids.has(id)));
  ok('no unanswered tool_call', [...ids].every(id=>answered.has(id)));
  ok('tail never starts with a tool message', out[out.length-1].role!=='tool'); }
{ const ms=[{role:'system',content:'s'},{role:'assistant',content:'',tool_calls:[{id:'z',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'z',name:'read',content:big(90000)}];
  ok('a tool message is never a cut point', isSafeBoundary(ms,2)===false);
  ok('an assistant with tool_calls is never a cut point', isSafeBoundary(ms,1)===false);
  const r=compactMessages(ms,{maxChars:100,keepRecent:2});
  ok('refuses rather than breaking the wire', r.compacted===false && r.reason==='no safe boundary'); }
{ const s=summarize([{role:'user',content:'build it'},{role:'tool',name:'write',content:JSON.stringify({ok:true,path:'a.js'})},{role:'tool',name:'bash',content:JSON.stringify({ok:false,error:'boom'})}]);
  ok('summary names the files', /a\.js/.test(s));
  ok('summary keeps unresolved failures', /boom/.test(s));
  ok('summary tells the model to re-read', /Ask for a file again/.test(s)); }
ok('messageChars counts tool_calls', messageChars([{role:'assistant',content:'',tool_calls:[{id:'1',function:{name:'x',arguments:'{}'}}]}])>0);
ok('context budget is published', AGENT_LIMITS.context_chars>0 && AGENT_LIMITS.keep_recent>0);
console.log('--- Needs Me / Act Proactive (0.5.1 / 0.1.0) ---');
{ const a=buildAttention({events:[{type:'tool_end',tool:'bash',ok:false,error:'exit 1'}],changes:[{paths:['a.js']}]});
  ok('a failed tool becomes an item', a.some(i=>i.kind==='error'&&i.severity==='high'));
  ok('changes without tests are flagged', a.some(i=>i.kind==='untested')); }
{ const a=buildAttention({events:[{type:'tool_start',tool:'bash',args:{command:'npm test'}},{type:'tool_end',tool:'write',ok:true}],changes:[{paths:['a.js']}]});
  ok('a real test run clears the untested flag', !a.some(i=>i.kind==='untested')); }
{ const a=buildAttention({events:[],changes:[],plan:[{step:'one',status:'completed'},{step:'two',status:'pending'}],todos:[{text:'t',status:'pending'}],question:{text:'which db?'},stepLimited:true});
  ok('unfinished plan flagged', a.some(i=>i.kind==='plan'));
  ok('open todo flagged', a.some(i=>i.kind==='todo'));
  ok('a question needs an answer', a.some(i=>i.kind==='question'));
  ok('the step cap is reported', a.some(i=>i.kind==='limit')); }
ok('a clean turn raises nothing', buildAttention({events:[{type:'tool_end',tool:'read',ok:true}],changes:[]}).length===0);
console.log('--- next steps + skill evolution (0.5.11 / 0.4.1) ---');
{ const a=buildAttention({events:[{type:'tool_end',tool:'bash',ok:false,error:'x'}],changes:[{paths:['a.js']}]});
  const n=nextSteps(a,{changes:[{paths:['a.js']}]});
  ok('suggests fixing failures', n.some(s=>/Fix the failures/.test(s.label)));
  ok('suggests running tests', n.some(s=>/Run the tests/.test(s.label)));
  ok('at most three suggestions', n.length<=3);
  ok('every suggestion is sendable', n.every(s=>s.prompt&&s.prompt.length>5)); }
ok('a quiet turn still offers something', nextSteps([],{changes:[]}).length===1);
{ const s=skillSuggestion({events:[{type:'tool_end',tool:'read',ok:true},{type:'tool_end',tool:'write',ok:true},{type:'tool_end',tool:'bash',ok:true}],changes:[{paths:['a.js','b.js']}]});
  ok('a repeatable workflow is proposed', s && /Capture this workflow/.test(s.title));
  ok('the suggestion never writes', s.writes===false); }
ok('a trivial turn proposes nothing', skillSuggestion({events:[{type:'tool_end',tool:'read',ok:true}],changes:[]})===null);
console.log('--- wired into the agent loop ---');
{ const evs=[];
  for await (const ev of runAgent({messages:[{role:'user',content:'hi'}],agent:'build',target:'local',account:'ladder',callModel:async()=>({content:'hello'})})) evs.push(ev);
  const d=evs.find(e=>e.type==='done');
  ok('done carries attention', Array.isArray(d?.attention));
  ok('done carries next_steps', Array.isArray(d?.next_steps)&&d.next_steps.length>0);
  ok('done carries a compaction count', typeof d?.compactions==='number'); }
{ const script=[{content:'',tool_calls:[{id:'b1',function:{name:'bash',arguments:JSON.stringify({command:'definitely-not-a-command-xyz'})}}]},{content:'done'}];
  let i=0; const evs=[];
  for await (const ev of runAgent({messages:[{role:'user',content:'run it'}],agent:'build',target:'local',account:'ladder',callModel:async()=>script[Math.min(i++,script.length-1)],askPermission:async()=>'allow'})) evs.push(ev);
  ok('a failing tool raises an attention event', evs.some(e=>e.type==='attention'&&e.items.some(x=>x.kind==='error'))); }
{ const long='q'.repeat(9000); const msgs=[{role:'user',content:long}];
  for (let k=0;k<8;k++) msgs.push({role:'user',content:long});
  const script=[{content:'',tool_calls:[{id:'r1',function:{name:'list',arguments:JSON.stringify({path:'.'})}}]},{content:'ok'}];
  let i=0; const evs=[]; const seen=[];
  const model=async({messages})=>{ seen.push(messages.length); return script[Math.min(i++,script.length-1)]; };
  for await (const ev of runAgent({messages:msgs,agent:'build',target:'local',account:'ladder',callModel:model,askPermission:async()=>'allow'})) evs.push(ev);
  ok('a long thread emits a compact event', evs.some(e=>e.type==='compact'));
  ok('compaction actually shrank the request', seen.length>1 && seen[1]<seen[0]); }
console.log(p+' passed, '+f+' failed'); process.exit(f?1:0);
