import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {reconcileLegacy} from '../src/legacyRecovery.js';import {key,read,save} from '../src/monitor/store.js';
async function fixture(t:any,event='start'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const before={id:'a',name:'test',note:'human',modified:'before',tags:event==='start'?['AFK']:['AFK','进行中'],completed:false,dropped:false,available:true,isProject:false,statusSource:'omnifocus-sqlite'};
 const input={id:'a',runId:'run',event,reason:event==='start'?'':'交付：result',codexThreadId:'01a1a4a4-f1bc-7770-9725-10e054be27c7'};
 const owner=event==='start'?null:{id:'a',runId:'run',event:'start'};
 const intent=path.join(root,'local-ownership',key('a')+'.json.intent');await save(intent,{recoveryVersion:1,input,before,previousOwner:owner});if(owner)await save(intent.replace('.intent',''),owner);await save(path.join(root,'pending',key('a')+'.json'),input);
 let current:any=structuredClone(before);const call=(a:any)=>reconcileLegacy({...a,id:'a',runId:'run'},root,async()=>current);
 return {root,before,input,intent,call,set:(v:any)=>current=v};
}
test('recovery accepts observed native start without writing OF and is idempotent',async t=>{
 const f=await fixture(t);f.set({...f.before,tags:['AFK','进行中'],modified:'after'});const info=await f.call({decision:'inspect'});assert.equal(info.canAcceptWritten,true);
 const r=await f.call({decision:'accept_written',expectedIntent:info.intentToken,reason:'verified'});assert.equal(r.event,'start');assert.equal(r.ofWritten,false);
 assert.equal((await read(f.intent)),null);assert.equal((await read(f.intent.replace('.intent',''))).event,'start');
 assert.deepEqual(await f.call({decision:'accept_written',expectedIntent:info.intentToken,reason:'verified'}),r);
});
test('discard only unchanged unwritten state; preserves original owner and rejects stale token',async t=>{
 const f=await fixture(t,'done');let info=await f.call({decision:'inspect'});assert.equal(info.canDiscardNotWritten,true);
 await assert.rejects(f.call({decision:'discard_not_written',expectedIntent:'stale',reason:'review'}),/changed|token/i);
 f.set({...f.before,note:'human edited'});await assert.rejects(f.call({decision:'discard_not_written',expectedIntent:info.intentToken,reason:'review'}),/snapshot|changed/i);
 f.set(f.before);info=await f.call({decision:'inspect'});await f.call({decision:'discard_not_written',expectedIntent:info.intentToken,reason:'verified not written'});assert.equal((await read(f.intent.replace('.intent',''))).event,'start');
});
test('accept handoff requires exact note including Codex link and preserves human edits',async t=>{
 const f=await fixture(t,'done');f.set({...f.before,tags:['AFK','HITL'],modified:'after',note:'human\n\n交付：result\nCodex 对话：codex://threads/01a1a4a4-f1bc-7770-9725-10e054be27c7'});
 const info=await f.call({decision:'inspect'});assert.equal(info.canAcceptWritten,true);
 f.set({...f.before,tags:['AFK','HITL'],note:'human overwritten'});await assert.rejects(f.call({decision:'accept_written',expectedIntent:info.intentToken,reason:'verify'}),/snapshot|changed/i);
});
test('recovery refuses other owner, v2, non-native snapshot and absent version evidence',async t=>{
 const f=await fixture(t);let info=await f.call({decision:'inspect'});
 await save(f.intent.replace('.intent',''),{id:'a',runId:'other',event:'start'});await assert.rejects(f.call({decision:'discard_not_written',expectedIntent:info.intentToken,reason:'review'}),/owner|changed/i);
 await fs.unlink(f.intent.replace('.intent',''));f.set({...f.before,statusSource:'transaction-database'});info=await f.call({decision:'inspect'});assert.equal(info.canDiscardNotWritten,false);
 await save(path.join(f.root,'ledger-v2',key('a')+'.json'),{});await assert.rejects(f.call({decision:'inspect'}),/v2/i);
});
test('fresh snapshot timestamps do not invalidate token; missing recovery evidence fails closed',async t=>{
 const f=await fixture(t);f.set({...f.before,snapshot:{observedAt:'one'}});const info=await f.call({decision:'inspect'});
 f.set({...f.before,snapshot:{observedAt:'two'}});await f.call({decision:'discard_not_written',expectedIntent:info.intentToken,reason:'unchanged'});
 const other=await fixture(t);const intent=await read(other.intent);delete intent.recoveryVersion;await save(other.intent,intent);
 const old=await other.call({decision:'inspect'});assert.equal(old.canAcceptWritten,false);assert.equal(old.canDiscardNotWritten,false);
});
test('recovery rejects pending request drift and concurrent transaction locks',async t=>{
 const f=await fixture(t);await save(path.join(f.root,'pending',key('a')+'.json'),{...f.input,codexThreadId:'different'});const i=await f.call({decision:'inspect'});assert.equal(i.canDiscardNotWritten,false);
 await save(path.join(f.root,'transition-'+key('a')+'.lock'),{pid:1});await assert.rejects(f.call({decision:'inspect'}),/EEXIST/);
});
test('interrupted recovery resumes its own owner commit without replaying OF',async t=>{
 const f=await fixture(t);f.set({...f.before,tags:['AFK','进行中'],modified:'after'});const i=await f.call({decision:'inspect'});
 const a={decision:'accept_written',expectedIntent:i.intentToken,reason:'verified'},unlink=fs.unlink,pending=path.join(f.root,'pending',key('a')+'.json');let inject=true;
 fs.unlink=async p=>{if(String(p)===pending&&inject){inject=false;throw Error('injected cleanup failure');}return unlink(p);};
 try{await assert.rejects(f.call(a),/injected cleanup failure/);}finally{fs.unlink=unlink;}
 assert.ok(await read(f.intent));assert.equal((await read(f.intent.replace('.intent',''))).event,'start');
 assert.equal((await f.call(a)).ofWritten,false);assert.equal(await read(f.intent),null);
});
