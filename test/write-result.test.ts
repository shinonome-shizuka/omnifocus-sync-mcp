import test from 'node:test';import assert from 'node:assert/strict';
import {Database} from '../src/ofocus/database.js';import {observeWrite} from '../src/writeResult.js';
test('native delete acknowledgement is not treated as persisted deletion',()=>{
 const db=new Database();db.applyTransaction('<omnifocus><task id="a"><name>still stored</name><inbox>true</inbox></task></omnifocus>');
 const old=observeWrite(db,'of_delete_task',{id:'a'},{ok:true,id:'a',deleted:true});
 assert.equal(old.matches,false);assert.equal(old.observedState?.name,'still stored');
 assert.equal(old.observedState?.availabilityVerified,false);
 db.applyTransaction('<omnifocus><task id="a" op="delete"/></omnifocus>');
 assert.equal(observeWrite(db,'of_delete_task',{id:'a'},{ok:true,id:'a',deleted:true}).matches,true);
});
test('unknown and batch effects are not falsely verified',()=>{
 assert.equal(observeWrite(new Database(),'of_review_batch',{updates:[]},{ok:true,count:0}).matches,null);
 assert.equal(observeWrite(new Database(),'of_delete_task',{},{}).matches,null);
 assert.equal(observeWrite(new Database(),'of_add_task',{}, {id:'a',task:{name:'new'}}).matches,false);
});
