import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-of-test-'));const script=fileURLToPath(new URL('./hermes-of-guard.mjs',import.meta.url));
function call(p){const r=spawnSync(process.execPath,[script],{input:JSON.stringify(p),encoding:'utf8',env:{...process.env,OF_AGENT_STATE_DIR:dir},timeout:25000});assert.ok(r.stdout,r.stderr);return JSON.parse(r.stdout);}
const base={session_id:'test',tool_name:'mcp_of_agent_transition',tool_input:{id:'fake',event:'start',runId:'test'}};
assert.equal(call({hook_event_name:'pre_tool_call',tool_name:'terminal'}).action,'block');
assert.deepEqual(call({...base,hook_event_name:'pre_tool_call'}),{});
assert.equal(call({session_id:'test',hook_event_name:'pre_tool_call',tool_name:'terminal'}).action,'block');
assert.deepEqual(call({session_id:'test',hook_event_name:'pre_tool_call',tool_name:'mcp_of_get_task'}),{});
call({...base,hook_event_name:'post_tool_call',extra:{result:JSON.stringify({ok:false,id:'fake',event:'start',status:'rejected'})}});
assert.deepEqual(call({session_id:'test',hook_event_name:'pre_tool_call',tool_name:'terminal'}),{});
assert.deepEqual(call({session_id:'different',hook_event_name:'pre_tool_call',tool_name:'terminal'}),{});
fs.rmSync(dir,{recursive:true});console.log('PASS: missing session blocked; pending claim blocks tool; readonly diagnosis allowed; rejected claim releases; sessions isolated');
