import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8,unzipSync,strFromU8} from 'fflate';
import {LocalStorage,WebDavStorage} from '../src/storage/index.js';
import {OmniFocusStore} from '../src/ofocus/store.js';
import {OmniFocusService} from '../src/ofocus/service.js';
import {WebDavClient} from '../src/webdav/client.js';
import {buildUpdateTask} from '../src/ofocus/writer.js';
import {Database} from '../src/ofocus/database.js';
import {taskState} from '../src/ofocus/taskState.js';
const xml=(s:string)=>`<omnifocus xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2">${s}</omnifocus>`;
const zip=(s:string)=>Buffer.from(zipSync({'contents.xml':strToU8(s)}));
const baseline=xml('<task id="fixture"><name>Original</name><note>Preserve</note><inbox>true</inbox></task>');

test('local and real WebDAV adapter run the same service CRUD and emit readable transactions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-adapters-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
 const remote=new Map<string,Buffer>([['00000000000000=root+base.zip',zip(baseline)]]),calls:string[]=[];
 globalThis.fetch=async(input:any,init:any)=>{
  const url=new URL(String(input)),name=decodeURIComponent(url.pathname.replace(/^\/db\//,'')),method=init?.method??'GET';calls.push(method);
  if(method==='PROPFIND')return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[...remote].map(([n,b])=>`<d:response><d:href>/db/${encodeURIComponent(n)}</d:href><d:propstat><d:prop><d:getcontentlength>${b.length}</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`,{status:207});
  if(method==='GET')return remote.has(name)?new Response(new Uint8Array(remote.get(name)!)):new Response('',{status:404});
  if(method==='HEAD')return new Response(null,{status:remote.has(name)?200:404});
  if(method==='PUT'){remote.set(name,Buffer.from(init.body));return new Response(null,{status:201});}
  throw Error('Unexpected request '+method);
 };
 const local=new LocalStorage(path.join(root,'local'));await local.create();await local.write('00000000000000=root+base.zip',zip(baseline));
 const webdav=new WebDavStorage(new WebDavClient({baseUrl:'https://fixture.invalid/db/',username:'fixture',password:'fixture'}),'https://fixture.invalid/db/');
 const outputs=[];
 for(const storage of [local,webdav]){
  const config:any={ofocusUrl:'https://fixture.invalid/db/',username:'fixture',password:'fixture',authScheme:'auto',passphrase:'',readOnly:false,clientName:'fixture',clientStateFile:path.join(root,storage.kind+'.json')};
  const service=new OmniFocusService(config,new OmniFocusStore(storage));
  await service.editTask('fixture',{name:'Edited',flagged:true});
  assert.equal((await service.refresh()).db.tasks.get('fixture')!.note,'Preserve');
  await service.completeTask('fixture',new Date('2026-11-04T00:00:00Z'));
  const task=(await service.refresh()).db.tasks.get('fixture')!;outputs.push({name:task.name,note:task.note,flagged:task.flagged,completed:task.completed});
  const created=await service.addTask({name:'Round trip'});await service.deleteTask(created.id);assert.ok(!(await service.refresh()).db.tasks.has(created.id));
  const listing=await storage.list();assert.equal(listing.filter(e=>e.name.endsWith('.zip')).length,5);
  const transactions=await Promise.all(listing.filter(e=>e.name.endsWith('.zip')).map(async e=>strFromU8(unzipSync(await storage.read(e.name))['contents.xml'])));
  assert.ok(transactions.some(s=>s.includes('op="delete"')));
 }
 assert.deepEqual(outputs[0],outputs[1]);assert.ok(calls.includes('PUT'));assert.ok(calls.includes('PROPFIND'));
});

test('history follows parents across clock skew and merges every branch on commit',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-history-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=new LocalStorage(root);await storage.write('00000000000000=root+base.zip',zip(baseline));
 await storage.write('20300101000000=base+one.zip',zip(buildUpdateTask('fixture',{name:'Parent'})));
 await storage.write('20200101000000=one+two.zip',zip(buildUpdateTask('fixture',{name:'Child'})));
 await storage.write('20210101000000=base+branch.zip',zip(buildUpdateTask('fixture',{flagged:true})));
 const service=new OmniFocusService({readOnly:false,ofocusUrl:'',clientStateFile:path.join(root,'client.json'),clientName:'test',passphrase:''} as any,new OmniFocusStore(storage));
 const db=(await service.refresh()).db;assert.equal(db.tasks.get('fixture')!.name,'Child');assert.equal(db.tasks.get('fixture')!.flagged,true);
 await service.editTask('fixture',{note:'Merged'});
 const names=(await storage.list()).map(e=>e.name);assert.ok(names.some(n=>/=branch\+two\+|=two\+branch\+/.test(n)));
});

test('stale writes reject; local publication never overwrites immutable transactions or follows symlinks',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-cas-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=new LocalStorage(root),store=new OmniFocusStore(storage);const name='00000000000000=root+base.zip';await storage.write(name,zip(baseline));await store.loadDatabase();
 await storage.write('20261104000000=base+other.zip',zip(buildUpdateTask('fixture',{name:'Human change'})));
 await assert.rejects(store.writeTransaction(buildUpdateTask('fixture',{name:'Stale'}),['base']),/changed before commit/);
 await assert.rejects(storage.write(name,Buffer.from('bad')),/EEXIST/);assert.equal((await store.loadDatabase()).db.tasks.get('fixture')!.name,'Human change');
 await fs.symlink(path.join(root,name),path.join(root,'linked.zip'));await assert.rejects(storage.read('linked.zip'));
 await assert.rejects(storage.read('../secret'),/Invalid store filename/);
});

test('shared state respects sequential, held tags, projects, deferred ancestors and rich notes',()=>{
 const db=new Database();db.applyTransaction(xml(`<context id="afk"><name>AFK</name></context><context id="held"><name>等待</name><prohibits-next-action>true</prohibits-next-action></context>
 <task id="p"><name>Project</name><project><status>active</status></project><order>sequential</order></task>
 <task id="one"><task idref="p"/><rank>1</rank><name>One</name><note><text><p><run><lit>First line</lit></run></p><p><run><lit>Second line</lit></run></p></text></note></task>
 <task id="two"><task idref="p"/><rank>2</rank><name>Two</name></task>
 <task id="monitor"><name>Waiting</name><context idref="held"/></task>`));
 assert.equal(taskState(db,'p').available,false);assert.equal(taskState(db,'one').available,true);assert.equal(taskState(db,'two').available,false);
 assert.equal(taskState(db,'one').note,'First line\nSecond line');assert.equal(taskState(db,'monitor').available,false);assert.equal(taskState(db,'monitor',true).available,true);
 db.applyTransaction(buildUpdateTask('one',{completed:new Date()}));assert.equal(taskState(db,'two').available,true);
 db.applyTransaction(xml('<task id="p" op="update"><project><status>inactive</status></project></task>'));assert.equal(taskState(db,'two').available,false);
});

test('encrypted local store uses the shared decrypt/encrypt pipeline',async t=>{
 const {DocumentKey,SlotType,buildEncryptionMetadata,encryptFile,decryptFile}=await import('../src/crypto/index.js');
 const crypto=await import('node:crypto');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-encrypted-local-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=new LocalStorage(root),passphrase='fixture-only';
 const key=new DocumentKey([{type:SlotType.ActiveAES_CTR_HMAC,id:1,contents:crypto.randomBytes(32)}]);
 const metadata={method:'password',algorithm:'PBKDF2; aes128-wrap',rounds:1000,salt:crypto.randomBytes(20),key:Buffer.alloc(0)};
 metadata.key=key.wrap(DocumentKey.deriveWrappingKey(metadata,passphrase));
 await storage.write('encrypted',Buffer.from(buildEncryptionMetadata(metadata)));
 const name='00000000000000=root+base.zip';await storage.write(name,encryptFile(key,name,zip(baseline)));
 const store=new OmniFocusStore(storage);await store.unlock(passphrase);assert.equal((await store.loadDatabase()).db.tasks.get('fixture')!.name,'Original');
 const result=await store.writeTransaction(buildUpdateTask('fixture',{name:'Encrypted edit'}),['base']);
 const ciphertext=await storage.read(result.name);assert.notEqual(ciphertext.subarray(0,2).toString(),'PK');
 assert.match(strFromU8(unzipSync(decryptFile(key,result.name,ciphertext))['contents.xml']),/Encrypted edit/);
 assert.equal((await store.loadDatabase()).db.tasks.get('fixture')!.name,'Encrypted edit');
 const wrong=new OmniFocusStore(storage);await assert.rejects(wrong.unlock('wrong'),/passphrase/);
});

test('missing parent history fails closed and a registration failure reports an already-published transaction',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=new LocalStorage(root);await storage.write('00000000000000=root+base.zip',zip(baseline));
 const orphan='20261104000000=missing+orphan.zip';await storage.write(orphan,zip(buildUpdateTask('fixture',{name:'Orphan'})));
 await assert.rejects(new OmniFocusStore(storage).loadDatabase(),/missing parents/);await fs.unlink(path.join(root,orphan));
 const broken={kind:'local' as const,identity:root,list:()=>storage.list(),read:(n:string)=>storage.read(n),exists:(n:string)=>storage.exists(n),create:()=>storage.create(),write:async(n:string,b:Uint8Array)=>{if(n.endsWith('.client'))throw Error('simulated disk error');await storage.write(n,b);}};
 const service=new OmniFocusService({readOnly:false,ofocusUrl:'',clientName:'test',clientStateFile:path.join(root,'identity.json')} as any,new OmniFocusStore(broken));
 await assert.rejects(service.editTask('fixture',{name:'Published'}),/was published but client registration failed/);
 assert.equal((await new OmniFocusStore(storage).loadDatabase()).db.tasks.get('fixture')!.name,'Published');
});
