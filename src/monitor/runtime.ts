import os from 'node:os';
import path from 'node:path';
import {readLocalDatabase} from '../localDatabase.js';
import {monitorTask,writeWorkflow} from '../workflowWrites.js';
import {Monitor} from './engine.js';
export const root=()=>process.env.OF_AGENT_STATE_DIR||path.join(os.homedir(),'.local/state/omnifocus-agent');
// Reject every known independent blocker; never mutate tags to probe availability.
export const eligibilityScript=`
const monitorView=t=>{
 const v=view(t),reasons=[];let waitingBlocked=false;
 if(v.isProject||v.completed||v.dropped)reasons.push('inactive');
 if(t.children&&t.children.length)reasons.push('action-group');
 const p=t.containingProject;if(p&&p.status!==Project.Status.Active)reasons.push('project-inactive');
 for(let n=t;n;n=n.parent){
  if(n.completed||[Task.Status.Completed,Task.Status.Dropped].includes(n.taskStatus))reasons.push('ancestor-inactive');
  if((n.effectiveDeferDate||n.deferDate)&&new Date(n.effectiveDeferDate||n.deferDate).getTime()>Date.now())reasons.push('deferred');
  for(const tag of n.tags||[]){for(let g=tag;g;g=g.parent){
   if(g.status===Tag.Status.Dropped)reasons.push('dropped-tag');
   else if(g.status===Tag.Status.OnHold){if(norm(g.name)==='等待')waitingBlocked=true;else reasons.push('other-held-tag');}
  }}
  if(n.parent&&n.parent.sequential){const siblings=n.parent.children||[],index=siblings.indexOf(n);if(index<0)reasons.push('unknown-sequence');else if(siblings.slice(0,index).some(s=>!s.completed&&s.taskStatus!==Task.Status.Dropped))reasons.push('sequential-predecessor');}
 }
 if(!v.available&&(!waitingBlocked||v.ofStatus!=='Blocked'))reasons.push('unexplained-native-block');
 return {...v,monitorEligible:reasons.length===0,monitorBlockers:[...new Set(reasons)]};
};`;
export async function readMonitorTask(id:string){return monitorTask(await readLocalDatabase(),id);}
export function monitorWriteScript(id:string,event:string,before:any,reason?:string){return eligibilityScript+`
const t=flattenedTasks.find(t=>t.id.primaryKey===${JSON.stringify(id)});if(!t)throw Error('Action not found');
const expected=${JSON.stringify(before)},v=monitorView(t),event=${JSON.stringify(event)},reason=${JSON.stringify(reason||'')},ns=v.tags.map(norm);
if(!v.monitorEligible||!ns.includes('AFK')||!ns.includes('等待')||ns.includes('HITL')||ns.includes('进行中')!==(event!=='start'))throw Error('Monitor state revoked');
if(v.note!==expected.note||JSON.stringify(v.tags)!==JSON.stringify(expected.tags))throw Error('Action changed before monitor write');
const progress=flattenedTags.filter(t=>norm(t.name)==='进行中'),hitl=flattenedTags.filter(t=>norm(t.name)==='HITL');
if(progress.length!==1||(['done','needs_human'].includes(event)&&hitl.length!==1))throw Error('Missing or ambiguous workflow tags');
if(event==='start')t.addTag(progress[0]);else{if(['done','needs_human'].includes(event)){t.addTag(hitl[0]);t.note=(t.note?t.note+'\\n\\n':'')+(event==='done'?'交付：':'需要你处理：')+reason;}t.removeTag(progress[0]);}
JSON.stringify({ok:true});`;}
export function writable(){if(/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY||''))throw Error('Server is read-only');}
export function monitor(){return new Monitor(root(),{read:readMonitorTask,async write(id,event,before,reason){writable();await writeWorkflow(id,event,before,reason,true);}});}
