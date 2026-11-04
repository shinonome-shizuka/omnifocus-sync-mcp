import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {formatData} from '../src/formatData.js';

test('MCP delegates writes to CLI and never falls back on native failure',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'of-native-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const fake=path.join(root,'cli.mjs'),record=path.join(root,'request.json');
 await fs.writeFile(fake,`import fs from 'node:fs';let s='';for await(const c of process.stdin)s+=c;fs.writeFileSync(${JSON.stringify(record)},s);const r=JSON.parse(s);if(r.args.name==='fail'){process.exitCode=1;}else console.log(JSON.stringify({ok:true,id:'native-result'}));`);
 const env={...process.env as Record<string,string>,OMNIFOCUS_CLI_PATH:fake,OMNIFOCUS_LOCAL_DATABASE:path.join(root,'absent'),OF_AGENT_STATE_DIR:path.join(root,'state'),OMNIFOCUS_READ_ONLY:'false'};
 const c=new Client({name:'routing',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/index.js')],env,stderr:'pipe'}));t.after(()=>c.close());
 const tools=(await c.listTools()).tools;assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);assert.ok(!tools.some(t=>t.name==='create_task'));
 const result:any=await c.callTool({name:'of_add_task',arguments:{name:'from MCP'}});assert.ok(!result.isError);assert.equal(JSON.parse(result.content[0].text).id,'native-result');
 assert.equal(JSON.parse(await fs.readFile(record,'utf8')).operation,'of_add_task');
 const failure:any=await c.callTool({name:'of_add_task',arguments:{name:'fail'}});assert.equal(failure.isError,true);assert.match(failure.content[0].text,/of-cli native write failed/);assert.doesNotMatch(failure.content[0].text,/ENOENT/);
 const direct:any=await c.callTool({name:'of_add_task',arguments:{name:'explicit',writeMode:'direct-database'}});assert.equal(direct.isError,true);assert.match(direct.content[0].text,/ENOENT/);
 assert.equal(JSON.parse(await fs.readFile(record,'utf8')).args.name,'fail');
});

test('formatting is pure and CSV quotes multiline text and neutralizes formulas',()=>{
 const rows=[{id:'1',name:'=SUM(A1)',note:'line 1\nline "2"|'}];
 assert.deepEqual(JSON.parse(formatData(rows,'json')),rows);
 assert.match(formatData(rows,'csv'),/"'=SUM\(A1\)"/);
 assert.match(formatData(rows,'csv'),/line ""2""/);
 assert.match(formatData(rows,'markdown'),/<br>line "2"\\\|/);
});
