import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync, strToU8, unzipSync, strFromU8} from 'fflate';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {localWriteTools} from '../src/localWrites.js';
import {evaluate} from '../src/localWorkflow.js';

test('automation evaluator is unconditionally disabled', async () => {
  await assert.rejects(evaluate('JSON.stringify({ok:true})'), /automation is disabled/);
});

test('production MCP reads without automation and permits only explicit high-risk transaction writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'of-database-only-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const database = path.join(root, 'OmniFocus.ofocus'), state = path.join(root, 'state');
  await fs.mkdir(database); await fs.mkdir(state);
  const completed = new Date(Date.now() - 86400000).toISOString();
  const baseline = `<omnifocus>
    <context id="tag"><name>🤖 AFK</name></context>
    <context id="progress"><name>🛫 进行中</name></context>
    <context id="hitl"><name>👨 HITL</name></context>
    <context id="wait"><name>⏸️ 等待</name><prohibits-next-action>true</prohibits-next-action></context>
    <folder id="folder"><name>Work</name></folder>
    <task id="project"><name>Project</name><project><status>active</status><folder idref="folder"/></project><due>2026-01-01T00:00:00Z</due></task>
    <task id="a"><name>Before update</name><note><text><p><run><style><value key="bold">true</value></style><lit>database search phrase</lit></run></p></text></note><task idref="project"/><context idref="tag"/></task>
    <task id="b"><name>Second task</name><inbox>true</inbox><flagged>true</flagged></task>
    <task id="done"><name>Recently done</name><completed>${completed}</completed></task>
    <task id="old"><name>Old done</name><completed>2001-01-01T00:00:00Z</completed></task>
    <task id="drop"><name>Dropped</name><hidden>2025-01-01T00:00:00Z</hidden></task>
    <task id="held"><name>Paused</name><project><status>inactive</status></project></task>
    <task id="monitor"><name>Monitor</name><context idref="tag"/></task>
    <task-to-tag id="monitor.wait"><task idref="monitor"/><context idref="wait"/></task-to-tag>
    <attachment id="att"><task idref="a"/><name>evidence.txt</name><data-identifier>data-fixture</data-identifier></attachment>
    <task id="child"><name>Held child</name><task idref="held"/></task>
  </omnifocus>`;
  await fs.writeFile(path.join(database, '00000000000000=root+baseline.zip'), zipSync({'contents.xml':strToU8(baseline)}));
  await fs.writeFile(path.join(database, '20261104000000=baseline+update.zip'), zipSync({'contents.xml':strToU8('<omnifocus><task id="a" op="update"><name>Updated task</name></task></omnifocus>')}));
  await fs.mkdir(path.join(database,'data'));
  await fs.writeFile(path.join(database,'data/data-fixture.zip'),zipSync({'evidence.txt':strToU8('database attachment')}));
  const before = await fs.readdir(database);
  const deny = path.join(root, 'deny.mjs');
  await fs.writeFile(deny, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[k]=()=>{throw Error('FORBIDDEN_CHILD_PROCESS')};
    syncBuiltinESMExports(); globalThis.fetch=()=>{throw Error('FORBIDDEN_NETWORK')};`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k,v]) => v !== undefined && !k.startsWith('OMNIFOCUS_'))) as Record<string,string>;
  Object.assign(env, {OMNIFOCUS_LOCAL_DATABASE:database, OF_AGENT_STATE_DIR:state, HOME:root});
  const client = new Client({name:'database-only-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',deny,path.resolve('dist/index.js')],env,stderr:'pipe'}));
  t.after(() => client.close());
  const call = async (name:string,args:any={}) => {
    const result:any = await client.callTool({name,arguments:localWriteTools.has(name)?{...args,writeMode:"direct-database"}:args});
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await call('of_sync')).backend, 'local-database');
  const page = await call('of_list_tasks',{limit:1});
  assert.equal(page.total, 4); assert.equal(page.count, 1); assert.equal(page.nextOffset, 1);
  assert.equal((await call('of_list_tasks',{filter:'all'})).total, 4);
  const search = await call('of_list_tasks',{search:'search phrase',tag:'AFK',project:'Project'});
  assert.equal(search.tasks[0].name, 'Updated task'); assert.equal(search.tasks[0].available, true);
  assert.equal(search.tasks[0].effectiveDue, '2026-01-01T00:00:00Z');
  assert.ok(!('note' in search.tasks[0]));
  const detail = await call('of_get_task',{id:'a'});
  assert.equal(detail.note, 'database search phrase'); assert.equal(detail.attachments[0].name, 'evidence.txt');
  assert.equal(detail.statusSource, 'transaction-database');
  assert.equal((await call('of_get_task',{id:'child'})).available, false);
  assert.equal((await call('of_get_task',{id:'child'})).projectStatus, 'on hold');
  assert.deepEqual((await call('of_list_tasks',{done:'--done7'})).tasks.map((x:any)=>x.id), ['done']);
  assert.equal((await call('of_list_projects')).count, 2);
  assert.equal((await call('of_list_tags')).tags.find((t:any)=>t.id==='tag').name, '🤖 AFK');
  assert.equal((await call('of_list_folders')).folders[0].path, 'Work');
  const available=await call('of_list_tasks',{filter:'available'});
  assert.deepEqual(available.tasks.map((t:any)=>t.id),['a','b']);
  const attachment:any=await client.callTool({name:'of_read_attachment',arguments:{id:'a',index:0,expectedModified:null,expectedName:'evidence.txt'}});
  assert.ok(!attachment.isError,JSON.stringify(attachment));assert.match(JSON.stringify(attachment),/database attachment/);
  const defaultWrite:any=await client.callTool({name:'of_add_task',arguments:{name:'must not write'}});
  assert.equal(defaultWrite.isError,true);
  assert.match(defaultWrite.content[0].text,/FORBIDDEN_CHILD_PROCESS/);
  assert.deepEqual(await fs.readdir(database),before);
  const exported=await call('of_export_tasks',{format:'csv',limit:1});
  assert.equal(exported.count,1);assert.equal(exported.nextOffset,1);assert.match(exported.data,/"id","name"/);
  assert.equal((await call('of_stats')).inbox,1);
  const folder=await call('of_manage_folder',{operation:'create',name:'Created folder'});
  const tag=await call('of_manage_tag',{operation:'create',name:'Created tag'});
  const project=await call('of_create_project',{name:'Created project',folderId:folder.id});
  const added=await call('of_add_task',{name:'Created task',project:project.id,tag:tag.id,note:'保留描述',due:'2028-01-01',flagged:true});
  await call('of_edit_task',{id:added.id,name:'Updated',clearDue:true,flagged:false});
  const updated=await call('of_get_task',{id:added.id});assert.equal(updated.name,'Updated');assert.equal(updated.note,'保留描述');assert.equal(updated.due,null);assert.equal(updated.flagged,false);
  await call('of_update_task_tags',{id:added.id,add:['tag'],remove:[tag.id]});
  await call('of_move_task',{id:added.id,parentId:null});assert.equal((await call('of_get_task',{id:added.id})).inInbox,true);
  await call('of_set_group_order',{id:project.id,order:'parallel'});
  await call('of_set_review',{id:project.id,reviewInterval:'~1m'});
  await call('of_review_batch',{updates:[{id:project.id,reviewInterval:'@2w'}]});
  await call('of_set_task_status',{id:added.id,status:'dropped'});assert.equal((await call('of_get_task',{id:added.id})).dropped,true);
  await call('of_set_task_status',{id:added.id,status:'active'});
  await call('of_complete_task',{id:added.id});assert.equal((await call('of_get_task',{id:added.id})).completed,true);
  await call('of_delete_task',{id:added.id});
  await call('of_delete_task',{id:project.id});
  await call('of_manage_tag',{id:tag.id,operation:'delete'});
  await call('of_manage_folder',{id:folder.id,operation:'delete'});
  for(const original of before)assert.ok((await fs.readdir(database)).includes(original));
  assert.deepEqual(await fs.readdir(path.join(state,'pending')).catch(e=>{if(e.code==='ENOENT')return [];throw e;}),[]);

  // Missing database must fail, without app launch or remote fallback.
  await fs.rename(database, database + '.removed');
  const missing:any=await client.callTool({name:'of_sync',arguments:{}});
  assert.equal(missing.isError,true); assert.match(missing.content[0].text,/ENOENT/);
});
