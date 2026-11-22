import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-parity-'));
process.env.ANTICODEX_DATA = path.join(TMP, 'data');
process.env.ANTICODEX_ROLLOUTS = path.join(TMP, 'rollouts');
const { parseApplyPatch, applyPatchToContent } = await import('../lib/apply-patch.js');
const { parseSlash, fileMentions, SLASH_COMMANDS } = await import('../lib/slash.js');
const { appendRollout, readRollout, resumeFrom, listRollouts } = await import('../lib/rollout.js');
const { AGENTS, toolDefs, allowedTools, executeTool, runAgent } = await import('../lib/agent.js');
const { parseArgs, runCli } = await import('../lib/cli.js');
let p=0,f=0; const ok=(n,c,x)=>{ if(c){p++;console.log('  + '+n);} else {f++;console.log('  FAIL '+n+' '+(x||''));} };
const env = (s) => '*** Begin Patch\n' + s + '\n*** End Patch';
console.log('--- apply_patch envelope ---');
ok('missing begin refused', parseApplyPatch('nope').ok===false);
ok('missing end refused', parseApplyPatch('*** Begin Patch\n*** Add File: a\n+x').ok===false);
{ const r=parseApplyPatch(env('*** Add File: a.txt\n+hello'));
  ok('add parses', r.ok && r.files[0].type==='add' && r.files[0].path==='a.txt');
  ok('add applies', applyPatchToContent('', r.files[0]).content==='hello\n'); }
{ const r=parseApplyPatch(env('*** Update File: a.txt\n@@ header\n one\n-two\n+TWO\n three'));
  ok('update parses with hint', r.ok && r.files[0].hunks[0].hint==='header');
  const out=applyPatchToContent('one\ntwo\nthree', r.files[0]);
  ok('update applies exactly', out.ok && out.content==='one\nTWO\nthree', out.content||out.error); }
{ const r=parseApplyPatch(env('*** Update File: a.txt\n x\n-y\n+z'));
  ok('missing context refused', applyPatchToContent('nope', r.files[0]).ok===false);
  const amb=applyPatchToContent('x\ny\nx\ny', r.files[0]);
  ok('ambiguous context refused', amb.ok===false && /ambiguous/.test(amb.error||''), amb.error); }
{ const r=parseApplyPatch(env('*** Update File: a.txt\n*** Move to: b.txt\n x\n-y\n+z'));
  ok('move parses', r.ok && r.files[0].move_to==='b.txt'); }
{ const r=parseApplyPatch(env('*** Delete File: gone.txt'));
  ok('delete parses', r.ok && r.files[0].type==='delete');
  ok('delete empties', applyPatchToContent('stuff', r.files[0]).deleted===true); }
ok('delete with content refused', parseApplyPatch(env('*** Delete File: g\n+x')).ok===false);
ok('add with context refused', parseApplyPatch(env('*** Add File: a\n ctx')).ok===false);
ok('move without update refused', parseApplyPatch(env('*** Add File: a\n+x\n*** Move to: b')).ok===false);
ok('multi-file envelope', parseApplyPatch(env('*** Add File: a\n+x\n*** Update File: b\n q\n-q\n+Q\n*** Delete File: c')).files.length===3);
console.log('--- tool surface ---');
const names=(a)=>allowedTools(a, toolDefs(a,{includePublicApi:false})).map(d=>d.function.name);
ok('build is offered apply_patch + update_plan', names(AGENTS.build).includes('apply_patch') && names(AGENTS.build).includes('update_plan'));
ok('plan is never offered apply_patch', !names(AGENTS.plan).includes('apply_patch'));
ok('explore is never offered apply_patch', !names(AGENTS.explore).includes('apply_patch'));
ok('plan may still track a plan', names(AGENTS.plan).includes('update_plan'));
console.log('--- update_plan validation ---');
const ctx={ target:{mode:'local',label:'test'}, account:'parity', session:{}, run:{round:1} };
{ const r=await executeTool({name:'update_plan',args:{plan:[{step:'a',status:'in_progress'},{step:'b',status:'pending'}]}},ctx);
  ok('valid plan accepted', r.ok && r.plan.length===2); }
ok('two in_progress refused', (await executeTool({name:'update_plan',args:{plan:[{step:'a',status:'in_progress'},{step:'b',status:'in_progress'}]}},ctx)).ok===false);
ok('unknown status refused', (await executeTool({name:'update_plan',args:{plan:[{step:'a',status:'doing'}]}},ctx)).ok===false);
ok('empty plan refused', (await executeTool({name:'update_plan',args:{plan:[]}},ctx)).ok===false);
ok('stepless entry refused', (await executeTool({name:'update_plan',args:{plan:[{status:'pending'}]}},ctx)).ok===false);
console.log('--- apply_patch on disk (all-or-nothing) ---');
{ const r=await executeTool({name:'apply_patch',args:{input:env('*** Add File: p/a.txt\n+one\n+two')}},ctx);
  ok('add writes a real file', r.ok && r.files===1, JSON.stringify(r.error||'')); }
{ const r=await executeTool({name:'apply_patch',args:{input:env('*** Update File: p/a.txt\n one\n-two\n+TWO')}},ctx);
  ok('update returns a diff', r.ok && /TWO/.test(r.diff||''), r.error); }
{ const r=await executeTool({name:'apply_patch',args:{input:env('*** Add File: p/ok.txt\n+fine\n*** Update File: p/a.txt\n NOPE\n-x\n+y')}},ctx);
  ok('a bad section refuses the whole patch', r.ok===false);
  const st=await executeTool({name:'read',args:{file_path:'p/ok.txt'}},ctx);
  ok('...and wrote nothing (no partial apply)', st.ok===false, JSON.stringify(st).slice(0,120)); }
{ const r=await executeTool({name:'apply_patch',args:{input:env('*** Update File: p/a.txt\n*** Move to: p/b.txt\n one\n-TWO\n+THREE')}},ctx);
  ok('move applies', r.ok && r.applied[0].path==='p/b.txt', r.error); }
{ const r=await executeTool({name:'apply_patch',args:{input:env('*** Delete File: p/b.txt')}},ctx);
  ok('delete applies', r.ok, r.error); }
ok('update of a missing file refused', (await executeTool({name:'apply_patch',args:{input:env('*** Update File: p/ghost.txt\n a\n-a\n+b')}},ctx)).ok===false);
console.log('--- cumulative turn diff + plan event ---');
{ const script=[{content:'',tool_calls:[{id:'p1',function:{name:'update_plan',arguments:JSON.stringify({plan:[{step:'write',status:'in_progress'}]})}}]},
    {content:'',tool_calls:[{id:'p2',function:{name:'apply_patch',arguments:JSON.stringify({input:env('*** Add File: turn/x.txt\n+hi')})}}]},
    {content:'done'}];
  let i=0; const evs=[];
  for await (const ev of runAgent({messages:[{role:'user',content:'go'}],agent:'build',target:'local',account:'parity',callModel:async()=>script[Math.min(i++,script.length-1)],askPermission:async()=>'allow'})) evs.push(ev);
  const done=evs.find(e=>e.type==='done');
  ok('plan event emitted', evs.some(e=>e.type==='plan'));
  ok('change event emitted', evs.some(e=>e.type==='change'));
  ok('done carries the cumulative changes', Array.isArray(done?.changes) && done.changes.length===1, JSON.stringify(done?.changes||[]));
  ok('done carries the plan', Array.isArray(done?.plan) && done.plan[0].step==='write'); }
{ const evs=[]; for await (const ev of runAgent({messages:[{role:'user',content:'hi'}],agent:'build',target:'local',account:'parity',callModel:async()=>({content:'hello'})})) evs.push(ev);
  ok('an empty turn has an empty change set', (evs.find(e=>e.type==='done')?.changes||[]).length===0); }
console.log('--- rollouts + resume ---');
{ appendRollout('s1',{type:'session',agent:'build',grants:{'bash:ls*':'allow'}});
  appendRollout('s1',{type:'user',text:'first'});
  appendRollout('s1',{type:'assistant_delta',text:'answer'});
  appendRollout('s1',{type:'done',text:'answer',grants:{},todos:[]});
  const r=readRollout('s1');
  ok('rollout is JSONL and readable', r && r.events.length===4);
  const res=resumeFrom('s1');
  ok('resume rebuilds messages', res.ok && res.messages.length===2 && res.messages[0].content==='first');
  ok('resume restores grants', res.grants['bash:ls*']==='allow');
  ok('resume restores the agent', res.agent==='build');
  ok('listRollouts sees it', listRollouts().some(x=>x.id==='s1'));
  ok('a missing rollout is an honest error', resumeFrom('nope').ok===false); }
console.log('--- CLI exec --json + resume ---');
ok('exec subcommand parsed', parseArgs(['exec','fix','it']).command==='exec' && parseArgs(['exec','fix','it']).prompt==='fix it');
ok('--json parsed', parseArgs(['exec','x','--json']).json===true);
ok('resume subcommand takes the id', parseArgs(['resume','s1']).resume==='s1');
ok('plain prompt still joins', parseArgs(['fix','tests']).prompt==='fix tests');
ok('default agent still build', parseArgs(['x']).agent==='build');
{ const lines=[];
  const res=await runCli({argv:['exec','make a thing','--json','--session','jsonrun'],callModel:async()=>({content:'Done: thing'}),ask:async()=>'allow',out:(s)=>lines.push(s),err:()=>{}});
  ok('exec --json runs', res.ok);
  const parsed=lines.map(l=>{ try { return JSON.parse(l); } catch { return null; } });
  ok('every line is one JSON object', parsed.every(x=>x&&typeof x==='object'), lines.slice(0,2).join(' | '));
  ok('event order starts with session', parsed[0]?.type==='session');
  ok('event stream ends with done', parsed[parsed.length-1]?.type==='done');
  ok('the named rollout exists', readRollout('jsonrun')!==null); }
{ const res=await runCli({argv:['resume','jsonrun'],callModel:async()=>({content:''}),out:()=>{},err:()=>{}});
  ok('resume with no prompt summarises', res.ok && res.type==='resumed' && res.messages>=1); }
{ const res=await runCli({argv:['resume','ghost-id'],callModel:async()=>({content:''}),out:()=>{},err:()=>{}});
  ok('resume of a missing id fails honestly', res.ok===false && res.code===1); }
{ const res=await runCli({argv:['resume'],callModel:async()=>({content:''}),out:()=>{},err:()=>{}});
  ok('resume with no id lists rollouts', res.ok && Array.isArray(res.rollouts)); }
console.log('--- slash commands + @mentions ---');
ok('plain text is a prompt', parseSlash('write a test').kind==='prompt');
ok('unknown command is reported', parseSlash('/nope').kind==='unknown');
ok('/help is a command', parseSlash('/help').name==='/help');
ok('/approvals needs a mode', Boolean(parseSlash('/approvals').error));
ok('/approvals rejects a bad mode', Boolean(parseSlash('/approvals yolo').error));
ok('/approvals accepts auto-edit', parseSlash('/approvals auto-edit').arg==='auto-edit');
ok('all six commands exist', SLASH_COMMANDS.length===6);
ok('@mentions collected', JSON.stringify(fileMentions('look at @src/a.js and @lib/b.js'))==='["src/a.js","lib/b.js"]');
ok('email is not a mention', fileMentions('mail me at a@b.com').length===0);
console.log(p+' passed, '+f+' failed');
try { fs.rmSync(TMP,{recursive:true,force:true}); } catch {}
process.exit(f?1:0);
