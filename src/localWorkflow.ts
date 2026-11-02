import {localViews,readLocalDatabase} from './localDatabase.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const state=path.join(os.homedir(),'.local/state/omnifocus-agent');
export const helpers=`
const norm=n=>n.replace(/^[^\\p{L}\\p{N}]+/u,'').trim();
const inactive=t=>{for(let n=t;n;n=n.parent){if(n.completed||n.taskStatus===Task.Status.Completed)return 'completed';if(n.taskStatus===Task.Status.Dropped)return 'dropped';}const p=t.containingProject;if(p&&p.status===Project.Status.Dropped)return 'dropped';if(p&&p.status===Project.Status.Done)return 'completed';return null;};
const view=t=>({id:t.id.primaryKey,name:t.name,note:t.note||'',tags:t.tags.map(x=>x.name),tagNames:t.tags.map(x=>x.name),projectName:t.containingProject?t.containingProject.name:null,estimatedMinutes:t.estimatedMinutes,inInbox:t.inInbox,status:inactive(t)||'active',completed:inactive(t)==='completed',dropped:inactive(t)==='dropped',isProject:!!(t.containingProject&&t.containingProject.task===t),project:t.containingProject?t.containingProject.name:null,parentId:t.parent?t.parent.id.primaryKey:null,defer:t.deferDate?t.deferDate.toISOString():null,due:t.dueDate?t.dueDate.toISOString():null,flagged:t.flagged,available:t.taskStatus===Task.Status.Available});
`;
export async function evaluate(code:string){
 const file=path.join(os.tmpdir(),'of-agent-'+crypto.randomUUID()+'.js');
 const script=`const app=Application('OmniFocus');app.evaluateJavascript(${JSON.stringify('{'+helpers+code+'}')});`;
 await fs.writeFile(file,script,{mode:0o600});
 try{const {stdout}=await exec('/usr/bin/osascript',['-l','JavaScript',file],{timeout:20000,maxBuffer:32*1024*1024});return JSON.parse(stdout.trim());}finally{await fs.unlink(file).catch(()=>{});}
}
export async function getLiveTask(id:string){return evaluate(`const t=flattenedTasks.find(t=>t.id.primaryKey===${JSON.stringify(id)});if(!t)throw Error('Action not found');JSON.stringify(view(t));`);}
export async function getTask(id:string){const t=(await localViews()).find(t=>t.id===id);if(!t)throw Error('Action not found');return t;}
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
 if(a.filter==='available')rows=rows.filter(t=>t.taskStatus===Task.Status.Available);
 if(a.filter==='flagged')rows=rows.filter(t=>t.flagged);
 if(a.filter==='inbox')rows=rows.filter(t=>t.inInbox);
 if(a.filter==='due_soon')rows=rows.filter(t=>t.dueDate&&t.dueDate.getTime()<=now+(a.dueWithinDays??7)*86400000);
 rows.sort((x,y)=>(a.doneDays?y.completionDate.getTime()-x.completionDate.getTime():0)||x.id.primaryKey.localeCompare(y.id.primaryKey));
 const total=rows.length;const tasks=rows.slice(a.offset,a.offset+a.limit).map(t=>({id:t.id.primaryKey,name:t.name,tags:t.tags.map(x=>x.name),project:t.containingProject?t.containingProject.name:null,completed:!!t.completed,completionDate:t.completionDate?t.completionDate.toISOString():null,flagged:!!t.flagged,due:t.dueDate?t.dueDate.toISOString():null}));
 JSON.stringify({count:tasks.length,total,limit:a.limit,offset:a.offset,hasMore:a.offset+tasks.length<total,nextOffset:a.offset+tasks.length<total?a.offset+tasks.length:null,tasks,backend:'local'});`;
}
export async function listTasks(args:any){
 listScript(args);const days=args.doneDays??(args.done?Number(args.done.slice(6)):0),now=Date.now();
 let rows=(await localViews()).filter(t=>!t.isProject&&!t.dropped&&(days?t.completed&&t.completionDate&&Date.parse(t.completionDate)>=now-days*86400000&&Date.parse(t.completionDate)<=now:!t.completed));
 const norm=(n:string)=>n.replace(/^[^\p{L}\p{N}]+/u,'').trim();
 if(args.project)rows=rows.filter(t=>t.project===args.project);
 if(args.tag)rows=rows.filter(t=>t.tags.some(n=>norm(n)===norm(args.tag)));
 if(args.search)rows=rows.filter(t=>(t.name+' '+t.note).toLowerCase().includes(args.search.toLowerCase()));
 if(args.filter==='flagged')rows=rows.filter(t=>t.flagged);
 if(args.filter==='inbox')rows=rows.filter(t=>t.inInbox);
 if(args.filter==='due_soon')rows=rows.filter(t=>t.due&&Date.parse(t.due)<=now+(args.dueWithinDays??7)*86400000);
 if(args.filter==='available'){const ids=new Set(await evaluate("JSON.stringify(flattenedTasks.filter(t=>t.taskStatus===Task.Status.Available).map(t=>t.id.primaryKey));"));rows=rows.filter(t=>ids.has(t.id));}
 rows.sort((a,b)=>(days?Date.parse(b.completionDate!)-Date.parse(a.completionDate!):0)||a.id.localeCompare(b.id));
 const offset=args.offset??0,limit=args.limit??50,total=rows.length;
 const tasks=rows.slice(offset,offset+limit).map(t=>({id:t.id,name:t.name,tags:t.tags,project:t.project,completed:t.completed,completionDate:t.completionDate,flagged:t.flagged,due:t.due}));
 return {tasks,count:tasks.length,total,offset,limit,hasMore:offset+tasks.length<total,nextOffset:offset+tasks.length<total?offset+tasks.length:null,backend:'local-database'};
}
export async function sync(){const db=await readLocalDatabase();return {tasks:db.tasks.size,tags:db.tags.size,backend:'local-database'};}
export function transitionScript(input:any,previous:any,expected:any,validateOnly=false){return `
const a=${JSON.stringify(input)},previous=${JSON.stringify(previous||null)},expected=${JSON.stringify(expected)};
const task=flattenedTasks.find(t=>t.id.primaryKey===a.id);if(!task)throw Error('Action not found');
const current=view(task);if(current.isProject||current.completed||current.dropped)throw Error('An active Action is required');
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
if(a.event!=='start'){const handoff=(a.event==='done'?'交付：':'需要你处理：')+a.reason.trim();if(!(task.note||'').endsWith(handoff))task.note=(task.note?task.note+'\\n\\n':'')+handoff;}
const after=view(task);if(!add.every(n=>after.tags.map(norm).includes(n))||after.tags.map(norm).includes(remove))throw Error('Local transition verification failed');
JSON.stringify({ok:true,id:a.id,event:a.event,tags:after.tags,completed:after.completed,backend:'local'});}
`;}
async function atomic(file:string,data:any){const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(data),{mode:0o600});await fs.rename(tmp,file);}
export async function transition(input:any){
 if(/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY??''))throw Error('Server is read-only');
 if(!input.runId?.trim()||input.runId.length>160||!['start','done','needs_human'].includes(input.event)||!input.id)throw Error('Invalid transition');
 if(input.event!=='start'&&!input.reason?.trim())throw Error('Handoff reason required');
 await fs.mkdir(state,{recursive:true,mode:0o700});
 const lock=path.join(state,'transition-'+crypto.createHash('sha256').update(input.id).digest('hex')+'.lock');
 // Exclusive task lock. Stale locks are retained for explicit inspection rather than unsafe takeover.
 const handle=await fs.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await handle.close();
 try{
  const dirs=['local-ownership','pending'];for(const d of dirs)await fs.mkdir(path.join(state,d),{recursive:true,mode:0o700});
  const key=crypto.createHash('sha256').update(input.id).digest('hex');const ownerFile=path.join(state,'local-ownership',key+'.json'),pending=path.join(state,'pending',key+'.json');
  let owner:any;try{owner=JSON.parse(await fs.readFile(ownerFile,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const task=await getLiveTask(input.id);
  let intent:any;try{intent=JSON.parse(await fs.readFile(ownerFile+'.intent','utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(intent&&(intent.input.runId!==input.runId||intent.input.event!==input.event||intent.input.reason!==input.reason))throw Error('A prior local transition needs recovery with its original request');
  // Import existing local ownership records by exact Action ID, without a sync-server read.
  if(!owner){const dir=path.join(state,'ownership');const files=await fs.readdir(dir).catch(()=>[]);const candidates=[];for(const f of files){const r=JSON.parse(await fs.readFile(path.join(dir,f),'utf8'));if(r.events?.some((e:any)=>e.id===input.id))candidates.push(r.latest);}if(candidates.length>1)throw Error('Multiple ownership records require review');owner=candidates[0];}
  if(!owner){const records=[...task.note.matchAll(/\[of-agent:([A-Za-z0-9_-]+)\]/g)];if(records.length)owner=JSON.parse(Buffer.from(records.at(-1)![1],'base64url').toString());}
  // Validate ownership before recording intent. The intent authorizes only this exact retry.
  if(intent)throw Error('Previous write outcome uncertain; automatic replay disabled to preserve human edits');
  else {await evaluate(transitionScript(input,owner,task,true));await atomic(ownerFile+'.intent',{before:task,input,previous:input.event==='start'?{runId:input.runId,event:'start'}:owner});}
  await atomic(pending,{...input,backend:'local',requestedAt:new Date().toISOString()});
  const result=await evaluate(transitionScript(input,owner,task));
  await atomic(ownerFile,{id:input.id,runId:input.runId,event:input.event,at:new Date().toISOString(),reason:input.reason||''});
  await fs.unlink(pending);await fs.unlink(ownerFile+'.intent');return result;
 }catch(e){const intent=path.join(state,'local-ownership',crypto.createHash('sha256').update(input.id).digest('hex')+'.json.intent');const uncertain=await fs.access(intent).then(()=>true,()=>false);return {ok:false,id:input.id,event:input.event,status:uncertain?'uncertain':'rejected',error:String(e)};}finally{await fs.unlink(lock);}
}
