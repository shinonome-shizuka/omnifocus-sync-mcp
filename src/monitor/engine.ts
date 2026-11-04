import {handoffBody,handoffReason} from '../handoffLink.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import {key,read,save,lock} from './store.js';
export interface Config {source:string;intervalMinutes:number;timeZone:string;notifyWhen:string;maxFailures:number;enabled:boolean;nextCheckAt:string}
export interface Port {read(id:string):Promise<any>;write(id:string,event:string,before:any,reason?:string):Promise<void>}
const names=(t:any)=>(t.tags||[]).map((n:string)=>n.replace(/^[^\p{L}\p{N}]+/u,'').trim());
export function eligible(t:any,active=false){const tags=names(t);if(t.isProject||t.completed||t.dropped||!t.monitorEligible||!tags.includes('AFK')||!tags.includes('等待')||tags.includes('HITL')||tags.includes('进行中')!==active)throw Error('Monitor Action is inactive, blocked, revoked or owned');}
export function configValid(c:Config){if(!c.source?.trim()||!c.notifyWhen?.trim()||!Number.isInteger(c.intervalMinutes)||c.intervalMinutes<1||c.intervalMinutes>525600||!Number.isInteger(c.maxFailures)||c.maxFailures<1||c.maxFailures>100||!Number.isFinite(Date.parse(c.nextCheckAt))||typeof c.enabled!=='boolean')throw Error('Invalid monitor configuration');new Intl.DateTimeFormat('en',{timeZone:c.timeZone}).format();if(!c.timeZone)throw Error('Time zone required');}
export class Monitor {
 constructor(readonly root:string,readonly port:Port,readonly now=()=>Date.now()){}
 file(id:string){return path.join(this.root,'monitors',key(id)+'.json');}
 async get(id:string){return await read(this.file(id))||{id,revision:0,events:[],failures:0};}
 async foreign(id:string){const k=key(id);for(const f of ['ledger-v2/'+k+'.json','pending/'+k+'.json','local-ownership/'+k+'.json.intent'])if(await read(path.join(this.root,f)))throw Error('Other ledger or uncertain transition exists');const owner=await read(path.join(this.root,'local-ownership',k+'.json'));if(owner&&owner.mode!=='monitor'&&!['done','needs_human'].includes(owner.event))throw Error('Another run owns this Action');return owner;}
 async configure(id:string,c:Config,revision:number){configValid(c);return lock(this.root,id,async()=>{await this.foreign(id);const d=await this.get(id);if(d.revision!==revision||d.active||d.intent)throw Error('Revision conflict or active/uncertain round');eligible(await this.port.read(id));d.config=c;d.revision++;d.events.push({type:'configured',at:new Date(this.now()).toISOString(),revision:d.revision,config:c});await save(this.file(id),d);return {ok:true,...d};});}
 async check(id:string,runId:string){return lock(this.root,id,async()=>{await this.foreign(id);const d=await this.get(id);if(d.intent||!d.config?.enabled||d.active?.runId!==runId)throw Error('No confirmed active monitor claim');const o=await read(path.join(this.root,'local-ownership',key(id)+'.json'));if(o?.runId!==runId||o?.event!=='monitor_start')throw Error('Monitor owner mismatch');const t=await this.port.read(id);eligible(t,true);return {ok:true,id,runId,revision:d.revision};});}
 async transition(a:any){if(a.event!=='start'&&a.summary?.trim())a={...a,summary:handoffReason(a.summary,a)};return lock(this.root,a.id,async()=>{
  if(!a.id||!a.runId?.trim()||!a.eventId?.trim()||!['start','checked','done','needs_human'].includes(a.event))throw Error('Invalid monitor event');
  await this.foreign(a.id);const d=await this.get(a.id);if(d.intent)throw Error('Uncertain monitor write; inspect, never automatically replay');
  const duplicate=d.events.find((e:any)=>e.eventId===a.eventId);if(duplicate){if(JSON.stringify(duplicate.request)!==JSON.stringify(a))throw Error('Event payload conflict');return duplicate.result;}
  if(a.expectedRevision!==d.revision)throw Error('Revision conflict');if(!d.config?.enabled)throw Error('Monitor is disabled');
  const owner=await read(path.join(this.root,'local-ownership',key(a.id)+'.json'));
  if(a.event==='start'&&owner?.event==='monitor_start')throw Error('Unresolved monitor owner');
  if(a.event!=='start'&&(owner?.runId!==a.runId||owner?.event!=='monitor_start'))throw Error('Monitor owner mismatch');
  const before=await this.port.read(a.id);eligible(before,a.event!=='start');
  if(a.event==='start'){
   if(d.active||Date.parse(d.config.nextCheckAt)>this.now())throw Error('Monitor active or not due');
   if(d.events.some((e:any)=>e.request?.runId===a.runId))throw Error('Closed runId cannot be reused');
   if(!a.sessionId?.trim()||!['codex','hermes'].includes(a.platform))throw Error('Actor session required');
  }else{
   if(d.active?.runId!==a.runId||d.active?.sessionId!==a.sessionId||d.active?.platform!==a.platform)throw Error('Monitor owner mismatch');
   if(!a.summary?.trim())throw Error('Summary required');
   if(a.event==='checked'&&!['unchanged','changed','error'].includes(a.outcome))throw Error('Outcome required');
   if(a.event==='checked'&&a.outcome!=='error'&&(!a.fingerprint?.trim()||!a.evidence?.trim()))throw Error('State fingerprint and evidence required');
   if(a.outcome==='unchanged'&&d.fingerprint&&a.fingerprint!==d.fingerprint)throw Error('Changed fingerprint cannot be reported unchanged');
  }
  const original=structuredClone(d);const at=new Date(this.now()).toISOString();let notify=false,event=a.event;
  if(a.event==='checked'&&a.outcome==='error'){d.failures++;if(d.failures>=d.config.maxFailures)event='needs_human';}
  else if(a.event!=='start')d.failures=0;
  if(a.event==='checked'&&a.outcome!=='error'){
   notify=a.outcome==='changed'&&a.fingerprint!==d.notifiedFingerprint;
   d.fingerprint=a.fingerprint;d.evidence=a.evidence;
   if(notify)d.notifiedFingerprint=a.fingerprint;
  }
  if(['done','needs_human'].includes(event))notify=true;
  const result={ok:true,id:a.id,runId:a.runId,event:a.event,effectiveEvent:event,revision:d.revision+1,notify};
  // Intent fences crashes between native OF write, ledger and compatibility owner writes.
  d.intent={request:a,before,at,original,previousOwner:owner,effectiveEvent:event,result};await save(this.file(a.id),d);
  await this.port.write(a.id,event,before,a.summary);
  const after=await this.port.read(a.id),tags=names(after),old=names(before);
  const expected=old.filter((n:string)=>n!=='进行中');if(event==='start')expected.push('进行中');if(['done','needs_human'].includes(event))expected.push('HITL');
  const expectedNote=['done','needs_human'].includes(event)?(before.note?before.note+'\n\n':'')+(event==='done'?'交付：':'需要你处理：')+handoffBody(a.summary,event):before.note;
  if(JSON.stringify([...tags].sort())!==JSON.stringify([...new Set(expected)].sort())||after.completed||after.dropped||(after.note||'')!==(expectedNote||''))throw Error('Monitor write verification failed; intent retained');
  d.revision++;if(event==='start')d.active={runId:a.runId,sessionId:a.sessionId,platform:a.platform,at};else{d.active=null;d.lastCheckedAt=at;d.summary=a.summary;d.config.nextCheckAt=new Date(this.now()+d.config.intervalMinutes*60000).toISOString();if(event!=='checked')d.config.enabled=false;}
  d.events.push({type:event,eventId:a.eventId,at,request:a,result});
  await save(path.join(this.root,'local-ownership',key(a.id)+'.json'),{id:a.id,runId:a.runId,mode:'monitor',event:event==='start'?'monitor_start':event==='checked'?'monitor_checked':event,at});
  delete d.intent;await save(this.file(a.id),d);return result;
 });}
 async reconcile(id:string,revision:number,decision:'accept_written'|'discard_not_written',reason:string){
  if(!reason?.trim())throw Error('Operator reason required');
  return lock(this.root,id,async()=>{
   const d=await this.get(id),i=d.intent;if(!i||d.revision!==revision)throw Error('No matching uncertain intent');
   const live=await this.port.read(id),a=i.request,event=i.effectiveEvent;
   const owner=await read(path.join(this.root,'local-ownership',key(id)+'.json'));
   if(JSON.stringify(owner)!==JSON.stringify(i.previousOwner)&&!(owner?.mode==='monitor'&&owner.runId===a.runId&&owner.at===i.at))throw Error('Ownership changed during uncertainty; operator review required');
   if(live.completed||live.dropped)throw Error('Inactive Action requires separate operator review');
   const same=(x:any,y:any)=>JSON.stringify([...names(x)].sort())===JSON.stringify([...names(y)].sort())&&(x.note||'')===(y.note||'');
   if(decision==='discard_not_written'){
    // A start only adds the progress tag: an operator may discard it after a
    // description-only edit when neither the native effect nor a new owner exists.
    // Never replay a write or restore the old note; every other field stays fenced.
    const unchangedFields=[...new Set([...Object.keys(live),...Object.keys(i.before)])]
      .filter(k=>k!=='note'&&k!=='modified').every(k=>JSON.stringify(k==='snapshot'?{...live[k],observedAt:undefined}:live[k])===JSON.stringify(k==='snapshot'?{...i.before[k],observedAt:undefined}:i.before[k]));
    const descriptionOnlyStart=a.event==='start'&&event==='start'&&!i.original.active&&
      !names(i.before).includes('进行中')&&!names(live).includes('进行中')&&unchangedFields&&
      JSON.stringify(owner)===JSON.stringify(i.previousOwner);
    if((!same(live,i.before)||live.modified!==i.before.modified)&&!descriptionOnlyStart)throw Error('Before snapshot differs; cannot discard uncertain write');
    const restored=i.original;restored.revision++;restored.events.push({type:'reconciled_not_written',at:new Date(this.now()).toISOString(),reason,request:a});await save(this.file(id),restored);return {ok:true,id,status:'not_applied',revision:restored.revision};
   }
   if(decision!=='accept_written')throw Error('Invalid reconciliation');
   const tags=names(i.before).filter((n:string)=>n!=='进行中');if(event==='start')tags.push('进行中');if(['done','needs_human'].includes(event))tags.push('HITL');
   const note=['done','needs_human'].includes(event)?(i.before.note?i.before.note+'\n\n':'')+(event==='done'?'交付：':'需要你处理：')+handoffBody(a.summary,event):i.before.note;
   if(!same(live,{tags,note}))throw Error('After snapshot differs; do not overwrite human changes');
   if(event==='start')eligible(live,true);
   d.revision++;if(event==='start')d.active={runId:a.runId,sessionId:a.sessionId,platform:a.platform,at:i.at};else{d.active=null;d.lastCheckedAt=i.at;d.summary=a.summary;d.config.nextCheckAt=new Date(this.now()+d.config.intervalMinutes*60000).toISOString();if(event!=='checked')d.config.enabled=false;}
   d.events.push({type:event,eventId:a.eventId,at:i.at,request:a,result:i.result,reconciledAt:new Date(this.now()).toISOString(),reason});
   await save(path.join(this.root,'local-ownership',key(id)+'.json'),{id,runId:a.runId,mode:'monitor',event:event==='start'?'monitor_start':event==='checked'?'monitor_checked':event,at:i.at});
   delete d.intent;await save(this.file(id),d);return i.result;
  });
 }
 async due(limit=50,offset=0){if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)throw Error('Invalid page');const dir=path.join(this.root,'monitors');const files=await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});const rows=[];
  for(const f of files){const d=await read(path.join(dir,f));if(!d?.config?.enabled||d.active||d.intent||Date.parse(d.config.nextCheckAt)>this.now())continue;try{await this.foreign(d.id);const t=await this.port.read(d.id);eligible(t);const p=names(t).filter((n:string)=>/^P[0-3]$/.test(n)).map((n:string)=>Number(n[1]));rows.push({id:d.id,revision:d.revision,nextCheckAt:d.config.nextCheckAt,priority:p.length?Math.min(...p):4});}catch{/* Candidate rechecked on next tick; never override revocation. */}}
  rows.sort((a,b)=>a.priority-b.priority||a.nextCheckAt.localeCompare(b.nextCheckAt)||a.id.localeCompare(b.id));return {tasks:rows.slice(offset,offset+limit),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null};
 }
}
