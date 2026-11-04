import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const key=id=>crypto.createHash('sha256').update(id).digest('hex');
export const terminalPhase=b=>['handed_off','rejected','released'].includes(b.phase);
export const lifecycleTool=name=>/(?:^|_)of_(agent|monitor)_transition$/.test(name||'');
export const recoveryTool=name=>['tool_search','tool_describe'].includes(name)||/(?:^|_)of_(get_task|read_attachment|list_tasks|list_projects|list_tags|list_folders|sync|agent_ledger|agent_check|agent_reconcile|monitor_get|monitor_due|monitor_check|monitor_reconcile)$/.test(name||'');
async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function ownershipEvidence(root,b){
 const k=key(b.id);
 const v2=await read(path.join(root,'ledger-v2',k+'.json'));
 if(v2)throw Error('V2 ledger exists; upgrade host guard, do not use legacy release');
 const intent=await read(path.join(root,'local-ownership',k+'.json.intent'));
 const pending=await read(path.join(root,'pending',k+'.json'));
 const locked=await fs.stat(path.join(root,'transition-'+k+'.lock')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
 if(intent||pending||locked)throw Error('Transition pending or uncertain; inspect before releasing session');
 return read(path.join(root,'local-ownership',k+'.json'));
}
export async function reconcileConfirmed(root,b,readLive){
 if(terminalPhase(b))return;
 const evidence=await ownershipEvidence(root,b);
 const recovery=await read(path.join(root,'legacy-recovery',key(b.id)+'.json'));
 if(recovery?.committed&&recovery.decision==='discard_not_written'&&recovery.result.runId===b.runId&&recovery.request.event===b.request?.event&&['start_pending','handoff_pending'].includes(b.phase)){
  if(recovery.request.event==='start'){b.phase='rejected';b.lastError='Explicitly discarded unchanged unwritten start';b.updatedAt=new Date().toISOString();return;}
  if(evidence?.id===b.id&&evidence.runId===b.runId&&evidence.event==='start'){assertExecutable(await readLive(b.id),b.id);b.phase='active';b.confirmedEvent='start';b.updatedAt=new Date().toISOString();return;}
 }
 if(evidence?.id!==b.id||evidence?.runId!==b.runId){if(b.phase==='active')throw Error('Active session has no matching durable owner; inspect and release stale binding before executing');return;}
 if(['done','needs_human','monitor_checked'].includes(evidence.event)){
  b.phase=evidence.event==='monitor_checked'?'released':'handed_off';b.confirmedEvent=evidence.event;b.confirmedAt=evidence.at;
  b.confirmationSource='exact local ownership record; no pending intent';b.updatedAt=new Date().toISOString();return;
 }
 if(['start','monitor_start'].includes(evidence.event)&&b.phase==='start_pending'){
  if(b.mode==='monitor')await (await import('../dist/monitor/runtime.js')).monitor().check(b.id,b.runId);else {const t=await readLive(b.id);assertExecutable(t,b.id);}
  b.phase='active';b.confirmedEvent='start';b.confirmedAt=evidence.at;b.confirmationSource='exact local ownership record and live tags';b.updatedAt=new Date().toISOString();
 }
}
export function assertExecutable(t,id){
 const tags=(t.tags||[]).map(n=>n.replace(/^[^\p{L}\p{N}]+/u,'').trim());
 if(t.completed||t.dropped||!t.available||!tags.includes('AFK')||!tags.includes('进行中')||tags.includes('HITL'))throw Error('OF Action '+id+' no longer permits execution. Stop this Action. An operator can release the stale session with agent-session-release.mjs after verification; do not restore tags or claim delivery.');
}
export async function releaseVerified(root,b,readLive,reason){
 if(!reason?.trim())throw Error('Explicit release reason required');
 if(terminalPhase(b))return;
 const evidence=await ownershipEvidence(root,b);
 let cause;
 if(evidence?.id===b.id&&evidence.runId===b.runId&&['done','needs_human'].includes(evidence.event))cause='confirmed_handoff';
 else {
  const t=await readLive(b.id);if(t.id!==b.id)throw Error('Action identity mismatch');
  const tags=t.tags.map(n=>n.replace(/^[^\p{L}\p{N}]+/u,'').trim());
  if(evidence?.id===b.id&&evidence.runId!==b.runId)cause='superseded';
  else if(t.completed||t.dropped||!t.available||!tags.includes('AFK')||!tags.includes('进行中')||tags.includes('HITL'))cause='revoked_or_inactive';
  else throw Error('Action is still executable under this claim; use lifecycle handoff, not release');
 }
 b.release={at:new Date().toISOString(),cause,reason,previousPhase:b.phase};
 b.phase='released';b.updatedAt=b.release.at;
 // Retain the old run and all claim evidence. This is never a synthetic done event.
}
