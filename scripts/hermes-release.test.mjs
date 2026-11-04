import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
import {reduce,unpack,guard} from './session-state.mjs';
import {releaseVerified,reconcileConfirmed,recoveryTool} from './hermes-guard-policy.mjs';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'of-release-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const binding={id:'fake',runId:'run',phase:'active',confirmedEvent:'start'};const live={id:'fake',tags:['AFK','进行中'],available:true,completed:false,dropped:false};async function put(name,value){const file=path.join(dir,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));}return {dir,binding,live,put,owner:'local-ownership/'+hash('fake')+'.json'};}
test('real rejected error survives Hermes result envelope and releases failed claim',()=>{
 const p={hook_event_name:'PreToolUse',tool_name:'mcp_omnifocus_of_agent_transition',tool_use_id:'one',tool_input:{id:'fake',runId:'run',event:'start'}};const s=reduce({bindings:[]},p);
 reduce(s,{...p,hook_event_name:'PostToolUse',tool_response:{result:JSON.stringify({ok:false,id:'fake',event:'start',status:'rejected',error:'unavailable'})}});
 assert.equal(s.bindings[0].phase,'rejected');assert.deepEqual(guard(s,{}),{});
});
test('late or duplicate start cannot resurrect handed-off or released run',()=>{
 for(const phase of ['handed_off','released']){const s={bindings:[{id:'fake',runId:'run',phase}],resolution:{status:'released'}};for(const event of ['PreToolUse','PostToolUse'])reduce(s,{hook_event_name:event,tool_name:'of_agent_transition',tool_input:{id:'fake',runId:'run',event:'start'},tool_response:{ok:true,id:'fake',event:'start'}});assert.equal(s.bindings[0].phase,phase);assert.deepEqual(guard(s,{}),{});}
});
test('out of order tool results do not confirm a different in-flight request',()=>{
 const s={bindings:[]};const p={hook_event_name:'PreToolUse',tool_name:'of_agent_transition',tool_input:{id:'fake',runId:'run',event:'start'},tool_use_id:'new'};reduce(s,p);reduce(s,{...p,hook_event_name:'PostToolUse',tool_use_id:'old',tool_response:{ok:true,id:'fake',event:'start'}});assert.equal(s.bindings[0].phase,'start_pending');
});
test('uncertain failures remain pending',()=>{
 assert.equal(unpack({result:JSON.stringify({ok:false,status:'uncertain',error:'intent'})}).status,'uncertain');
 const s={bindings:[]},p={tool_name:'of_agent_transition',tool_input:{id:'fake',runId:'run',event:'start'}};reduce(s,{...p,hook_event_name:'PreToolUse'});reduce(s,{...p,hook_event_name:'PostToolUse',tool_response:{ok:false,status:'uncertain',error:'intent'}});assert.equal(s.bindings[0].phase,'start_pending');
});
test('missed post hook repairs from exact durable terminal owner without OF writes',async t=>{const f=await fixture(t);await f.put(f.owner,{id:'fake',runId:'run',event:'done',at:'now'});await reconcileConfirmed(f.dir,f.binding,async()=>{throw Error('must not touch OF');});assert.equal(f.binding.phase,'handed_off');});
test('release revoked binding retains evidence, never invents completion',async t=>{const f=await fixture(t);f.live.tags=['AFK','Multica'];await releaseVerified(f.dir,f.binding,async()=>f.live,'user requested stale session repair');assert.equal(f.binding.phase,'released');assert.equal(f.binding.confirmedEvent,'start');assert.equal(f.binding.release.cause,'revoked_or_inactive');});
test('live claim cannot be released and uncertain/locked writes cannot be cleared',async t=>{const f=await fixture(t);await assert.rejects(releaseVerified(f.dir,f.binding,async()=>f.live,'release'),/still executable/);f.live.tags=['AFK'];await f.put(f.owner+'.intent',{input:{}});await assert.rejects(releaseVerified(f.dir,f.binding,async()=>f.live,'release'),/uncertain/);assert.equal(f.binding.phase,'active');});
test('active binding with missing or different ownership fails closed',async t=>{const f=await fixture(t);await assert.rejects(reconcileConfirmed(f.dir,f.binding,async()=>f.live),/matching durable/);await f.put(f.owner,{id:'fake',runId:'other',event:'start'});await assert.rejects(reconcileConfirmed(f.dir,f.binding,async()=>f.live),/matching durable/);});
test('discovery and OF diagnostics available, generic execution bridge not blanket allowed',()=>{for(const name of ['tool_search','tool_describe','mcp_omnifocus_of_get_task','mcp_omnifocus_of_list_tags'])assert.equal(recoveryTool(name),true);for(const name of ['tool_call','terminal','mcp_omnifocus_of_edit_task','mcp_other_write'])assert.equal(recoveryTool(name),false);});
test('real Hermes wrapper unwedges rejected claim, reconciles missed delivery, fences released run',async t=>{
 const f=await fixture(t),file='sessions/'+hash('hermes:session')+'.json';
 const call=p=>{const r=spawnSync(process.execPath,[new URL('./hermes-of-guard.mjs',import.meta.url).pathname],{input:JSON.stringify({session_id:'session',...p}),encoding:'utf8',env:{...process.env,OF_AGENT_STATE_DIR:f.dir}});assert.ok(r.stdout,r.stderr);return {status:r.status,result:JSON.parse(r.stdout)};};
 await f.put(file,{sessionId:'hermes:session',bindings:[{id:'fake',runId:'run',phase:'start_pending'}]});
 for(const tool_name of ['tool_search','tool_describe','mcp_omnifocus_of_list_tags'])assert.equal(call({hook_event_name:'pre_tool_call',tool_name}).status,0);
 assert.equal(call({hook_event_name:'pre_tool_call',tool_name:'tool_call'}).status,2);
 const args={id:'fake',runId:'run',event:'start'};call({hook_event_name:'post_tool_call',tool_name:'mcp_omnifocus_of_agent_transition',tool_input:args,extra:{result:JSON.stringify({ok:false,status:'rejected',error:'rejected',id:'fake',event:'start'})}});
 assert.equal(call({hook_event_name:'pre_tool_call',tool_name:'mcp_any_tool'}).status,0);
 await f.put(file,{bindings:[f.binding]});await f.put(f.owner,{id:'fake',runId:'run',event:'done',at:'now'});
 assert.equal(call({hook_event_name:'pre_tool_call',tool_name:'mcp_any_tool'}).status,0);
 await f.put(file,{bindings:[{...f.binding,phase:'released'}]});assert.equal(call({hook_event_name:'pre_tool_call',tool_name:'mcp_any_tool'}).status,0);
 assert.equal(call({hook_event_name:'pre_tool_call',tool_name:'mcp_omnifocus_of_agent_transition',tool_input:args}).status,2);
});
