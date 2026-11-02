import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
export const root=process.env.OF_AGENT_STATE_DIR||path.join(os.homedir(),'.local/state/omnifocus-agent');
export async function input(){let text='';for await(const part of process.stdin){text+=part;if(text.length>4*1024*1024)throw Error('Hook input too large');}return text.trim()?JSON.parse(text):{};}
export function sessionId(p){return p.session_id||p.sessionId||process.env.CODEX_THREAD_ID||null;}
export function unpack(r){
 for(let i=0;i<8;i++){
  if(typeof r==='string'){try{r=JSON.parse(r);continue;}catch{return {};}}
  if(r?.isError||r?.error)return {ok:false};
  if(r?.ok!==undefined)return r;
  if(r?.structuredContent){r=r.structuredContent;continue;}
  if(r?.result!==undefined){r=r.result;continue;}
  const text=r?.content?.find(c=>c.type==='text')?.text;if(text){r=text;continue;}
  return r;
 }
 return {ok:false};
}
export function reduce(s,p){
 const now=new Date().toISOString(),event=p.hook_event_name;
 s.updatedAt=now;s.bindings||=[];
 if(event==='UserPromptSubmit'){s.turnId=p.turn_id||null;s.work=String(p.prompt||'').slice(0,500);s.resolution=null;}
 if(event==='Resolve'){s.resolution={turnId:p.turn_id||s.turnId,status:p.status,reason:p.reason,at:now};}
 if(event==='PreToolUse'&&/of_agent_transition$/.test(p.tool_name||'')){
  const a=p.tool_input||{};if(!a.id||!a.runId||!['start','done','needs_human'].includes(a.event))return s;
  let b=s.bindings.find(b=>b.id===a.id&&b.runId===a.runId);
  if(!b){b={id:a.id,url:'omnifocus:///task/'+a.id,runId:a.runId,work:s.work||a.reason||'',phase:'unconfirmed'};s.bindings.push(b);}
  b.request={event:a.event,reason:a.reason||'',toolUseId:p.tool_use_id,at:now};b.updatedAt=now;
  // Requested events are not evidence of a successful remote write.
  b.phase=a.event==='start'?'start_pending':'handoff_pending';
 }
 if(event==='PostToolUse'&&/of_agent_transition$/.test(p.tool_name||'')){
  const a=p.tool_input||{},r=unpack(p.tool_response);let b=s.bindings.find(b=>b.id===a.id&&b.runId===a.runId);
  if(!b){reduce(s,{...p,hook_event_name:'PreToolUse'});b=s.bindings.find(b=>b.id===a.id&&b.runId===a.runId);}
  if(b){if(r?.ok===true&&r.id===a.id&&r.event===a.event){b.phase=a.event==='start'?'active':'handed_off';b.confirmedEvent=a.event;b.confirmedAt=now;s.resolution={status:'bound',at:now};}else if(r?.ok===false&&r.status==='rejected'&&a.event==='start'&&b.confirmedEvent!=='start'){b.phase='rejected';b.lastError=r.error;s.resolution={status:'rejected',at:now};}else{b.lastError='MCP transition did not return matching ok:true';}b.updatedAt=now;}
 }
 return s;
}
export function guard(s,p){
 const unfinished=(s.bindings||[]).filter(b=>!['handed_off','rejected'].includes(b.phase));
 let reason=null;
 if(unfinished.length)reason='OmniFocus session has unfinished lifecycle records: '+unfinished.map(b=>`${b.id} runId=${b.runId} phase=${b.phase}`).join('; ')+'. Check MCP state. For delivered work call done; for an actual human blocker call needs_human, with the same runId and concrete reason. Never infer success from Stop or steal another run. If unable to resolve, explicitly report the blocker.';
 else if(!s.resolution)reason='OmniFocus binding check is missing for this turn. Search matching authorized AFK work before claiming. If no matching authorized Action or this is only diagnosis/conversation, record resolve with a specific reason using agent-session.mjs; do not invent or claim an unrelated task.';
 if(!reason)return {};
 if(p.stop_hook_active)return {systemMessage:'OmniFocus unresolved: '+reason};
 return {decision:'block',reason};
}
export async function update(id,fn){
 if(!id)throw Error('Missing session_id; refusing shared/global binding');
 const dir=path.join(root,'sessions');await fs.mkdir(dir,{recursive:true,mode:0o700});const file=path.join(dir,crypto.createHash('sha256').update(id).digest('hex')+'.json'),lock=file+'.lock';let acquired=false;
 for(let i=0;i<100;i++){try{await fs.mkdir(lock);acquired=true;break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,20));}}
 if(!acquired)throw Error('Session map busy; retry');
 try{let s;try{s=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;s={version:1,sessionId:id,bindings:[]};}const result=await fn(s);const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(s,null,2),{mode:0o600});await fs.rename(tmp,file);return result;}finally{await fs.rmdir(lock);}
}
