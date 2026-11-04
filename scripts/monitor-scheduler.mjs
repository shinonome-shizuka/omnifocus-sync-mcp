#!/usr/bin/env node
// Opt-in dispatcher. Importing this file or building never starts a service.
import {monitor,root} from '../dist/monitor/runtime.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {key,read,save} from '../dist/monitor/store.js';
const args=process.argv.slice(2),run=args.includes('--run'),watch=args.includes('--watch');
const separator=args.indexOf('--'),command=separator<0?[]:args.slice(separator+1);
if(run&&!command.length)throw Error('--run requires -- <worker executable> [args]. Worker must claim via MCP and return JSON.');
if(watch&&!run)throw Error('--watch requires explicit --run');
async function tick(){
 const queue=await monitor().due(50,0);
 if(!run){console.log(JSON.stringify({dryRun:true,...queue}));return;}
 for(const item of queue.tasks){
  const dir=path.join(root(),'monitor-dispatch');await fs.mkdir(dir,{recursive:true,mode:0o700});
  const failureFile=path.join(dir,key(item.id)+'.json');const failure=await read(failureFile);const config=(await monitor().get(item.id)).config;
  if(failure&&(failure.count>=config.maxFailures||Date.parse(failure.retryAt)>Date.now()))continue;
  const lock=path.join(dir,key(item.id)+'.lock');let h;
  try{h=await fs.open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')continue;throw e;}
  try{
   await h.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
   // No shell interpolation; input carries only identity/revision, not source credentials.
   const output=await new Promise((resolve,reject)=>{
    const child=spawn(command[0],command.slice(1),{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    let killTimer;const timer=setTimeout(()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);},10*60*1000);
    child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1048576)child.kill('SIGTERM');});
    child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4096);});
    child.on('error',e=>{clearTimeout(timer);clearTimeout(killTimer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);if(code!==0)reject(Error('Worker failed; inspect its monitor intent/claim before retry'));else try{resolve(JSON.parse(stdout));}catch{reject(Error('Worker must return one JSON object'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({id:item.id,expectedRevision:item.revision,instruction:'Claim through of_monitor_transition with your actual platform/session and a fresh runId/eventId; check via configured source; finish checked/done/needs_human. Do not contact third parties. Return {notify:boolean,summary:string}. No change stays silent.'}));
   });
   // Ledger, not worker prose, proves that this dispatch reached a terminal round.
   const d=await monitor().get(item.id),last=d.events.at(-1);
   if(d.intent||d.active||d.revision<=item.revision||!['checked','done','needs_human'].includes(last?.type))throw Error('Worker exited without confirmed monitor round');
   await fs.unlink(failureFile).catch(e=>{if(e.code!=='ENOENT')throw e;});
   if(last.result.notify)console.log(JSON.stringify({id:item.id,summary:d.summary,event:last.type}));
  }catch(e){await save(failureFile,{count:(failure?.count||0)+1,retryAt:new Date(Date.now()+config.intervalMinutes*60000).toISOString(),error:String(e)});console.error(JSON.stringify({id:item.id,error:String(e)}));}
  finally{await h.close();await fs.unlink(lock);}
 }
}
await tick();
if(watch)while(true){await new Promise(r=>setTimeout(r,60000));await tick();}
