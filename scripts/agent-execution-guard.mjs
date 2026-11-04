import {input,sessionId,update,root} from './session-state.mjs';
import {getLiveTask} from '../dist/localWorkflow.js';
import {terminalPhase,lifecycleTool,recoveryTool,reconcileConfirmed,assertExecutable} from './hermes-guard-policy.mjs';
const p=await input();
try {
 if(!lifecycleTool(p.tool_name)&&!recoveryTool(p.tool_name)){
  let bindings=[];
  await update(sessionId(p),async s=>{
   for(const b of s.bindings||[])if(!terminalPhase(b))await reconcileConfirmed(root,b,getLiveTask);
   bindings=(s.bindings||[]).filter(b=>!terminalPhase(b));
  });
  for(const b of bindings){
   if(b.phase!=='active')throw Error('OF lifecycle is unconfirmed; use discovery and OF recovery tools before executing '+b.id);
   if(b.mode==='monitor')await (await import('../dist/monitor/runtime.js')).monitor().check(b.id,b.runId);else assertExecutable(await getLiveTask(b.id),b.id);
  }
 }
 console.log('{}');
}catch(e){console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:String(e)}}));}
