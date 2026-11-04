import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {handoffReason} from '../src/handoffLink.js';import {helpers,transitionScript} from '../src/localWorkflow.js';
const id='01a19ca9-9c40-7ea3-a841-165953545723',url='codex://threads/'+id;
test('full Codex run ID or explicit actor produces exact chat link',()=>{for(const identity of [{runId:'codex-'+id+'-task-1'},{codexThreadId:id},{actor:{platform:'codex',sessionId:id}}])assert.equal(handoffReason('已交付',identity),'已交付\nCodex 对话：'+url);});
test('links deduplicate, Hermes is untouched and malformed IDs cannot create fake links',()=>{assert.equal(handoffReason('已交付\n'+url,{codexThreadId:id}),'已交付\n'+url);assert.equal(handoffReason('已交付',{platform:'hermes',sessionId:'h',runId:'hermes-h'}),'已交付');assert.throws(()=>handoffReason('x',{codexThreadId:'bad'}),/UUID/);assert.throws(()=>handoffReason('x',{runId:'codex-short'}),/requires/);});
test('native handoff keeps previous notes and retries never duplicate links',()=>{
 const tags=[{name:'AFK'},{name:'进行中'},{name:'HITL'}];const t:any={id:{primaryKey:'a'},name:'A',note:'原有备注',taskStatus:'Available',tags:tags.slice(0,2),addTag(x:any){this.tags.push(x);},removeTag(x:any){this.tags=this.tags.filter((v:any)=>v!==x);}};
 const ctx={flattenedTasks:[t],flattenedTags:tags,Task:{Status:{Available:'Available',Completed:'Completed',Dropped:'Dropped'}},Project:{Status:{}}};
 const a={id:'a',runId:'codex-'+id+'-task',event:'done',reason:'交付内容'};vm.runInNewContext(helpers+transitionScript(a,{runId:a.runId,event:'start'},{note:t.note,tags:t.tags.map((x:any)=>x.name)}),{...ctx});
 assert.equal(t.note,'原有备注\n\n交付：交付内容\nCodex 对话：'+url);
 vm.runInNewContext(helpers+transitionScript(a,{runId:a.runId,event:'done',reason:a.reason},{}),{...ctx});assert.equal(t.note.split(url).length-1,1);
});
