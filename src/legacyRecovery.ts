import os from 'node:os';import path from 'node:path';import fs from 'node:fs/promises';import crypto from 'node:crypto';
import {key,read,save,lock} from './monitor/store.js';import {databaseTask} from './databaseReads.js';import {handoffReason} from './handoffLink.js';
const normalized=(s:string)=>s.replace(/^[^\p{L}\p{N}]+/u,'').trim();
const canonical=(x:any):string=>JSON.stringify(x===undefined?null:x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=(x:any)=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
const projection=(t:any)=>Object.fromEntries(Object.entries(t).filter(([k])=>!['modified','tags','tagIds','tagNames','snapshot','available','availabilityVerified','availabilityBlockers','ofStatus','statusSource','effectiveDue','effectiveDefer','statusInterpretation','backend','runtimeRevision','projectAllowsExecution'].includes(k)));
const evidence=(t:any)=>({...projection(t),modified:t.modified,tags:[...(t.tags||[])].sort(),statusSource:t.statusSource,available:t.available});
/** Reconcile evidence only. This module never invokes an OF mutation or replays an intent. */
export async function reconcileLegacy(a:any,root=process.env.OF_AGENT_STATE_DIR||path.join(os.homedir(),'.local/state/omnifocus-agent'),readTask:(id:string)=>Promise<any>=databaseTask){
 if(!a.id||!a.runId||!['inspect','accept_written','discard_not_written'].includes(a.decision))throw Error('Invalid recovery request');
 if(a.decision!=='inspect'&&/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY||''))throw Error('Server is read-only');
 return lock(root,a.id,async()=>{
  const k=key(a.id),ownerFile=path.join(root,'local-ownership',k+'.json'),intentFile=ownerFile+'.intent',pendingFile=path.join(root,'pending',k+'.json'),auditFile=path.join(root,'legacy-recovery',k+'.json');
  if(await read(path.join(root,'ledger-v2',k+'.json')))throw Error('V2 ownership requires v2 recovery');
  const owner=await read(ownerFile),intent=await read(intentFile),audit=await read(auditFile),monitor=await read(path.join(root,'monitors',k+'.json'));
  if(owner?.mode==='monitor'||monitor?.active||monitor?.intent)throw Error('Monitor ownership requires monitor recovery');
  if(!intent){
   if(audit?.committed&&audit.result.id===a.id&&audit.result.runId===a.runId&&audit.intentToken===a.expectedIntent&&audit.decision===a.decision&&audit.reason===a.reason)return audit.result;
   throw Error('No unresolved intent for this Action');
  }
  if(intent.input?.id!==a.id||intent.input?.runId!==a.runId)throw Error('Intent belongs to another Action/run');
  const request=intent.input,current=await readTask(a.id),before=intent.before;
  if(!before||current.id!==a.id)throw Error('Missing before snapshot or Action identity mismatch');
  const token=digest({intent,owner,current:evidence(current)}),event=request.event;
  const eligible=current.statusSource==='omnifocus-sqlite'&&!current.completed&&!current.dropped&&!current.isProject;
  const hasEvidence=intent.recoveryVersion===1&&Object.hasOwn(intent,'previousOwner');
  const ownerMatches=hasEvidence&&canonical(owner)===canonical(intent.previousOwner);
  const alreadyConfirmed=owner?.id===a.id&&owner?.runId===a.runId&&owner?.event===event&&(owner.reason||'')===(request.reason||'');
  const expected=structuredClone(before),names=(current.tags||[]).map(normalized);
  const add=event==='start'?'进行中':'HITL',remove=event==='start'?'HITL':'进行中';
  const added=(current.tags||[]).filter((n:string)=>normalized(n)===add);
  const expectedTags=[...before.tags.filter((n:string)=>normalized(n)!==remove&&normalized(n)!==add),...added];
  if(event!=='start'){
   const text=(event==='done'?'交付：':'需要你处理：')+handoffReason(request.reason,request);
   if(!(expected.note||'').endsWith(text))expected.note=(expected.note?expected.note+'\n\n':'')+text;
  }
  const pending=await read(pendingFile);
  const pendingMatches=!pending||['id','runId','event','reason','codexThreadId'].every(k=>canonical(pending[k])===canonical(request[k]));
  const canAcceptWritten=eligible&&hasEvidence&&pendingMatches&&(ownerMatches||alreadyConfirmed)&&added.length===1&&names.includes('AFK')&&(event!=='start'||current.available)&&canonical(projection(current))===canonical(projection(expected))&&canonical([...current.tags].sort())===canonical(expectedTags.sort());
  const canDiscardNotWritten=eligible&&hasEvidence&&pendingMatches&&ownerMatches&&current.modified===before.modified&&canonical(projection(current))===canonical(projection(before))&&canonical([...current.tags].sort())===canonical([...before.tags].sort());
  if(a.decision==='inspect')return {ok:true,id:a.id,runId:a.runId,event,intentToken:token,canAcceptWritten,canDiscardNotWritten,before,current,request,owner,evidenceVersion:intent.recoveryVersion??null,ofWritten:false};
  if(!a.reason?.trim())throw Error('Explicit recovery reason required');
  // A prepared audit allows retry only against the same intent after our own owner write.
  const preparedRetry=audit?.intentDigest===digest(intent)&&audit.intentToken===a.expectedIntent&&audit.decision===a.decision&&audit.reason===a.reason&&audit.currentDigest===digest(evidence(current));
  if(a.expectedIntent!==token&&!preparedRetry)throw Error('Recovery token changed; inspect current snapshot and owner again');
  if(a.decision==='accept_written'?!canAcceptWritten:!canDiscardNotWritten)throw Error('Snapshot or owner changed, or required evidence unavailable; refusing recovery');
  const result={ok:true,id:a.id,runId:a.runId,event,decision:a.decision,ofWritten:false,reason:a.reason,intentToken:a.expectedIntent};
  const record={intentToken:a.expectedIntent,intentDigest:digest(intent),currentDigest:digest(evidence(current)),decision:a.decision,reason:a.reason,request,result,at:new Date().toISOString(),committed:false};
  await save(auditFile,record);
  if(a.decision==='accept_written')await save(ownerFile,{id:a.id,runId:a.runId,event,reason:request.reason||'',at:record.at,recovered:true});
  await fs.unlink(pendingFile).catch(e=>{if(e.code!=='ENOENT')throw e;});
  await save(auditFile,{...record,committed:true});
  await fs.unlink(intentFile);
  return result;
 });
}
