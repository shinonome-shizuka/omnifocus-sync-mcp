import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Ledger,type Owner,type Live,type TransitionRequest,type TransferRequest} from '../src/ledger/engine.js';
import {LedgerStore,readJSON,atomicJSON} from '../src/ledger/store.js';
import {verifyWrite} from '../src/ledger/runtime.js';
import {guardExecution,guardStop} from '../src/ledger/guard.js';
const sender:Owner={platform:'codex',sessionId:'s',runId:'sender'};
const receiver:Owner={platform:'multica',sessionId:'m',runId:'receiver'};
const externalTask={system:'multica',workspaceId:'workspace',issueId:'fake-issue',identifier:'TEST-1',url:'https://example.invalid/TEST-1'};
async function fixture(t:any) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-ledger-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const live:Live={id:'fake',tags:['🤖 AFK','⏸️ 等待','P1'],note:'original',completed:false,dropped:false,available:true};
 let writes=0,fail='';let now=Date.parse('2026-11-03T00:00:00Z');
 const port={read:async(id:string)=>({...structuredClone(live),id}),write:async(r:TransitionRequest)=>{writes++;live.tags=live.tags.filter(n=>!n.includes(r.event==='start'?'HITL':'进行中'));live.tags.push(r.event==='start'?'🛫 进行中':'👨 HITL');if(r.event!=='start'){live.note+='\n\n'+(r.event==='done'?'交付：':'需要你处理：')+r.reason;live.available=false;}},verify:verifyWrite};
 const ledger=new Ledger(new LedgerStore(root),port,()=>now,async(point)=>{if(fail===point)throw Error('injected '+point);});
 const start:TransitionRequest={protocolVersion:2,id:'fake',eventId:'claim',expectedRevision:0,actor:sender,runId:sender.runId,event:'start'};
 const offer:TransferRequest={protocolVersion:2,id:'fake',eventId:'offer',expectedRevision:1,actor:sender,action:'offer',transferId:'transfer',target:receiver,expiresAt:'2026-11-03T01:00:00Z',externalTask};
 async function offered(){await ledger.transition(start);const result=await ledger.transfer(offer);const {credential}=await readJSON(result.credentialPath);return {protocolVersion:2,id:'fake',eventId:'accept',expectedRevision:2,actor:receiver,action:'accept',transferId:'transfer',credential,externalTask} as TransferRequest;}
 return {root,ledger,live,start,offer,offered,writes:()=>writes,fail:(p:string)=>{fail=p;},time:(n:number)=>{now=n;}};
}
test('claim/offer/accept/finish append exact ownership, preserve user tags and never complete',async t=>{
 const f=await fixture(t),accept=await f.offered();assert.equal(f.writes(),1);
 await assert.rejects(f.ledger.execution('fake',sender,2),/active owner/);
 await f.ledger.transfer(accept);assert.equal(f.writes(),1);
 await assert.rejects(f.ledger.execution('fake',sender,3),/owner/);
 await f.ledger.execution('fake',receiver,3);
 await assert.rejects(f.ledger.transition({...f.start,eventId:'old',expectedRevision:3,event:'done',reason:'wrong'}),/owner/);
 await assert.rejects(f.ledger.transfer({...f.offer,eventId:'cancel',expectedRevision:3,action:'cancel'}),/pending transfer/);
 await f.ledger.transition({...f.start,actor:receiver,runId:receiver.runId,eventId:'finish',expectedRevision:3,event:'done',reason:'verified artifact'});
 assert.equal(f.live.completed,false);assert.deepEqual(f.live.tags,['🤖 AFK','⏸️ 等待','P1','👨 HITL']);
 const d=await f.ledger.load('fake');assert.deepEqual(d.events.map(e=>e.eventType),['claimed','transfer_offered','transfer_accepted','delivered']);assert.equal(d.projection.currentOwner,null);
 const page=await f.ledger.page('fake',2);assert.equal(page.nextBeforeSequence,3);assert.equal((await f.ledger.page('fake',2,3)).events.length,2);
 assert.ok(!JSON.stringify(page).includes(accept.credential!));assert.ok(!JSON.stringify(page).includes('credentialHash'));
});
test('same event replay is idempotent; changed payload and stale revision rejected',async t=>{
 const f=await fixture(t);await f.ledger.transition(f.start);await f.ledger.transition(f.start);assert.equal(f.writes(),1);
 await assert.rejects(f.ledger.transition({...f.start,reason:'different'}),/different parameters/);
 await assert.rejects(f.ledger.transfer({...f.offer,expectedRevision:0}),/Stale/);
 assert.equal((await f.ledger.load('fake')).events.length,1);
});
test('two offers / accepts race: only one append; credential reuse under different event rejected',async t=>{
 const f=await fixture(t);await f.ledger.transition(f.start);
 const offers=await Promise.allSettled([f.ledger.transfer(f.offer),f.ledger.transfer({...f.offer,eventId:'other',transferId:'other'})]);
 assert.equal(offers.filter(x=>x.status==='fulfilled').length,1);
 const winner=(offers.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<any>).value;
 const token=(await readJSON(winner.credentialPath)).credential;
 const a:TransferRequest={protocolVersion:2,id:'fake',eventId:'a',expectedRevision:2,actor:receiver,action:'accept',transferId:winner.transferId,credential:token,externalTask};
 const accepts=await Promise.allSettled([f.ledger.transfer(a),f.ledger.transfer({...a,eventId:'b'})]);assert.equal(accepts.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await f.ledger.load('fake')).events.length,3);
 await assert.rejects(f.ledger.transfer({...a,eventId:'reused',expectedRevision:3}),/pending transfer/);
});
test('receiver credential, identity, issue and expiration enforced',async t=>{
 const f=await fixture(t),a=await f.offered();
 for(const bad of [{credential:'x'.repeat(32)},{actor:{...receiver,sessionId:'other'}},{externalTask:{...externalTask,issueId:'other'}}])await assert.rejects(f.ledger.transfer({...a,...bad}));
 f.time(Date.parse('2026-11-03T02:00:00Z'));await assert.rejects(f.ledger.transfer(a),/expired/);
 await f.ledger.transfer({...f.offer,action:'cancel',eventId:'cancel',expectedRevision:2});await f.ledger.execution('fake',sender,3);
});
test('late-known Multica session requires issue bound token, binds actual session only once',async t=>{
 const f=await fixture(t);await f.ledger.transition(f.start);const result=await f.ledger.transfer({...f.offer,target:{platform:'multica',runId:'receiver'}});
 const credential=(await readJSON(result.credentialPath)).credential;
 await f.ledger.transfer({protocolVersion:2,id:'fake',eventId:'a',expectedRevision:2,actor:receiver,action:'accept',transferId:'transfer',credential,externalTask});
 await assert.rejects(f.ledger.execution('fake',{...receiver,sessionId:'other'},3),/owner/);
});
test('runId cannot own another Action even with different event and session',async t=>{
 const f=await fixture(t);await f.ledger.transition(f.start);f.live.tags=f.live.tags.filter(x=>!x.includes('进行中'));
 await assert.rejects(f.ledger.transition({...f.start,id:'second',eventId:'second',actor:{...sender,sessionId:'other'}}),/reserved/);
});
for(const point of ['before_intent','after_intent','after_write','before_commit','after_commit'])test('crash injection '+point,async t=>{
 const f=await fixture(t);f.fail(point);await assert.rejects(f.ledger.transition(f.start),/injected/);f.fail('');
 const d=await f.ledger.load('fake');
 if(point==='before_intent'){assert.equal(d.intent,null);assert.equal(f.writes(),0);await f.ledger.transition(f.start);}
 else if(point==='after_commit'){assert.equal(d.events.length,1);await f.ledger.transition(f.start);assert.equal(f.writes(),1);}
 else {assert.ok(d.intent);await assert.rejects(f.ledger.transition(f.start),/Uncertain/);assert.equal(d.events.length,0);
 const outcome=point==='after_intent'?'not_applied':'applied';
 await f.ledger.reconcile({...f.start,eventId:'reconcile',reason:'operator inspected exact before/after state',evidence:['isolated fixture']},outcome);
 const recovered=await f.ledger.load('fake');assert.equal(recovered.intent,null);assert.equal(recovered.events.at(-1)?.eventType,'reconciled');
 }
});
test('human removal/HITL/drop/completion/unavailable blocks transfer and execution; no writes',async t=>{
 for(const change of ['progress','hitl','dropped','completed','available']) {
  const f=await fixture(t);await f.ledger.transition(f.start);
  if(change==='progress')f.live.tags=f.live.tags.filter(n=>!n.includes('进行中'));else if(change==='hitl')f.live.tags.push('👨 HITL');else (f.live as any)[change]=change!=='available';
  await assert.rejects(f.ledger.transfer(f.offer));await assert.rejects(f.ledger.execution('fake',sender,1));assert.equal(f.writes(),1);
 }
});
test('all three host guards fence sender, allow transferred Stop, require receiver handoff',async t=>{
 for(const platform of ['codex','hermes','multica'] as const) {
  const f=await fixture(t),a=await f.offered();await f.ledger.transfer(a);
  const source={id:'fake',actor:sender,revision:1};await assert.rejects(guardExecution(f.ledger,[source],sender,'terminal'));await guardStop(f.ledger,[source],sender);
  const dest={id:'fake',actor:receiver,revision:3};await guardExecution(f.ledger,[dest],receiver,'terminal');await assert.rejects(guardStop(f.ledger,[dest],receiver));
  await assert.rejects(guardExecution(f.ledger,[dest],{platform,sessionId:'wrong'},'terminal'));
  await guardExecution(f.ledger,[{...dest,pending:true}],receiver,'mcp_of_agent_ledger');
 }
});
test('corrupt projection/sequence fail closed',async t=>{
 const f=await fixture(t);await f.ledger.transition(f.start);const file=f.ledger.store.file('fake'),d=await readJSON(file);d.projection.revision=99;await atomicJSON(file,d);await assert.rejects(f.ledger.load('fake'),/projection/);
});
test('old start replay after transfer is denied, never reactivates sender session',async t=>{
 const f=await fixture(t),a=await f.offered();await f.ledger.transfer(a);
 await assert.rejects(f.ledger.transition(f.start),/Historical/);await assert.rejects(f.ledger.transfer(f.offer),/resolved/);
 const d=await f.ledger.load('fake');assert.equal(d.events.length,3);assert.deepEqual(d.projection.currentOwner,receiver);
});
test('legacy ownership requires explicit import; imported history is not fabricated',async t=>{
 const f=await fixture(t);await atomicJSON(path.join(f.root,'local-ownership', (await import('../src/ledger/store.js')).digest('fake')+'.json'),{id:'fake',runId:'old',event:'done'});
 await assert.rejects(f.ledger.transition(f.start),/imported_snapshot/);assert.equal(f.writes(),0);
 await f.ledger.importSnapshot({...f.start,actor:{...sender,runId:'migration-operator'},eventId:'import',reason:'verified legacy delivery snapshot',evidence:['legacy file']},{revision:0,currentOwner:null,phase:'delivered',pendingTransfer:null},'local-ownership');
 const d=await f.ledger.load('fake');assert.deepEqual(d.events.map(e=>e.eventType),['imported_snapshot']);
 await f.ledger.transition({...f.start,expectedRevision:1});
});
test('reconcile rejects fabricated outcome and preserves original history',async t=>{
 const f=await fixture(t);f.fail('after_intent');await assert.rejects(f.ledger.transition(f.start));f.fail('');
 const r={...f.start,eventId:'r',reason:'manual review',evidence:['test']};
 await assert.rejects(f.ledger.reconcile(r,'applied'),/does not prove/);assert.ok((await f.ledger.load('fake')).intent);
 f.live.note='human edit';await assert.rejects(f.ledger.reconcile(r,'not_applied'),/differs/);
});
test('separate processes compete for accept under the same filesystem lock',async t=>{
 const f=await fixture(t),a=await f.offered();
 const {spawn}=await import('node:child_process');
 const engine=new URL('../dist/ledger/engine.js',import.meta.url).href,store=new URL('../dist/ledger/store.js',import.meta.url).href;
 const code=`import {Ledger} from ${JSON.stringify(engine)};import {LedgerStore} from ${JSON.stringify(store)};let s='';for await(const p of process.stdin)s+=p;const {root,r}=JSON.parse(s);const l=new Ledger(new LedgerStore(root),{read:async()=>({id:'fake',tags:['AFK','进行中'],completed:false,dropped:false,available:true}),write:async()=>{throw Error('unexpected write');},verify:()=>false},()=>Date.parse('2026-11-03T00:00:00Z'));try{console.log(JSON.stringify(await l.transfer(r)));}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}`;
 const child=(eventId:string)=>new Promise<any>((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code]);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',()=>{try{resolve(JSON.parse(out));}catch{reject(Error(err));}});p.stdin.end(JSON.stringify({root:f.root,r:{...a,eventId}}));});
 const results=await Promise.all([child('process-1'),child('process-2')]);assert.equal(results.filter(x=>x.ok).length,1);assert.equal((await f.ledger.load('fake')).events.length,3);
});
