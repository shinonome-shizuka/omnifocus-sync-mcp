import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {helpers,listScript,transitionScript} from '../src/localWorkflow.js';
const statuses=Object.fromEntries(['Available','Next','DueSoon','Overdue','Blocked','Completed','Dropped'].map(k=>[k,k]));
function task(status:string,id=status):any{return {id:{primaryKey:id},name:id,note:'',tags:[{name:'AFK'}],taskStatus:status,completed:status==='Completed',completionDate:status==='Completed'?new Date():null};}
function context(rows:any[]){return {flattenedTasks:rows,Task:{Status:statuses},Project:{Status:{Done:'Done',Dropped:'Dropped'}},flattenedTags:[]};}
test('all OF status variants retain native state and correct availability',()=>{
 for(const s of [...Object.keys(statuses),'Unknown']){
  const t=task(s);const v=JSON.parse(vm.runInNewContext(helpers+'JSON.stringify(view(flattenedTasks[0]));',context([t])));
  assert.equal(v.ofStatus,s);assert.equal(v.available,['Available','Next','DueSoon','Overdue'].includes(s));assert.equal(v.statusSource,'omnifocus');
 }
});
test('available list includes Next and due states, excluding blocked and inactive',()=>{
 const rows=Object.keys(statuses).map(s=>task(s));const r=JSON.parse(vm.runInNewContext(helpers+listScript({filter:'available'}),context(rows)));
 assert.deepEqual(r.tasks.map((t:any)=>t.ofStatus).sort(),['Available','DueSoon','Next','Overdue']);
});
test('native Next passes start validation without writing, Blocked rejects',()=>{
 for(const status of ['Next','Blocked']){
  const t=task(status,'test');const code=helpers+transitionScript({id:'test',runId:'r',event:'start'},null,{note:'',tags:['AFK']},true);
  if(status==='Next')assert.equal(JSON.parse(vm.runInNewContext(code,context([t]))).validated,true);
  else assert.throws(()=>vm.runInNewContext(code,context([t])),/not available/);
  assert.deepEqual(t.tags,[{name:'AFK'}]);
 }
});
test('inactive ancestors still exclude otherwise available tasks',()=>{
 const t=task('Next');t.parent=task('Dropped');assert.equal(JSON.parse(vm.runInNewContext(helpers+'JSON.stringify(view(flattenedTasks[0]));',context([t]))).available,false);
});
test('5000-task snapshot returns bounded 50-item pages with native status',()=>{
 const rows=Array.from({length:5000},(_,i)=>task(i%2?'Next':'Blocked',String(i).padStart(5,'0')));
 const r=JSON.parse(vm.runInNewContext(helpers+listScript({filter:'available',offset:50}),context(rows)));
 assert.equal(r.total,2500);assert.equal(r.count,50);assert.equal(r.nextOffset,100);assert.ok(r.tasks.every((t:any)=>t.available));
});
test('active project root Blocked does not invalidate a Next child',()=>{
 const root=task('Blocked','root'),child=task('Next','child');const project={status:'Active',task:root};root.containingProject=project;child.containingProject=project;child.parent=root;
 const ctx=context([root,child]);Object.assign(ctx.Project.Status,{Active:'Active',OnHold:'OnHold'});
 const rows=JSON.parse(vm.runInNewContext(helpers+'JSON.stringify(flattenedTasks.map(view));',ctx));
 assert.equal(rows[0].projectStatus,'active');assert.equal(rows[0].projectAllowsExecution,true);assert.equal(rows[0].statusScope,'project-root-task');assert.equal(rows[0].ofStatus,'Blocked');assert.equal(rows[0].available,false);assert.equal(rows[1].available,true);
 assert.equal(JSON.parse(vm.runInNewContext(helpers+transitionScript({id:'child',runId:'r',event:'start'},null,{note:'',tags:['AFK']},true),{...ctx})).validated,true);
});
test('paused projects still block children even if native snapshot says Next',()=>{
 const child=task('Next','child');child.containingProject={status:'OnHold'};const ctx=context([child]);Object.assign(ctx.Project.Status,{Active:'Active',OnHold:'OnHold'});
 const row=JSON.parse(vm.runInNewContext(helpers+'JSON.stringify(view(flattenedTasks[0]));',ctx));assert.equal(row.projectStatus,'on hold');assert.equal(row.projectAllowsExecution,false);assert.equal(row.available,false);
});
