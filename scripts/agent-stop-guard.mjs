import {input,sessionId,update,guard,root} from './session-state.mjs';
import {getLiveTask} from '../dist/localWorkflow.js';
import {terminalPhase,reconcileConfirmed} from './hermes-guard-policy.mjs';
try{
 const p=await input(),id=sessionId(p);
 if(!id)console.log(JSON.stringify({systemMessage:'OmniFocus: no session ID supplied; lifecycle could not be verified.'}));
 else console.log(JSON.stringify(await update(id,async s=>{
  for(const b of s.bindings||[])if(!terminalPhase(b))try{const previous=b.phase;await reconcileConfirmed(root,b,getLiveTask);if(previous!==b.phase&&terminalPhase(b))s.resolution={status:'reconciled',at:new Date().toISOString()};}catch(e){b.lastError=String(e);}
  const result=guard(s,p);s.lastStop={at:new Date().toISOString(),blocked:!!result.decision,unresolved:!!(result.decision||result.systemMessage)};return result;
 })));
}catch(e){console.log(JSON.stringify({systemMessage:'OmniFocus guard failed: '+e.message}));}
