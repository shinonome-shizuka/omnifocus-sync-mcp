#!/usr/bin/env node
// Stop is read-only with respect to OF: reconcile this session, never replay writes.
import {input,sessionId,update,root} from './session-state.mjs';
import {getLiveTask} from '../dist/localWorkflow.js';
import {terminalPhase,reconcileConfirmed} from './hermes-guard-policy.mjs';
const p=await input(),id=sessionId(p);
if(id){
 const unresolved=await update(id,async s=>{
  const errors=[];
  for(const b of s.bindings||[])if(!terminalPhase(b)){
   try{const previous=b.phase;await reconcileConfirmed(root,b,getLiveTask);if(previous!==b.phase&&terminalPhase(b))s.resolution={status:'reconciled',at:new Date().toISOString()};}catch(e){errors.push({id:b.id,runId:b.runId,error:String(e)});}
  }
  s.lastStopAudit={at:new Date().toISOString(),errors};return errors;
 });
 if(unresolved.length)console.error('[omnifocus-agent] Current session needs explicit recovery; no OF writes replayed: '+JSON.stringify(unresolved));
}
console.log('{}');
