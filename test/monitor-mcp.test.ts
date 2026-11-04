import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP monitor tools are discoverable, disabled by default and readonly mutations never touch OF',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-mcp-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const client=new Client({name:'monitor-isolation-test',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[process.env.OF_MONITOR_TEST_ENTRY||fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env as Record<string,string>,OF_AGENT_STATE_DIR:root,OMNIFOCUS_READ_ONLY:'true'},stderr:'pipe'});await client.connect(transport);t.after(()=>client.close());
 const {tools}=await client.listTools();for(const name of ['of_monitor_get','of_monitor_configure','of_monitor_due','of_monitor_check','of_monitor_transition','of_monitor_reconcile'])assert.ok(tools.some(t=>t.name===name));
 const schema:any=tools.find(t=>t.name==='of_monitor_configure')!.inputSchema;assert.equal(schema.properties.enabled.default,false);
 const due=await client.callTool({name:'of_monitor_due',arguments:{limit:5}});assert.match(JSON.stringify(due),/total/);assert.match(JSON.stringify(due),/0/);
 const r=await client.callTool({name:'of_monitor_configure',arguments:{id:'fake',expectedRevision:0,source:'fake',intervalMinutes:60,timeZone:'Asia/Shanghai',notifyWhen:'change',nextCheckAt:'2026-11-03T00:00:00Z'}});assert.equal(r.isError,true);assert.match(JSON.stringify(r),/read-only/);assert.deepEqual(await fs.readdir(root),[]);
});
