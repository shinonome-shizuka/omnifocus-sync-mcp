import {LedgerStore, atomicJSON, readJSON, canonical, digest} from './store.js';

export type Platform = 'codex'|'hermes'|'multica';
export interface Owner {platform:Platform;sessionId:string;runId:string}
export interface ExternalTask {system:string;workspaceId:string;issueId:string;identifier:string;url:string}
export interface Transfer {transferId:string;target:Omit<Owner,'sessionId'>&{sessionId?:string};externalTask?:ExternalTask;expiresAt:string;credentialHash:string;credentialPath:string}
export type Phase = 'unclaimed'|'active'|'transferring'|'delivered'|'needs_human'|'revoked';
export interface Projection {revision:number;currentOwner:Owner|null;phase:Phase;pendingTransfer:Transfer|null}
export interface Request {protocolVersion:2;id:string;eventId:string;expectedRevision:number;actor:Owner;reason?:string;evidence?:string[];externalTask?:ExternalTask}
export interface TransitionRequest extends Request {event:'start'|'done'|'needs_human';runId:string}
export interface TransferRequest extends Request {action:'offer'|'accept'|'cancel';transferId:string;target?:Transfer['target'];expiresAt?:string;credential?:string}
export interface Live {id:string;tags:string[];note?:string|null;completed:boolean;dropped:boolean;available:boolean;isProject?:boolean;[key:string]:unknown}
export interface Port {read(id:string):Promise<Live>;write(r:TransitionRequest,before:Live):Promise<void>;verify(before:Live,after:Live,r:TransitionRequest):boolean}
export interface Event {schemaVersion:2;eventId:string;actionId:string;sequence:number;eventType:string;timestamp:string;actor:Owner;fromOwner:Owner|null;toOwner:Owner|null;transferId?:string;expectedRevision:number;externalTask?:ExternalTask;reason:string;evidence:string[];requestHash:string;after:Projection;result:any}
export interface Intent {request:TransitionRequest;before:Live;requestHash:string;at:string}
export interface Document {schemaVersion:2;actionId:string;events:Event[];projection:Projection;intent:Intent|null}
const initial=():Projection=>({revision:0,currentOwner:null,phase:'unclaimed',pendingTransfer:null});
export const sameOwner=(a:Owner|null,b:Owner)=>!!a&&canonical(a)===canonical(b);
export const names=(t:Live)=>t.tags.map(n=>n.replace(/^[^\p{L}\p{N}]+/u,'').trim());
export function validLive(t:Live,progress:boolean) {
  const tags=names(t);
  if(t.isProject||t.completed||t.dropped||!t.available||!tags.includes('AFK')||tags.includes('HITL'))throw Error('Action no longer executable; do not restore human state');
  if(progress&&!tags.includes('进行中'))throw Error('Human removed progress; execution revoked');
  if(!progress&&tags.includes('进行中'))throw Error('Existing progress requires explicit migration/reconciliation');
}
function owner(value:any) {
  if(!value||!['codex','hermes','multica'].includes(value.platform)||!value.sessionId?.trim()||!value.runId?.trim()||value.runId.length>160||value.sessionId.length>256)throw Error('Exact platform, sessionId and unique runId required');
}
function validate(r:Request) {
  if(r.protocolVersion!==2||!r.id?.trim()||!r.eventId?.trim()||r.eventId.length>160||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0)throw Error('Protocol v2 eventId and expectedRevision required');
  owner(r.actor);
  if((r.reason?.length??0)>2000||(r.evidence?.length??0)>20||r.evidence?.some(x=>typeof x!=='string'||x.length>2000))throw Error('Use concise reasons/evidence, not raw tool logs');
}
function hash(r:Request) {
  const safe={...r} as any;
  if(safe.credential!==undefined){safe.credentialHash=digest(safe.credential);delete safe.credential;}
  return digest(canonical(safe));
}
export class Ledger {
  constructor(readonly store:LedgerStore,readonly port:Port,readonly now:()=>number=Date.now,readonly fault:(point:string)=>Promise<void>=async()=>{}) {}
  async load(id:string):Promise<Document> {
    const d:Document=await readJSON(this.store.file(id))??{schemaVersion:2,actionId:id,events:[],projection:initial(),intent:null};
    if(d.schemaVersion!==2||d.actionId!==id||!Array.isArray(d.events))throw Error('Invalid ledger document');
    let p=initial();const ids=new Set<string>();
    for(const [i,e] of d.events.entries()) {
      if(e.schemaVersion!==2||e.actionId!==id||e.sequence!==i+1||e.expectedRevision!==i||e.after.revision!==i+1||ids.has(e.eventId)||!sameNullable(p.currentOwner,e.fromOwner)||!sameNullable(e.toOwner,e.after.currentOwner))throw Error('Invalid event sequence or projection');
      ids.add(e.eventId);p=e.after;
    }
    if(canonical(p)!==canonical(d.projection))throw Error('Ledger projection mismatch');
    if(d.intent&&(d.intent.request.expectedRevision!==p.revision||d.intent.request.id!==id))throw Error('Invalid pending intent');
    return d;
  }
  async page(id:string,limit=20,beforeSequence?:number) {
    if(!Number.isInteger(limit)||limit<1||limit>100||beforeSequence!==undefined&&(!Number.isInteger(beforeSequence)||beforeSequence<1))throw Error('Invalid ledger page');
    const d=await this.load(id);const all=d.events.filter(e=>beforeSequence===undefined||e.sequence<beforeSequence).reverse();
    const events=all.slice(0,limit).map(e=>redact(e));
    return {protocolVersion:2,id,projection:redact(d.projection),uncertain:!!d.intent,events,nextBeforeSequence:all.length>limit?events.at(-1).sequence:null};
  }
  check(d:Document,r:Request) {
    validate(r);
    if(d.intent)throw Error('Uncertain prior write; explicit reconciliation required, never replay');
    const prior=d.events.find(e=>e.eventId===r.eventId);
    if(prior){
      if(prior.requestHash!==hash(r))throw Error('eventId reused with different parameters');
      if(['claimed','transfer_accepted'].includes(prior.eventType)&&(!sameOwner(d.projection.currentOwner,r.actor)||d.projection.phase!=='active'))throw Error('Historical acceptance is not current execution authority');
      if(prior.eventType==='transfer_offered'&&(d.projection.phase!=='transferring'||d.projection.pendingTransfer?.transferId!==prior.transferId))throw Error('Offer already resolved');
      return {...prior.result,replayed:true};
    }
    if(d.intent)throw Error('Uncertain prior write; explicit reconciliation required, never replay');
    if(d.projection.revision!==r.expectedRevision)throw Error('Stale expectedRevision');
    return null;
  }
  append(d:Document,r:Request,eventType:string,patch:Partial<Projection>,extra:Record<string,unknown>={}) {
    const after={...d.projection,...patch,revision:d.projection.revision+1};
    const transferId=(r as TransferRequest).transferId;
    const result={ok:true,protocolVersion:2,id:r.id,event:(r as TransitionRequest).event,action:(r as TransferRequest).action,eventId:r.eventId,runId:r.actor.runId,revision:after.revision,phase:after.phase,currentOwner:after.currentOwner,...extra};
    d.events.push({schemaVersion:2,eventId:r.eventId,actionId:r.id,sequence:after.revision,eventType,timestamp:new Date(this.now()).toISOString(),actor:r.actor,fromOwner:d.projection.currentOwner,toOwner:after.currentOwner,transferId,expectedRevision:d.projection.revision,externalTask:r.externalTask,reason:r.reason||'',evidence:r.evidence||[],requestHash:hash(r),after,result});
    d.projection=after;return result;
  }
  async transition(r:TransitionRequest) {
    validate(r);
    if(r.runId!==r.actor.runId||!['start','done','needs_human'].includes(r.event))throw Error('runId must match actor');
    if(r.event!=='start'&&!r.reason?.trim())throw Error('Concrete handoff reason required');
    return this.store.lock(r.id,async()=>{
      const d=await this.load(r.id),prior=this.check(d,r);if(prior){if(r.event==='start')validLive(await this.port.read(r.id),true);return prior;}
      const before=await this.port.read(r.id);
      if(r.event==='start') {
        if(d.projection.currentOwner||d.projection.phase==='transferring')throw Error('Action already owned');
        if(!d.events.length&&(await this.store.legacyExists(r.id)||/\[of-agent:/.test(before.note||'')))throw Error('Legacy ownership requires explicit imported_snapshot');
        if(d.events.some(e=>e.actor.runId===r.runId||e.toOwner?.runId===r.runId))throw Error('Run already used; new runId required');
        validLive(before,false);
        await this.store.reserveRun(r.runId,{actionId:r.id,owner:r.actor,eventId:r.eventId});
      } else {this.active(d,r.actor);validLive(before,true);}
      d.intent={request:r,before,requestHash:hash(r),at:new Date(this.now()).toISOString()};
      await this.fault('before_intent');await atomicJSON(this.store.file(r.id),d);await this.fault('after_intent');
      await this.port.write(r,before);await this.fault('after_write');
      const after=await this.port.read(r.id);
      if(!this.port.verify(before,after,r))throw Error('Write verification failed; uncertain intent retained');
      const result=this.append(d,r,r.event==='start'?'claimed':r.event==='done'?'delivered':'needs_human',{phase:r.event==='start'?'active':r.event==='done'?'delivered':'needs_human',currentOwner:r.event==='start'?r.actor:null,pendingTransfer:null});
      d.intent=null;await this.fault('before_commit');await atomicJSON(this.store.file(r.id),d);await this.fault('after_commit');return result;
    });
  }
  active(d:Document,actor:Owner) {
    if(d.projection.phase!=='active'||!sameOwner(d.projection.currentOwner,actor))throw Error('Not current active owner');
  }
  async transfer(r:TransferRequest) {
    validate(r);if(!r.transferId?.trim()||r.transferId.length>160||!['offer','accept','cancel'].includes(r.action))throw Error('Invalid transfer');
    return this.store.lock(r.id,async()=>{
      const d=await this.load(r.id),prior=this.check(d,r);if(prior){if(r.action==='accept')validLive(await this.port.read(r.id),true);return prior;}
      validLive(await this.port.read(r.id),true);
      let result;
      if(r.action==='offer') {
        this.active(d,r.actor);
        if(d.events.some(e=>e.transferId===r.transferId))throw Error('transferId already used');
        const target=r.target;if(!target)throw Error('Target required');owner({...target,sessionId:target.sessionId||'pending'});
        if(target.runId===r.actor.runId||d.events.some(e=>e.actor.runId===target.runId||e.toOwner?.runId===target.runId))throw Error('Receiver needs a new unique runId');
        if(!target.sessionId&&(!r.externalTask?.issueId||!r.externalTask?.workspaceId||r.externalTask.system!=='multica'||target.platform!=='multica'))throw Error('Unknown receiver session must be bound to a Multica issue');
        const expires=Date.parse(r.expiresAt||'');if(!Number.isFinite(expires)||expires<=this.now()||expires>this.now()+86400000)throw Error('Expiry must be within 24 hours');
        const grant=await this.store.credential(r.id,r.transferId,r.eventId);
        const transfer:Transfer={transferId:r.transferId,target,externalTask:r.externalTask,expiresAt:new Date(expires).toISOString(),...grant};
        result=this.append(d,r,'transfer_offered',{phase:'transferring',pendingTransfer:transfer},{transferId:r.transferId,credentialPath:grant.credentialPath});
      } else {
        const t=d.projection.pendingTransfer;
        if(d.projection.phase!=='transferring'||!t||t.transferId!==r.transferId)throw Error('No matching pending transfer');
        if(r.action==='cancel') {
          if(!sameOwner(d.projection.currentOwner,r.actor))throw Error('Only sender can cancel an unaccepted transfer');
          result=this.append(d,r,'transfer_cancelled',{phase:'active',pendingTransfer:null});
        } else {
          if(this.now()>=Date.parse(t.expiresAt))throw Error('Transfer expired');
          if(r.actor.platform!==t.target.platform||r.actor.runId!==t.target.runId||t.target.sessionId&&r.actor.sessionId!==t.target.sessionId)throw Error('Wrong receiver identity');
          if(t.externalTask&&canonical(r.externalTask)!==canonical(t.externalTask))throw Error('Wrong external issue binding');
          if(!r.credential||digest(r.credential)!==t.credentialHash)throw Error('Invalid single-use credential');
          await this.store.reserveRun(r.actor.runId,{actionId:r.id,owner:r.actor,eventId:r.eventId});
          result=this.append(d,r,'transfer_accepted',{phase:'active',currentOwner:r.actor,pendingTransfer:null});
        }
      }
      await atomicJSON(this.store.file(r.id),d);return result;
    });
  }
  async execution(id:string,actor:Owner,revision:number) {
    owner(actor);
    return this.store.lock(id,async()=>{
      const d=await this.load(id);if(d.intent)throw Error('Uncertain OF write');
      this.active(d,actor);if(d.projection.revision!==revision)throw Error('Stale ownership revision');
      validLive(await this.port.read(id),true);
      return {ok:true,protocolVersion:2,id,revision,owner:actor};
    });
  }
  // Administrative operation, deliberately not exposed as an agent MCP mutation.
  async reconcile(r:Request,outcome:'applied'|'not_applied'|'revoked') {
    validate(r);if(!r.reason?.trim()||!r.evidence?.length)throw Error('Reconciliation requires reason and evidence');
    return this.store.lock(r.id,async()=>{
      const d=await this.load(r.id);
      const duplicate=d.events.find(e=>e.eventId===r.eventId);
      if(duplicate){if(duplicate.requestHash!==hash({...r,outcome} as Request))throw Error('eventId conflict');return duplicate.result;}
      if(d.projection.revision!==r.expectedRevision)throw Error('Stale expectedRevision');
      const t=await this.port.read(r.id),intent=d.intent;
      if(outcome==='applied') {
        if(!intent||!this.port.verify(intent.before,t,intent.request))throw Error('Live state does not prove original write outcome');
        const req=intent.request;this.append(d,req,req.event==='start'?'claimed':req.event==='done'?'delivered':'needs_human',{phase:req.event==='start'?'active':req.event==='done'?'delivered':'needs_human',currentOwner:req.event==='start'?req.actor:null});
      } else if(outcome==='not_applied') {
        if(!intent||canonical(intent.before)!==canonical(t))throw Error('Live state differs; cannot declare write unapplied');
      } else {
        let invalid=false;try{validLive(t,true);}catch{invalid=true;}
        if(!invalid)throw Error('Live state still executable; no human revocation observed');
      }
      d.intent=null;
      const result=this.append(d,{...r,outcome} as Request,outcome==='revoked'?'human_revoked':'reconciled',outcome==='revoked'?{phase:'revoked',currentOwner:null,pendingTransfer:null}:{});
      await atomicJSON(this.store.file(r.id),d);return result;
    });
  }
  async importSnapshot(r:Request,snapshot:Projection,source:string) {
    validate(r);if(!r.reason?.trim()||!r.evidence?.length||!source)throw Error('Migration evidence required');
    return this.store.lock(r.id,async()=>{
      const d=await this.load(r.id);if(d.events.length||d.intent||r.expectedRevision!==0)throw Error('Import only into empty ledger');
      if(snapshot.pendingTransfer||!['active','delivered','needs_human','revoked'].includes(snapshot.phase))throw Error('Cannot fabricate historical transfer');
      const t=await this.port.read(r.id);
      if(snapshot.phase==='active') {if(!snapshot.currentOwner)throw Error('Owner required');owner(snapshot.currentOwner);validLive(t,true);await this.store.reserveRun(snapshot.currentOwner.runId,{actionId:r.id,owner:snapshot.currentOwner,eventId:r.eventId});}
      else if(snapshot.currentOwner)throw Error('Ended snapshot cannot have owner');
      const result=this.append(d,r,'imported_snapshot',{...snapshot,revision:0},{source});await atomicJSON(this.store.file(r.id),d);return result;
    });
  }
}
function sameNullable(a:Owner|null,b:Owner|null){return canonical(a)===canonical(b);}
function redact(value:any):any {
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['credentialHash','credentialPath','requestHash'].includes(k)).map(([k,v])=>[k,redact(v)]));
  return value;
}
