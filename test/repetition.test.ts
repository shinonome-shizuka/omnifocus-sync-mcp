import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../src/ofocus/database.js';
import {buildAddTask,buildUpdateTask} from '../src/ofocus/writer.js';
import {repetitionElements,RepetitionInput} from '../src/ofocus/repetition.js';
import {summarizeTask} from '../src/ofocus/query.js';
for(const repeat of [
 {rule:'FREQ=DAILY;INTERVAL=2'},
 {rule:'FREQ=WEEKLY;BYDAY=MO,WE,FR',anchor:'planned',catchUpAutomatically:true},
 {rule:'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1',anchor:'defer'},
 {rule:'FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=15;COUNT=3'},
 {rule:'FREQ=DAILY;UNTIL=20271231',method:'due-after-completion'},
 {rule:'FREQ=WEEKLY',method:'start-after-completion'},
] as RepetitionInput[]){
 test('recurrence round trip '+JSON.stringify(repeat),()=>{
  const db=new Database();const {id,xml}=buildAddTask({name:'Recurring action',note:'Keep note',planned:new Date(2026,9,29,4),repetition:repeat});db.applyTransaction(xml);
  let task=db.tasks.get(id)!;assert.equal(task.repetitionRule,repeat.rule);assert.equal(task.repetitionMethod,repeat.method??'fixed');assert.equal(task.catchUpAutomatically,repeat.catchUpAutomatically??false);assert.ok(task.planned);assert.equal(summarizeTask(db.view(task)).repetitionRule,repeat.rule);
  db.applyTransaction(buildUpdateTask(id,{name:'Renamed'}));assert.equal(task.repetitionRule,repeat.rule);
  db.applyTransaction(buildUpdateTask(id,{repetition:null,planned:null}));task=db.tasks.get(id)!;assert.equal(task.repetitionRule,null);assert.equal(task.repetitionMethod,null);assert.equal(task.repetitionScheduleType,null);assert.equal(task.repetitionAnchorDate,null);assert.equal(task.planned,null);assert.equal(task.note,'Keep note');
 });
}
test('invalid and contradictory rules rejected before sync',()=>{
 for(const rule of ['FREQ=DAILY;INTERVAL=0','FREQ=DAILY;COUNT=0','FREQ=NOPE','FREQ=WEEKLY;BYDAY=ZZ','FREQ=DAILY;FREQ=WEEKLY','FREQ=DAILY;COUNT=2;UNTIL=20271231','FREQ=DAILY\n<task/>'])assert.throws(()=>repetitionElements({rule}));
 assert.throws(()=>repetitionElements({rule:'FREQ=DAILY',method:'due-after-completion',anchor:'planned'}));
 assert.throws(()=>repetitionElements({rule:'FREQ=DAILY',method:'start-after-completion',catchUpAutomatically:true}));
});
