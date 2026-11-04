import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {listScript} from '../src/localWorkflow.js';
const now=Date.now();
const rows=Array.from({length:230},(_,i)=>({id:{primaryKey:String(i).padStart(4,'0')},name:'task',note:'private note',tags:[],completed:i>=210,completionDate:i>=210?new Date(now-(i-210)*86400000):null,taskStatus:'available'}));
function run(args:any){return JSON.parse(vm.runInNewContext(listScript(args),{flattenedTasks:rows,Task:{Status:{Dropped:'dropped',Available:'available'}},inactive:(t:any)=>t.completed?'completed':t.taskStatus==='dropped'?'dropped':null,norm:(x:string)=>x,nativeStatus:(t:any)=>t.taskStatus,isAvailable:(t:any)=>!t.completed&&t.taskStatus==='available'}));}
test('default page is bounded, incomplete and compact; all cannot bypass',()=>{for(const args of [{},{filter:'all'}]){const r=run(args);assert.equal(r.count,50);assert.equal(r.total,210);assert.equal(r.nextOffset,50);assert.ok(r.tasks.every((t:any)=>!t.completed&&!('note' in t)));}const a=run({}),b=run({offset:50});assert.ok(!b.tasks.some((t:any)=>a.tasks.some((x:any)=>x.id===t.id)));});
test('doneN returns only recently completed tasks',()=>{const a=run({done:'--done7'}),b=run({doneDays:14});assert.equal(a.count,7);assert.equal(b.count,14);assert.ok(a.tasks.every((t:any)=>t.completed));});
test('reject unbounded and invalid options',()=>{for(const args of [{limit:5000},{limit:0},{offset:-1},{includeCompleted:true},{done:'--done0'},{doneDays:-1},{done:'--done7',doneDays:14}])assert.throws(()=>listScript(args));});
