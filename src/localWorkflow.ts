import {currentBackend} from './backend.js';
import {handoffReason} from './handoffLink.js';
import {databaseTask,databaseTaskList} from './databaseReads.js';
import {readLocalDatabase} from './localDatabase.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const state=path.join(os.homedir(),'.local/state/omnifocus-agent');
export const helpers=`
const norm=n=>n.replace(/^[^\\p{L}\\p{N}]+/u,'').trim();
const inactive=t=>{for(let n=t;n;n=n.parent){if(n.completed||n.taskStatus===Task.Status.Completed)return 'completed';if(n.taskStatus===Task.Status.Dropped)return 'dropped';}const p=t.containingProject;if(p&&p.status===Project.Status.Dropped)return 'dropped';if(p&&p.status===Project.Status.Done)return 'completed';return null;};
const nativeStatus=t=>['Available','Next','DueSoon','Overdue','Blocked','Completed','Dropped'].find(k=>Task.Status[k]!==undefined&&t.taskStatus===Task.Status[k])||'Unknown';
const projectLifecycle=t=>{const p=t.containingProject;if(!p)return null;return [['Active','active'],['OnHold','on hold'],['Done','done'],['Dropped','dropped']].find(([k])=>Project.Status[k]!==undefined&&p.status===Project.Status[k])?.[1]||'unknown';};
const projectAllowsExecution=t=>!t.containingProject||projectLifecycle(t)==='active';
const isAvailable=t=>!inactive(t)&&projectAllowsExecution(t)&&['Available','Next','DueSoon','Overdue'].includes(nativeStatus(t));
const iso=d=>d?d.toISOString():null;
const view=t=>({id:t.id.primaryKey,tagIds:t.tags.map(x=>x.id?x.id.primaryKey:null),added:iso(t.added),modified:iso(t.modified),planned:iso(t.plannedDate),effectiveDue:iso(t.effectiveDueDate),effectiveDefer:iso(t.effectiveDeferDate),repetitionRule:t.repetitionRule?t.repetitionRule.ruleString:null,repetitionMethod:t.repetitionRule?(t.repetitionRule.scheduleType===Task.RepetitionScheduleType.Regularly?'fixed':t.repetitionRule.anchorDateKey===Task.AnchorDateKey.DeferDate?'start-after-completion':'due-after-completion'):null,repetitionScheduleType:t.repetitionRule?(t.repetitionRule.scheduleType===Task.RepetitionScheduleType.Regularly?'from-assigned':'from-completion'):null,repetitionAnchorDate:t.repetitionRule?(t.repetitionRule.anchorDateKey===Task.AnchorDateKey.DeferDate?'dateToStart':t.repetitionRule.anchorDateKey===Task.AnchorDateKey.PlannedDate?'datePlanned':'dateDue'):null,catchUpAutomatically:t.repetitionRule?!!t.repetitionRule.catchUpAutomatically:false,order:t.sequential?'sequential':'parallel',completedByChildren:!!t.completedByChildren,childrenCount:t.children?t.children.length:0,projectStatus:projectLifecycle(t),projectAllowsExecution:projectAllowsExecution(t),statusScope:t.containingProject&&t.containingProject.task===t?'project-root-task':'action',statusInterpretation:t.containingProject&&t.containingProject.task===t?'ofStatus/available describe the project root TASK only. Blocked here does not mean the project is paused; use projectStatus for project lifecycle and the target child available for execution.':'ofStatus/available describe this action; AFK, HITL, ownership and authorization checks are separate',name:t.name,note:t.note||'',tags:t.tags.map(x=>x.name),tagNames:t.tags.map(x=>x.name),projectName:t.containingProject?t.containingProject.name:null,estimatedMinutes:t.estimatedMinutes,inInbox:t.inInbox,status:inactive(t)||'active',completed:inactive(t)==='completed',dropped:inactive(t)==='dropped',isProject:!!(t.containingProject&&t.containingProject.task===t),project:t.containingProject?t.containingProject.name:null,parentId:t.parent?t.parent.id.primaryKey:null,defer:t.deferDate?t.deferDate.toISOString():null,due:t.dueDate?t.dueDate.toISOString():null,flagged:t.flagged,available:isAvailable(t),ofStatus:nativeStatus(t),statusSource:'omnifocus',completionDate:t.completionDate?t.completionDate.toISOString():null});
`;
/** Hard-disabled: no child process, app launch, permission prompt, or fallback. */
export async function evaluate(_code:string):Promise<any>{
 throw Error('AppleScript/JXA/osascript automation is disabled. Local automation writes and native-only features are unavailable; reads use the local database.');
}
export async function getLiveTask(id:string){return databaseTask(id);}
export async function getTask(id:string,attachmentOffset=0,attachmentLimit=20){return databaseTask(id,attachmentOffset,attachmentLimit);}
export function listScript(args:any){
 const a={...args,limit:args.limit??50,offset:args.offset??0};
 if(a.done!==undefined){const m=/^--done([1-9][0-9]*)$/.exec(a.done);if(!m)throw Error('Use --doneN, for example --done7');if(a.doneDays!==undefined&&a.doneDays!==Number(m[1]))throw Error('Conflicting done windows');a.doneDays=Number(m[1]);}
 if(!Number.isInteger(a.limit)||a.limit<1||a.limit>200||!Number.isInteger(a.offset)||a.offset<0)throw Error('limit must be 1–200; offset must be nonnegative');
 if(a.doneDays!==undefined&&(!Number.isSafeInteger(a.doneDays)||a.doneDays<1))throw Error('doneDays must be a positive integer');
 if(a.includeCompleted&&!a.doneDays)throw Error('Use doneDays or --doneN to request completed tasks');
 return `const a=${JSON.stringify(a)},now=Date.now(),cutoff=now-(a.doneDays||0)*86400000;
 let rows=flattenedTasks.filter(t=>!(t.containingProject&&t.containingProject.task===t)&&inactive(t)!=='dropped');
 rows=rows.filter(t=>a.doneDays?(t.completed&&t.completionDate&&t.completionDate.getTime()>=cutoff&&t.completionDate.getTime()<=now):!inactive(t));
 if(a.project)rows=rows.filter(t=>t.containingProject&&t.containingProject.name===a.project);
 if(a.tag)rows=rows.filter(t=>t.tags.some(x=>norm(x.name)===norm(a.tag)));
 if(a.search)rows=rows.filter(t=>(t.name+' '+t.note).toLowerCase().includes(a.search.toLowerCase()));
 if(a.filter==='available')rows=rows.filter(t=>isAvailable(t));
 if(a.filter==='flagged')rows=rows.filter(t=>t.flagged);
 if(a.filter==='inbox')rows=rows.filter(t=>t.inInbox);
 if(a.filter==='due_soon')rows=rows.filter(t=>(t.effectiveDueDate||t.dueDate)&&(t.effectiveDueDate||t.dueDate).getTime()<=now+(a.dueWithinDays??7)*86400000);
 rows.sort((x,y)=>(a.doneDays?y.completionDate.getTime()-x.completionDate.getTime():0)||x.id.primaryKey.localeCompare(y.id.primaryKey));
 const total=rows.length;const tasks=rows.slice(a.offset,a.offset+a.limit).map(t=>({id:t.id.primaryKey,name:t.name,tags:t.tags.map(x=>x.name),project:t.containingProject?t.containingProject.name:null,completed:!!t.completed,ofStatus:nativeStatus(t),available:isAvailable(t),statusSource:'omnifocus',completionDate:t.completionDate?t.completionDate.toISOString():null,flagged:!!t.flagged,effectiveDue:t.effectiveDueDate?t.effectiveDueDate.toISOString():null,due:t.dueDate?t.dueDate.toISOString():null}));
 JSON.stringify({count:tasks.length,total,limit:a.limit,offset:a.offset,hasMore:a.offset+tasks.length<total,nextOffset:a.offset+tasks.length<total?a.offset+tasks.length:null,tasks,backend:'local',runtimeRevision:'2026-11-03-audit-2'});`;
}
// Read the local transaction database without launching OmniFocus.
export async function listTasks(args:any){return databaseTaskList(args);}
export async function sync(){const db=await readLocalDatabase();return {tasks:db.tasks.size,tags:db.tags.size,backend:currentBackend()+'-database'};}
export function transitionScript(input:any,previous:any,expected:any,validateOnly=false){const renderedReason=input.event==='start'?'':previous?.runId===input.runId&&previous?.event===input.event?(input.reason||'').trim():handoffReason(input.reason||'',input);return `
const a=${JSON.stringify(input)},previous=${JSON.stringify(previous||null)},expected=${JSON.stringify(expected)};
const task=flattenedTasks.find(t=>t.id.primaryKey===a.id);if(!task)throw Error('Action not found');
const current=view(task);
if(previous&&previous.runId===a.runId&&previous.event===a.event&&a.event!=='start'){
if(typeof previous.reason!=='string'||previous.reason.trim()!==a.reason.trim())throw Error('Confirmed event payload differs; cannot change handoff reason');
JSON.stringify(${validateOnly}?{validated:true}:{ok:true,id:a.id,event:a.event,tags:current.tags,completed:current.completed,backend:'local',replayed:true});
}else{
if(current.isProject||current.completed||current.dropped)throw Error('An active Action is required');
if(current.note!==expected.note||JSON.stringify(current.tags)!==JSON.stringify(expected.tags))throw Error('Action changed during transition; retry same runId');
const tags=current.tags.map(norm);if(!tags.includes('AFK'))throw Error('Action must have AFK tag');
if(a.event==='start'){if(tags.includes('HITL'))throw Error('Human handoff is pending; human must remove HITL before reassigning');if(!current.available)throw Error('Action is not available for execution');if(previous&&previous.runId===a.runId&&previous.event!=='start')throw Error('Run already ended');if(previous&&previous.runId===a.runId&&previous.event==='start'&&!tags.includes('进行中'))throw Error('Progress was removed; refusing to restart this run');if(tags.includes('进行中')&&(!previous||previous.runId!==a.runId))throw Error('Action is already owned; refusing takeover');}
else if(!previous||previous.runId!==a.runId||!['start',a.event].includes(previous.event))throw Error('Claim Action first');
if(previous&&previous.runId===a.runId&&previous.event==='start'&&!tags.includes('进行中')&&a.event!=='start')throw Error('Progress was removed; human state change requires review');
const add=a.event==='start'?['进行中']:['HITL'],remove=a.event==='start'?'HITL':'进行中';
const resolved=add.map(n=>{const found=flattenedTags.filter(t=>norm(t.name)===n);if(found.length>1)throw Error('Ambiguous tag: '+n);return {name:n,tag:found[0]};});
if(flattenedTags.filter(t=>norm(t.name)===remove).length>1)throw Error('Ambiguous workflow tag');
if(${validateOnly}){JSON.stringify({validated:true});}else{
for(const entry of resolved)task.addTag(entry.tag||new Tag(entry.name));
for(const t of [...task.tags])if(norm(t.name)===remove)task.removeTag(t);
if(a.event!=='start'){const handoff=(a.event==='done'?'交付：':'需要你处理：')+${JSON.stringify(renderedReason)};if(!(task.note||'').endsWith(handoff))task.note=(task.note?task.note+'\\n\\n':'')+handoff;}
const after=view(task);if(!add.every(n=>after.tags.map(norm).includes(n))||after.tags.map(norm).includes(remove))throw Error('Local transition verification failed');
JSON.stringify({ok:true,id:a.id,event:a.event,tags:after.tags,completed:after.completed,backend:'local'});}
}
`;}
async function atomic(file:string,data:any){const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(data),{mode:0o600});await fs.rename(tmp,file);}
export async function transition(input:any){
 // Protocol gate: old callers cannot overwrite v2 ownership after cutover.
 if(input.protocolVersion!==2)throw Error('Ownership protocol v2 required; upgrade all hosts before cutover');
 const {transitionV2}=await import('./ledger/runtime.js');
 return transitionV2(input);
}
