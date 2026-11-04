#!/usr/bin/env node
// Staged adapter: not referenced by installed hooks until an explicit cutover.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {runtimeLedger,stateRoot} from '../../dist/ledger/runtime.js';
import {atomicJSON,readJSON} from '../../dist/ledger/store.js';
import {guardExecution,guardStop,lifecycleTool,refreshBinding} from '../../dist/ledger/guard.js';
const platform=process.argv[2];
let payload,stage;
try {
  if(!['codex','hermes','multica'].includes(platform))throw Error('Explicit host required');
  let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>4*1024*1024)throw Error('Payload too large');}
  payload=JSON.parse(raw||'{}');
  const sessionId=payload.session_id;if(!sessionId)throw Error('Host must supply session_id');
  stage=payload.hook_event_name;
  if(!['PreToolUse','PostToolUse','Stop','pre_tool_call','post_tool_call','agent_stop','pre_verify'].includes(stage))throw Error('Unknown hook event');
  const session={platform,sessionId},ledger=runtimeLedger();
  const file=path.join(stateRoot(),'ledger-v2-sessions',crypto.createHash('sha256').update(platform+':'+sessionId).digest('hex')+'.json');
  // Reuse exclusive filesystem lock for session updates; this is not the Action lock.
  await ledger.store.lock('session-v2:'+platform+':'+sessionId,async()=>{
    const state=await readJSON(file)||{protocolVersion:2,bindings:[]};
    // Provisioned by the host before launching an assigned worker. Without this,
    // a not-yet-accepted receiver would look like an unrelated unbound chat.
    if(process.env.OF_LEDGER_ASSIGNMENT_FILE){
      const assignment=await readJSON(process.env.OF_LEDGER_ASSIGNMENT_FILE);
      if(!assignment?.id||assignment.actor?.platform!==platform||!assignment.actor?.runId||assignment.actor.sessionId&&assignment.actor.sessionId!==sessionId)throw Error('Invalid host assignment');
      if(!state.bindings.some(b=>b.id===assignment.id&&b.actor.runId===assignment.actor.runId)){
        state.bindings.push({id:assignment.id,actor:{...assignment.actor,sessionId},revision:assignment.expectedRevision,pending:true});
        await atomicJSON(file,state);
      }
    }
    const isPre=['PreToolUse','pre_tool_call'].includes(stage),isPost=['PostToolUse','post_tool_call'].includes(stage);
    const tool=payload.tool_name||'',a=payload.tool_input||{};
    if(lifecycleTool(tool)&&(isPre||isPost)) {
      if(a.protocolVersion!==2||a.actor?.platform!==platform||a.actor?.sessionId!==sessionId||!a.actor?.runId||!a.id)throw Error('Lifecycle actor must match trusted host session');
      let b=state.bindings.find(x=>x.id===a.id&&x.actor.runId===a.actor.runId);
      if(!b){b={id:a.id,actor:a.actor,revision:a.expectedRevision,pending:true};state.bindings.push(b);}
      if(isPre){b.pending=true;}
      else {
        const d=await ledger.load(a.id);
        const accepted=d.events.some(e=>e.eventId===a.eventId&&e.actor.runId===a.actor.runId&&e.actor.sessionId===sessionId&&e.actor.platform===platform);
        if(accepted)Object.assign(b,await refreshBinding(ledger,b));
        else if(!d.intent&&!d.events.some(e=>e.toOwner?.runId===a.actor.runId))state.bindings=state.bindings.filter(x=>x!==b);
        // Existing owners stay fenced when a failed request cannot be confirmed.
      }
      await atomicJSON(file,state);
    } else if(isPre)await guardExecution(ledger,state.bindings,session,tool);
    else if(!isPost)await guardStop(ledger,state.bindings,session);
  });
  console.log('{}');
} catch(e) {
  const reason='OF ownership v2: '+e.message;
  if(platform==='codex')console.log(JSON.stringify(stage==='Stop'?{decision:'block',reason}:{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}}));
  else console.log(JSON.stringify({action:platform==='hermes'&&stage==='pre_verify'?'continue':'block',message:reason}));
  process.exitCode=2;
}
