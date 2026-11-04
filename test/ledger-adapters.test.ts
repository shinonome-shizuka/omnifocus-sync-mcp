import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Ledger} from '../src/ledger/engine.js';
import {LedgerStore,readJSON} from '../src/ledger/store.js';
import {verifyWrite} from '../src/ledger/runtime.js';
const script=fileURLToPath(new URL('../scripts/ledger-v2/guard.mjs',import.meta.url));
for(const platform of ['codex','hermes','multica'] as const)test(platform+' hook adapter verifies ledger rather than response ok:true',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-adapter-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const actor={platform,sessionId:'session',runId:'run'},target={platform:'multica' as const,sessionId:'target',runId:'target'};
 const live:any={id:'fake',tags:['AFK'],note:'',completed:false,dropped:false,available:true};
 const ledger=new Ledger(new LedgerStore(root),{read:async()=>live,write:async()=>{live.tags.push('进行中');},verify:verifyWrite});
 const a={protocolVersion:2 as const,id:'fake',actor,runId:'run',event:'start' as const,eventId:'start',expectedRevision:0};
 const call=(event:string,tool='terminal',args:any={})=>{
  const r=spawnSync(process.execPath,[script,platform],{input:JSON.stringify({session_id:'session',hook_event_name:event,tool_name:tool,tool_input:args,tool_response:{ok:true},extra:{result:{ok:true}}}),encoding:'utf8',env:{...process.env,OF_AGENT_STATE_DIR:root},timeout:10000});
  assert.ok(r.stdout,r.stderr);return {code:r.status,data:JSON.parse(r.stdout)};
 };
 assert.equal(call('PreToolUse','mcp_of_agent_transition',a).code,0);
 assert.equal(call('PreToolUse').code,2); // pending, no OF call
 assert.equal(call('PreToolUse','mcp_of_agent_ledger').code,0);
 assert.equal(call('Stop').code,2);
 if(platform==='hermes')assert.equal(call('pre_verify').data.action,'continue');
 await ledger.transition(a);call('PostToolUse','mcp_of_agent_transition',a);
 assert.equal(call('Stop').code,2);
 const offered=await ledger.transfer({protocolVersion:2,id:'fake',actor,eventId:'offer',expectedRevision:1,action:'offer',transferId:'transfer',target,expiresAt:new Date(Date.now()+60000).toISOString()});
 assert.equal(call('PreToolUse').code,2); // transferring stops before port read
 const credential=(await readJSON(offered.credentialPath)).credential;
 await ledger.transfer({protocolVersion:2,id:'fake',actor:target,eventId:'accept',expectedRevision:2,action:'accept',transferId:'transfer',credential});
 assert.equal(call('PreToolUse').code,2); // old owner fenced before port read
 assert.equal(call('Stop').code,0);
});
test('host-provisioned Multica receiver cannot run before any accept tool has been called',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-preaccept-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const assignment=path.join(root,'assignment.json');await fs.writeFile(assignment,JSON.stringify({id:'fake',actor:{platform:'multica',runId:'receiver'},expectedRevision:2}));
 const r=spawnSync(process.execPath,[script,'multica'],{input:JSON.stringify({session_id:'new-session',hook_event_name:'pre_tool_call',tool_name:'terminal'}),encoding:'utf8',env:{...process.env,OF_AGENT_STATE_DIR:root,OF_LEDGER_ASSIGNMENT_FILE:assignment},timeout:10000});
 assert.equal(r.status,2);assert.match(r.stdout,/unconfirmed/);
});
