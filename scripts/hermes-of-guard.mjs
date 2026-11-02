import {input,update,reduce} from './session-state.mjs';
import {getLiveTask} from '../dist/localWorkflow.js';
const p=await input();
try{
 if(!p.session_id)throw Error('Missing Hermes session_id; OF guard cannot verify ownership');
 const id='hermes:'+p.session_id;
 const lifecycle=/of_agent_transition$/.test(p.tool_name||'');
 const readonly=/of_(get_task|list_tasks|sync)$/.test(p.tool_name||'');
 if(lifecycle){
  let result=p.extra?.result;if(typeof result==='string'){try{result=JSON.parse(result);}catch{}}
  await update(id,s=>reduce(s,{session_id:id,hook_event_name:p.hook_event_name==='pre_tool_call'?'PreToolUse':'PostToolUse',tool_name:p.tool_name,tool_input:p.tool_input,tool_use_id:p.extra?.tool_call_id,tool_response:result}));
 }else if(p.hook_event_name==='pre_tool_call'&&!readonly){
  let bindings=[];await update(id,s=>{bindings=(s.bindings||[]).filter(b=>!['handed_off','rejected'].includes(b.phase));});
  for(const b of bindings){
   if(b.phase!=='active')throw Error('OF lifecycle is unconfirmed; resolve '+b.id+' via MCP before executing tools');
   const t=await getLiveTask(b.id);const tags=t.tags.map(n=>n.replace(/^[^\p{L}\p{N}]+/u,'').trim());
   if(t.completed||t.dropped||!t.available||!tags.includes('AFK')||!tags.includes('进行中')||tags.includes('HITL'))throw Error('OF Action '+b.id+' is no longer executable. Stop; do not restore tags or continue work.');
  }
 }
 console.log('{}');
}catch(e){console.log(JSON.stringify({action:'block',message:'OmniFocus execution guard: '+String(e)}));process.exitCode=2;}
