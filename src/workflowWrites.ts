import {backendService,withBackend} from './backend.js';
import {Database} from './ofocus/database.js';
import {taskState} from './ofocus/taskState.js';
import {buildTaskTagPatch} from './ofocus/writer.js';
import {handoffNotePatch} from './ofocus/handoffNote.js';
import {handoffReason} from './handoffLink.js';
import {nativeWrite} from './nativeBridge.js';
import {readLocalDatabase} from './localDatabase.js';
export const workflowName=(s:string)=>s.replace(/^[^\p{L}\p{N}]+/u,'').trim();
export function monitorTask(db:Database,id:string){const live=taskState(db,id),eligible=taskState(db,id,true);return {...live,monitorEligible:eligible.available,monitorBlockers:eligible.availabilityBlockers};}
export function validateLegacyTransition(input:any,previous:any,current:any){
 const tags=current.tags.map(workflowName);
 if(previous?.runId===input.runId&&previous.event===input.event&&input.event!=='start'){
  if(typeof previous.reason!=='string'||previous.reason.trim()!==input.reason.trim())throw Error('Confirmed event payload differs; cannot change handoff reason');
  return {ok:true,id:input.id,event:input.event,tags:current.tags,completed:current.completed,backend:'local',replayed:true};
 }
 if(current.isProject||current.completed||current.dropped||!current.available)throw Error('An available Action is required');
 if(!tags.includes('AFK')||tags.includes('HITL'))throw Error('AFK required and human handoff must be cleared by the human');
 if(input.event==='start'){
  if(previous?.runId===input.runId&&previous.event!=='start')throw Error('Run already ended');
  if(previous?.runId===input.runId&&previous.event==='start'&&!tags.includes('进行中'))throw Error('Progress removed; refusing restart');
  if(tags.includes('进行中')&&previous?.runId!==input.runId)throw Error('Action already owned');
 }else if(previous?.runId!==input.runId||previous.event!=='start'||!tags.includes('进行中'))throw Error('Claim Action first; ownership or progress changed');
 // Validate the actual Codex link before persisting a write intent.
 if(input.event!=='start')handoffReason(input.reason,input);
 return null;
}
/** Atomic tag/note delta; all ownership protocols share this storage-independent planner. */
export function planWorkflowWrite(db:Database,id:string,event:string,before:any,reason:string|undefined,monitor=false){
 const live=monitor?monitorTask(db,id):taskState(db,id),tags=live.tags.map(workflowName);
 if(live.isProject||live.completed||live.dropped||!(monitor?(live as any).monitorEligible:live.available)||!tags.includes('AFK')||tags.includes('HITL'))throw Error('Action changed or no longer executable');
 if(monitor&&!tags.includes('等待'))throw Error('Monitor waiting tag removed');
 if(live.note!==(before.note??'')||live.modified!==before.modified||JSON.stringify(live.tagIds)!==JSON.stringify(before.tagIds))throw Error('Action changed before transaction; refresh without overwriting human changes');
 if(event!=='start'&&!tags.includes('进行中'))throw Error('Progress removed');
 const needsHandoff=['done','needs_human'].includes(event);
 const addName=event==='start'?'进行中':needsHandoff?'HITL':null;
 const removeName=event==='start'?'HITL':'进行中';
 const resolve=(name:string)=>{const found=[...db.tags.values()].filter(t=>workflowName(t.name)===name);if(found.length!==1)throw Error('Missing or ambiguous workflow tag: '+name);return found[0].id;};
 const addId=addName?resolve(addName):null,removeId=resolve(removeName);
 const task=db.tasks.get(id)!;
 const notePatch=needsHandoff?handoffNotePatch(db,id,event as 'done'|'needs_human',reason??''):{};
 return buildTaskTagPatch(id,{addIds:addId&&!live.tagIds.includes(addId)?[addId]:[],removeJoinIds:db.taskTagJoins(id).filter(j=>j.tagId===removeId).map(j=>j.id),clearPrimary:task.primaryTagId===removeId,added:task.added,...notePatch});
}
export async function writeWorkflow(id:string,event:string,before:any,reason?:string,monitor=false){
 const result=await nativeWrite('of_workflow_write',{id,event,before,reason,monitor});
 const expected=new Set<string>(before.tags.map(workflowName));
 expected.delete(event==='start'?'HITL':'进行中');
 if(event==='start')expected.add('进行中');else if(['done','needs_human'].includes(event))expected.add('HITL');
 let note=before.note||'';
 if(['done','needs_human'].includes(event)){const handoff=(event==='done'?'交付：':'需要你处理：')+(reason||'');if(!note.endsWith(handoff))note+=(note?'\n\n':'')+handoff;}
 for(let attempt=0;attempt<6;attempt++){
  const after=taskState(await readLocalDatabase(),id);
  if(!after.completed&&!after.dropped&&after.note===note&&JSON.stringify([...expected].sort())===JSON.stringify(after.tags.map(workflowName).sort()))return {...result,id,event,tags:after.tags,completed:after.completed,databaseVisibility:'verified'};
  if(attempt<5)await new Promise(resolve=>setTimeout(resolve,500));
 }
 throw Error('Native write acknowledged but database has not caught up. Outcome uncertain; inspect before retry. No forced save or database fallback performed.');
}
