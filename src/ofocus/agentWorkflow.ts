import { Database } from './database.js';
import { createId } from '../crypto/index.js';
import { buildTaskTagPatch } from './writer.js';

export const workflowTagName = (name:string) => name.replace(/^[^\p{L}\p{N}]+/u, '').trim();

export type AgentEvent = 'start' | 'done' | 'needs_human';
export interface AgentTransition {id:string;event:AgentEvent;runId:string;reason?:string}
/** Pure planner, usable in tests without a live sync account. */
export function planAgentTransition(db:Database,input:AgentTransition): {xml:string|null} {
 const task=db.tasks.get(input.id);
 if(!task || task.isProject) throw new Error('An existing Action ID is required');
 if(db.view(task).status !== 'active') throw new Error('Completed/dropped Actions cannot be claimed');
 if(!input.runId.trim() || input.runId.length>160) throw new Error('A stable runId is required');
 if(input.event !== 'start' && !input.reason?.trim()) throw new Error('Describe the deliverable or required human decision');
 const tags=db.view(task).tagNames.map(workflowTagName);
 if(!tags.includes('AFK')) throw new Error('Action must have AFK tag');
 const records=[...(task.note??'').matchAll(/\[of-agent:([A-Za-z0-9_-]+)\]/g)];
 let previous: {runId:string;event:AgentEvent}|undefined;
 if(records.length){try{previous=JSON.parse(Buffer.from(records.at(-1)![1],'base64url').toString());}catch{throw new Error('Invalid workflow ownership record');}}
 if(input.event==='start'){
  if(previous?.runId===input.runId && previous.event!=='start') throw new Error('This run already ended; use a new runId after human approval');
  if(tags.includes('进行中') && previous?.runId!==input.runId) throw new Error('Action is already being processed; do not steal ownership');
 }else if(previous?.runId!==input.runId || (previous.event!=='start' && previous.event!==input.event)){
  throw new Error('Claim the Action first with this runId');
 }
 const target=input.event==='start'?'进行中':'PHV';
 const unwanted=input.event==='start'?'PHV':'进行中';
 if(previous?.runId===input.runId && previous.event===input.event && tags.includes(target) && !tags.includes(unwanted) && (input.event!=='start'||tags.includes('等待'))) return {xml:null};
 const createTags:{id:string;name:string}[]=[];
 function resolve(name:string,create:boolean):string|null{
  const found=[...db.tags.values()].filter(t=>workflowTagName(t.name)===name);
  if(found.length>1)throw new Error('Ambiguous workflow tag: '+name);
  if(found.length)return found[0].id;
  if(!create)return null;
  const id=createId();createTags.push({id,name});return id;
 }
 const addId=resolve(target,true)!;const waitingId=input.event==='start'?resolve('等待',true):null;const removeId=resolve(unwanted,false);
 const current=new Set(db.view(task).tagIds);
 const record=Buffer.from(JSON.stringify({runId:input.runId,event:input.event})).toString('base64url');
 const title=input.event==='start'?'Agent 开始处理':input.event==='done'?'Agent 已交付，等待验收':'需要人类介入';
 const reason=(input.reason??'').replace(/\[of-agent:/g,'[of-agent-note:');
 const note=(task.note?task.note+'\n\n':'')+`[${new Date().toISOString()}] ${title}\n${reason}\n[of-agent:${record}]`;
 return {xml:buildTaskTagPatch(task.id,{createTags,addIds:[addId,...(waitingId?[waitingId]:[])].filter(id=>!current.has(id)),removeJoinIds:db.taskTagJoins(task.id).filter(j=>j.tagId===removeId).map(j=>j.id),clearPrimary:!!removeId&&task.primaryTagId===removeId,added:task.added,note})};
}
