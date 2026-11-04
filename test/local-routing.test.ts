import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {localWriteTools} from '../src/localWrites.js';
test('all write tools default local without remote credentials; remote only explicit; readonly enforced',async()=>{
 const client=new Client({name:'route-test',version:'1'});
 const env=Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&!k.startsWith('OMNIFOCUS_'))) as Record<string,string>;env.OMNIFOCUS_READ_ONLY='true';
 await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env,stderr:'pipe'}));
 try{
 const listing=await client.listTools();for(const name of localWriteTools){const tool=listing.tools.find(t=>t.name===name)!;assert.ok(tool,name);assert.equal((tool.inputSchema.properties as any).backend.default,'local');assert.equal((tool.inputSchema.properties as any).writeMode.default,'app');assert.match(tool.description!,/HIGH RISK/);}
 const local:any=await client.callTool({name:'of_edit_task',arguments:{id:'nonexistent',name:'test'}});assert.equal(local.isError,true);assert.match(local.content[0].text,/read-only/);assert.doesNotMatch(local.content[0].text,/USERNAME/);
 const remote:any=await client.callTool({name:'of_edit_task',arguments:{id:'nonexistent',name:'test',backend:'remote'}});assert.equal(remote.isError,true);assert.match(remote.content[0].text,/explicit writeMode=direct-database/);
 const invalid:any=await client.callTool({name:'of_edit_task',arguments:{id:'nonexistent',backend:'automatic'}});assert.equal(invalid.isError,true);
 }finally{await client.close();}
});
