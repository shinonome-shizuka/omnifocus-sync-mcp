import {input,sessionId,update} from './session-state.mjs';
import {getLiveTask} from '../dist/localWorkflow.js';
const p=await input();
if(/of_(agent_transition|get_task|list_tasks|sync)$/.test(p.tool_name||'')){console.log('{}');process.exitCode=0;}
else {
 try{
  let bindings=[];await update(sessionId(p),s=>{bindings=(s.bindings||[]).filter(b=>b.phase==='active');});
  for(const b of bindings){const t=await getLiveTask(b.id);const names=t.tags.map(n=>n.replace(/^[^\p{L}\p{N}]+/u,'').trim());if(t.completed||t.dropped||!t.available||!names.includes('AFK')||!names.includes('进行中')||names.includes('HITL'))throw Error('OF Action '+b.id+' no longer permits execution. Stop work and report the state change; do not restore tags.');}
  console.log('{}');
 }catch(e){console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:String(e)}}));}
}
