import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
import {reduce} from './session-state.mjs';import {reconcileConfirmed} from './hermes-guard-policy.mjs';
const key=id=>crypto.createHash('sha256').update(id).digest('hex');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-hooks-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const put=async(p,v)=>{p=path.join(root,p);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v));};return {root,put};}
function call(root,script,p){const r=spawnSync(process.execPath,[new URL(script,import.meta.url).pathname],{input:JSON.stringify(p),encoding:'utf8',env:{...process.env,OF_AGENT_STATE_DIR:root},timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
test('session journal retains exact request including codexThreadId, monitor actor and revision',()=>{
 for(const [name,args] of [['of_agent_transition',{id:'a',runId:'r',event:'done',reason:'result',codexThreadId:'01a1a4a4-f1bc-7770-9725-10e054be27c7'}],['of_monitor_transition',{id:'a',runId:'r',event:'checked',platform:'codex',sessionId:'session',expectedRevision:4,eventId:'event',summary:'same',outcome:'unchanged'}]]){
  const s=reduce({bindings:[]},{hook_event_name:'PreToolUse',tool_name:name,tool_input:args});assert.deepEqual(s.bindings[0].request.arguments,args);
 }
});
test('Stop reconciles this session without scanning/replaying unrelated pending requests',async t=>{
 const f=await fixture(t);await f.put('pending/unrelated.json',{invalid:true});await f.put('sessions/'+key('s')+'.json',{sessionId:'s',bindings:[{id:'a',runId:'r',phase:'handoff_pending'}]});await f.put('local-ownership/'+key('a')+'.json',{id:'a',runId:'r',event:'done'});
 assert.deepEqual(call(f.root,'./agent-hook.mjs',{session_id:'s'}),{});
 const s=JSON.parse(await fs.readFile(path.join(f.root,'sessions',key('s')+'.json'),'utf8'));assert.equal(s.bindings[0].phase,'handed_off');assert.ok(await fs.readFile(path.join(f.root,'pending/unrelated.json')));
 assert.deepEqual(call(f.root,'./agent-stop-guard.mjs',{session_id:'s'}),{});
});
test('discarded unwritten start unblocks session; unwritten handoff returns to active owner',async t=>{
 const f=await fixture(t),id='a',runId='r';const b={id,runId,phase:'start_pending',request:{event:'start'}};
 await f.put('legacy-recovery/'+key(id)+'.json',{committed:true,decision:'discard_not_written',result:{id,runId},request:{event:'start'}});
 await reconcileConfirmed(f.root,b,async()=>{throw Error('no live read needed for discarded start');});assert.equal(b.phase,'rejected');
 b.phase='handoff_pending';b.request.event='done';await f.put('local-ownership/'+key(id)+'.json',{id,runId,event:'start'});await f.put('legacy-recovery/'+key(id)+'.json',{committed:true,decision:'discard_not_written',result:{id,runId},request:{event:'done'}});
 await reconcileConfirmed(f.root,b,async()=>({tags:['AFK','进行中'],available:true}));assert.equal(b.phase,'active');
});
test('Hermes monitor event envelope records active then released, never creates HITL',async t=>{
 const f=await fixture(t),args={id:'a',runId:'r',platform:'hermes',sessionId:'fixture',event:'start',eventId:'one',expectedRevision:0};
 const hermes=p=>call(f.root,'./hermes-of-guard.mjs',{session_id:'fixture',tool_name:'mcp_omnifocus_of_monitor_transition',...p});
 hermes({hook_event_name:'pre_tool_call',tool_input:args});
 hermes({hook_event_name:'post_tool_call',tool_input:args,extra:{result:JSON.stringify({ok:true,id:'a',event:'start',runId:'r'})}});
 let s=JSON.parse(await fs.readFile(path.join(f.root,'sessions',key('hermes:fixture')+'.json'),'utf8'));assert.equal(s.bindings[0].phase,'active');assert.equal(s.bindings[0].mode,'monitor');
 const checked={...args,event:'checked',eventId:'two',expectedRevision:1,summary:'same',outcome:'unchanged'};hermes({hook_event_name:'pre_tool_call',tool_input:checked});hermes({hook_event_name:'post_tool_call',tool_input:checked,extra:{result:JSON.stringify({ok:true,id:'a',event:'checked',runId:'r',notify:false})}});
 s=JSON.parse(await fs.readFile(path.join(f.root,'sessions',key('hermes:fixture')+'.json'),'utf8'));assert.equal(s.bindings[0].phase,'released');
});
