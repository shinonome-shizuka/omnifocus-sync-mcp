import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';

test('built scheduler previews, activates, wakes once, and verifies worker outcome', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(),'planned-entry-'));
  t.after(() => fs.rm(tmp,{recursive:true,force:true}));
  const file = path.join(tmp,'of.db'), root = path.join(tmp,'state');
  const db = new DatabaseSync(file);
  t.after(()=>db.close());
  db.exec(await fs.readFile(new URL('./fixtures/native-schema.sql',import.meta.url),'utf8'));
  function insert(table: string, data: Record<string,string|number>) {
    const row: Record<string,string|number> = {};
    for (const column of db.prepare('PRAGMA table_info('+table+')').all()) {
      if(column.notnull) row[String(column.name)] = column.type==='text' ? '' : 0;
    }
    Object.assign(row,data);
    db.prepare('INSERT INTO '+table+' ('+Object.keys(row).join(',')+') VALUES ('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));
  }
  insert('ProjectInfo',{pk:'info',task:'p',status:'active',effectiveStatus:'active'});
  insert('Task',{persistentIdentifier:'p',name:'project',projectInfo:'info'});
  insert('Task',{persistentIdentifier:'a',name:'action',parent:'p',containingProjectInfo:'info',effectiveContainingProjectInfoActive:1,datePlanned:10000});
  insert('Context',{persistentIdentifier:'afk',name:'🤖 AFK',allowsNextAction:1});
  insert('TaskToTag',{persistentIdentifier:'link',tag:'afk',task:'a'});
  const marker = path.join(tmp,'worker-input');
  const worker = ['--run','--',process.execPath,'--input-type=module','-e',
    'import fs from "node:fs";fs.appendFileSync(process.argv[1],fs.readFileSync(0));',marker];
  function command(args:string[]) {
    const run = spawnSync(process.execPath,['dist/plannedScheduler.js','--project','p',...args],{
      env:{...process.env,OF_AGENT_STATE_DIR:root,OMNIFOCUS_NATIVE_DATABASE:file,OMNIFOCUS_READ_ONLY:'0'},encoding:'utf8',timeout:10000,
    });
    assert.ok(!run.error && run.status!==null, String(run.error || run.stderr));
    return run;
  }
  const preview = command([]);
  assert.equal(JSON.parse(preview.stdout).tasks[0].reason,'before-activation');
  await assert.rejects(fs.stat(root),{code:'ENOENT'});
  assert.equal(command(worker).status,0);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  await sleep(10);
  db.prepare("UPDATE Task SET datePlanned=? WHERE persistentIdentifier='a'").run(Date.now()/1000-978307200);
  const dispatched = command(worker);
  assert.equal(dispatched.status,1,dispatched.stderr);
  assert.equal(JSON.parse(dispatched.stdout).status,'needs-inspection');
  const first = await fs.readFile(marker,'utf8');
  assert.match(first,/of_agent_transition/);
  assert.match(first,/"id":"a"/);
  assert.equal(command(worker).status,0);
  assert.equal(await fs.readFile(marker,'utf8'),first);
});
