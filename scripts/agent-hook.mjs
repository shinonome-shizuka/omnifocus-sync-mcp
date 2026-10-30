#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const directory=path.join(os.homedir(),'.local/state/omnifocus-agent/pending');
await fs.mkdir(path.dirname(directory),{recursive:true,mode:0o700});
await fs.writeFile(path.join(path.dirname(directory),'last-stop-hook.json'),JSON.stringify({at:new Date().toISOString(),event:'retry'}),{mode:0o600});
const files=(await fs.readdir(directory).catch(()=>[])).filter(n=>n.endsWith('.json'));
if(files.length){
 const client=new Client({name:'omnifocus-agent-hook',version:'1.0.0'});
 const transport=new StdioClientTransport({command:'/bin/bash',args:[fileURLToPath(new URL('./run.sh',import.meta.url))],env:{...process.env,PATH:path.dirname(process.execPath)+':'+(process.env.PATH??'')},stderr:'pipe'});
 let failures=0;
 try{
  await client.connect(transport);
  for(const filename of files){
   const item=JSON.parse(await fs.readFile(path.join(directory,filename),'utf8'));
   // Do not revive abandoned runs long after their originating session.
   if(Date.now()-Date.parse(item.requestedAt)>24*3600*1000){failures++;continue;}
   const {id,event,runId,reason}=item;
   const result=await client.callTool({name:'of_agent_transition',arguments:{id,event,runId,...(reason?{reason}:{})}},undefined,{timeout:90000});
   if(result.isError)failures++;
  }
 }catch{failures++;}finally{await client.close();}
 if(failures){console.error(`[omnifocus-agent] ${failures} pending transition(s) require retry or review; originals retained.`);process.exitCode=1;}
}
