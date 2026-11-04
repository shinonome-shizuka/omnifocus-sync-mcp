import {input,update,reduce,root} from './session-state.mjs';
import {getLiveTask} from '../dist/localWorkflow.js';
import {terminalPhase,lifecycleTool,recoveryTool,reconcileConfirmed,assertExecutable} from './hermes-guard-policy.mjs';
const p=await input();
try{
 const lifecycle=lifecycleTool(p.tool_name),readonly=recoveryTool(p.tool_name);
 // Discovery is necessary to reach the recovery tools, even with a broken binding.
 if(readonly){console.log('{}');}
 else {
  if(!p.session_id)throw Error('Missing Hermes session_id; OF guard cannot verify ownership');
  const id='hermes:'+p.session_id;
  if(lifecycle){
   let result=p.extra?.result??p.tool_response;
   if(typeof result==='string'){try{result=JSON.parse(result);}catch{}}
   await update(id,async s=>{
    const a=p.tool_input||{},b=(s.bindings||[]).find(b=>b.id===a.id&&b.runId===a.runId);
    if(p.hook_event_name==='pre_tool_call'&&b&&(b.phase==='released'||b.phase==='handed_off'&&a.event!==b.confirmedEvent))throw Error('This run is closed. Do not resume it; new work needs explicit authorization and a new runId.');
    reduce(s,{session_id:id,hook_event_name:p.hook_event_name==='pre_tool_call'?'PreToolUse':'PostToolUse',tool_name:p.tool_name,tool_input:a,tool_use_id:p.extra?.tool_call_id,tool_response:result});
   });
  }else if(p.hook_event_name==='pre_tool_call'){
   let bindings=[];
   await update(id,async s=>{
    for(const b of s.bindings||[])if(!terminalPhase(b))await reconcileConfirmed(root,b,getLiveTask);
    bindings=(s.bindings||[]).filter(b=>!terminalPhase(b));
   });
   for(const b of bindings){
    if(b.phase!=='active')throw Error('OF lifecycle is unconfirmed; use tool_search/tool_describe and OF read/lifecycle tools to resolve '+b.id);
    if(b.mode==='monitor')await (await import('../dist/monitor/runtime.js')).monitor().check(b.id,b.runId);else assertExecutable(await getLiveTask(b.id),b.id);
   }
  }
  console.log('{}');
 }
}catch(e){console.log(JSON.stringify({action:'block',message:'OmniFocus execution guard: '+String(e)}));process.exitCode=2;}
