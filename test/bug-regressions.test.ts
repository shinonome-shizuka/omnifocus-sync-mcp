import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {Database} from '../src/ofocus/database.js';
import {taskState} from '../src/ofocus/taskState.js';
import {planWorkflowWrite} from '../src/workflowWrites.js';
import {readDatabaseAttachment} from '../src/databaseAttachments.js';
import {withBackend} from '../src/backend.js';

const wrap=(contents:string)=>`<omnifocus xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2">${contents}</omnifocus>`;

test('handoff retains existing rich note XML, styles, links, and text order',()=>{
 const db=new Database();
 db.applyTransaction(wrap(`<context id="afk"><name>AFK</name></context><context id="progress"><name>进行中</name></context><context id="hitl"><name>HITL</name></context>
 <task id="t"><name>Task</name><context idref="afk"/><note><text><p><run><style><value key="bold">true</value></style><lit>Before</lit></run><run><lit> link</lit><cell href="https://example.test/">link</cell></run></p></text></note></task>
 <task-to-tag id="t.progress"><task idref="t"/><context idref="progress"/></task-to-tag>`));
 const before=taskState(db,'t');
 const xml=planWorkflowWrite(db,'t','done',before,'Complete & verified');
 assert.match(xml,/<style>/);assert.match(xml,/<cell href="https:\/\/example.test\/">link<\/cell>/);
 assert.match(xml,/Before/);assert.match(xml,/Complete &amp; verified/);
 db.applyTransaction(xml);assert.match(db.tasks.get('t')!.note!,/Before link/);assert.match(db.tasks.get('t')!.note!,/Complete & verified/);
});

test('missing intermediate folder ancestor makes a project action unavailable',()=>{
 const db=new Database();db.applyTransaction(wrap(`<folder id="f"><name>child</name><folder idref="missing"/></folder><task id="p"><project><folder idref="f"/><status>active</status></project><order>parallel</order></task><task id="t"><task idref="p"/><name>Action</name></task>`));
 const state=taskState(db,'t');assert.equal(state.available,false);assert.ok(state.availabilityBlockers.includes('missing-folder-parent'));
});

test('a directory containing only one file is returned as a directory',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-dir-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const old=process.env.OMNIFOCUS_LOCAL_DATABASE;process.env.OMNIFOCUS_LOCAL_DATABASE=root;t.after(()=>{if(old===undefined)delete process.env.OMNIFOCUS_LOCAL_DATABASE;else process.env.OMNIFOCUS_LOCAL_DATABASE=old;});
 await fs.mkdir(path.join(root,'data'));
 await fs.writeFile(path.join(root,'00000000000000=root+base.zip'),zipSync({'contents.xml':strToU8(wrap(`<task id="t"><name>Task</name></task><attachment id="a"><task idref="t"/><name>Folder</name><data-identifier>data-directory</data-identifier></attachment>`))}));
 await fs.writeFile(path.join(root,'data/data-directory.zip'),zipSync({'Folder/only.txt':strToU8('content')}));
 const result=await withBackend('local',()=>readDatabaseAttachment({id:'t',index:0,expectedModified:null,expectedName:'Folder',childPath:[],offset:0,limit:20,maxBytes:1024}));
 assert.equal(result.kind,'directory');assert.equal(result.total,1);assert.equal(result.children?.[0].name,'Folder');
 const read=(childPath:number[],expectedName:string)=>withBackend('local',()=>readDatabaseAttachment({id:'t',index:0,expectedModified:null,expectedName,childPath,offset:0,limit:20,maxBytes:1024}));
 const folder=await read([0],'Folder');assert.equal(folder.kind,'directory');assert.equal(folder.children?.[0].name,'only.txt');
 const file=await read([0,0],'only.txt');assert.equal(file.kind,'file');assert.equal(Buffer.from(file.data!,'base64').toString(),'content');
});

test('handoff input prefixes are normalized without editing historical notes',async()=>{
 const {handoffReason}=await import('../src/handoffLink.js');
 const actor={event:'done',platform:'codex',sessionId:'01a1a4a4-f1bc-7770-9725-10e054be27c7'};
 assert.equal(handoffReason('交付：交付：修复完成',actor),'修复完成\nCodex 对话：codex://threads/01a1a4a4-f1bc-7770-9725-10e054be27c7');
 assert.equal(handoffReason('需要你处理：请核对',{event:'needs_human',platform:'hermes'}),'请核对');
 const db=new Database();db.applyTransaction(wrap(`<context id="afk"><name>AFK</name></context><context id="progress"><name>进行中</name></context><context id="hitl"><name>HITL</name></context><task id="t"><name>Task</name><context idref="afk"/><note>旧备注：交付：交付：历史记录</note></task><task-to-tag id="tp"><task idref="t"/><context idref="progress"/></task-to-tag>`));
 const xml=planWorkflowWrite(db,'t','done',taskState(db,'t'),'交付：新结果');db.applyTransaction(xml);
 assert.equal(db.tasks.get('t')!.note,'旧备注：交付：交付：历史记录\n\n交付：新结果');
});

test('monitor error escalation with a prefixed summary is verified exactly once',async t=>{
 const {Monitor}=await import('../src/monitor/engine.js');const {handoffBody}=await import('../src/handoffLink.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-monitor-prefix-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const live:any={id:'a',tags:['AFK','等待'],note:'Original',completed:false,dropped:false,monitorEligible:true};
 const monitor=new Monitor(root,{read:async()=>structuredClone(live),write:async(_id,event,_before,reason)=>{live.tags=live.tags.filter((s:string)=>s!=='进行中');if(event==='start')live.tags.push('进行中');if(event==='needs_human'){live.tags.push('HITL');live.note+='\n\n需要你处理：'+handoffBody(reason!,event);}}});
 await monitor.configure('a',{source:'test',intervalMinutes:60,timeZone:'Asia/Shanghai',notifyWhen:'change',maxFailures:1,enabled:true,nextCheckAt:'2020-01-01T00:00:00Z'},0);
 const base={id:'a',runId:'test',platform:'hermes',sessionId:'session'};
 await monitor.transition({...base,event:'start',eventId:'start',expectedRevision:1});
 const a={...base,event:'checked',eventId:'checked',expectedRevision:2,outcome:'error',summary:'需要你处理：请核对'};
 const result=await monitor.transition(a);assert.equal(result.effectiveEvent,'needs_human');assert.equal(live.note,'Original\n\n需要你处理：请核对');
 assert.deepEqual(await monitor.transition(a),result);
});

test('legacy shared workflow leaves rich notes unchanged on start and preserves them on handoff',async()=>{
 const {planAgentTransition}=await import('../src/ofocus/agentWorkflow.js');
 const db=new Database();db.applyTransaction(wrap(`<context id="afk"><name>AFK</name></context><context id="progress"><name>进行中</name></context><context id="hitl"><name>HITL</name></context><task id="t"><name>Task</name><context idref="afk"/><note><text><p><run><style><value key="bold">true</value></style><lit>Important</lit></run></p></text></note></task>`));
 const before=db.richNoteMarkup('t');
 const start=planAgentTransition(db,{id:'t',event:'start',runId:'r'});db.applyTransaction(start.xml!);assert.equal(db.richNoteMarkup('t'),before);
 const done=planAgentTransition(db,{id:'t',event:'done',runId:'r',reason:'交付：Finished'},{runId:'r',event:'start'});assert.match(done.xml!,/<style>/);db.applyTransaction(done.xml!);
 assert.equal(db.tasks.get('t')!.note,'Important\n\n交付：Finished');
});

test('rich note markup survives snapshots, ignores references, and clears on plain note replacement',()=>{
 const db=new Database();db.applyTransaction(wrap('<task id="t"><note><text><p><run><lit>Original</lit></run></p></text></note></task>'));
 const saved=Database.fromJSON(db.toJSON());assert.equal(saved.richNoteMarkup('t'),db.richNoteMarkup('t'));
 saved.applyTransaction(wrap('<task id="t" op="reference"><note><text><p><run><lit>Reference</lit></run></p></text></note></task><task id="t" op="update"><note><text><p><run><lit>Updated</lit></run></p></text></note></task>'));
 assert.match(saved.richNoteMarkup('t')!,/Updated/);assert.doesNotMatch(saved.richNoteMarkup('t')!,/Reference/);
 saved.applyTransaction(wrap('<task id="t" op="update"><note>Plain</note></task>'));assert.equal(saved.richNoteMarkup('t'),null);
});
