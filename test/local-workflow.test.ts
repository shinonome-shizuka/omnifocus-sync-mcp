import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {transitionScript,helpers} from '../src/localWorkflow.js';
function fixture(){
 const tags=[{name:'🤖 AFK'},{name:'🛫 进行中'},{name:'⏸️ 等待'},{name:'HITL'}];
 const task:any={id:{primaryKey:'test'},name:'test',note:'original',tags:[tags[0]],addTag(t:any){if(!this.tags.includes(t))this.tags.push(t)},removeTag(t:any){this.tags=this.tags.filter((x:any)=>x!==t)}};
 const view=(t:any)=>({id:'test',note:t.note,tags:t.tags.map((x:any)=>x.name),completed:false,available:true});
 const context={flattenedTasks:[task],flattenedTags:tags,view,norm:(n:string)=>n.replace(/^[^\p{L}\p{N}]+/u,'').trim(),Tag:class {name:string;constructor(n:string){this.name=n;tags.push(this)}}};
 return {task,run:(event:string,previous:any,validate=false)=>JSON.parse(vm.runInNewContext(transitionScript({id:'test',runId:'run',event,reason:'结果'},previous,view(task),validate),{...context}))};
}
test('local start, handoff, retry preserve note and other tags',()=>{const f=fixture();f.run('start',null,true);assert.equal(f.task.tags.length,1);f.run('start',null);assert.equal(f.task.note,'original');assert.throws(()=>f.run('start',null),/owned/);f.run('start',{runId:'run',event:'start'});f.run('done',{runId:'run',event:'start'});f.run('done',{runId:'run',event:'done'});assert.equal(f.task.note,'original\n\n交付：结果');assert.deepEqual(f.task.tags.map((t:any)=>t.name),['🤖 AFK','HITL']);});
test('local rejects unclaimed handoff and ended-run restart',()=>{const f=fixture();assert.throws(()=>f.run('done',null),/Claim/);assert.throws(()=>f.run('start',{runId:'run',event:'done'}),/ended/);});

test('real serializer rejects completed/dropped actions and inactive ancestors before mutation',()=>{
 for(const variant of ['dropped','completed','parent-dropped','project-dropped','project-done']){
 const f=fixture();const t=f.task;t.completed=variant==='completed';t.taskStatus=variant==='dropped'?'dropped':'available';
 if(variant==='parent-dropped')t.parent={id:{primaryKey:'parent'},taskStatus:'dropped'};
 if(variant.startsWith('project-'))t.containingProject={status:variant==='project-done'?'done':'dropped',name:'p'};
 const ctx={flattenedTasks:[t],flattenedTags:[],Task:{Status:{Dropped:'dropped',Completed:'completed',Available:'available'}},Project:{Status:{Dropped:'dropped',Done:'done'}}};
 for(const event of ['start','done','needs_human'])assert.throws(()=>vm.runInNewContext(helpers+transitionScript({id:'test',runId:'run',event,reason:'result'},{runId:'run',event:'start'},{}),{...ctx}),/active Action/);
 assert.equal(t.note,'original');assert.equal(t.tags.length,1);
 }
});

test('HITL requires human reassignment and removed progress cannot restart same run',()=>{const f=fixture();f.task.tags.push({name:'👨 HITL'});assert.throws(()=>f.run('start',null),/Human handoff/);f.task.tags.pop();f.run('start',null);f.task.tags=f.task.tags.filter((t:any)=>t.name!=='🛫 进行中');assert.throws(()=>f.run('start',{runId:'run',event:'start'}),/Progress was removed/);});
