import assert from 'node:assert/strict';import {reduce,guard} from './session-state.mjs';
const p={hook_event_name:'PreToolUse',tool_name:'mcp__omnifocus__of_agent_transition',tool_input:{id:'task',runId:'run',event:'start'}};
let s=reduce({sessionId:'s',bindings:[]},p);assert.equal(guard(s,{}).decision,'block');
s=reduce(s,{...p,hook_event_name:'PostToolUse',tool_response:{content:[{type:'text',text:JSON.stringify({ok:true,id:'task',event:'start'})}]}});assert.equal(s.bindings[0].phase,'active');assert.equal(guard(s,{}).decision,'block');assert.equal(guard(s,{stop_hook_active:true}).decision,undefined);
const end={...p,tool_input:{id:'task',runId:'run',event:'done',reason:'Delivered'}};reduce(s,end);reduce(s,{...end,hook_event_name:'PostToolUse',tool_response:{isError:true}});assert.equal(s.bindings[0].phase,'handoff_pending');assert.equal(guard(s,{}).decision,'block');reduce(s,{...end,hook_event_name:'PostToolUse',tool_response:{ok:true,id:'task',event:'done'}});assert.deepEqual(guard(s,{}),{});
let none={bindings:[]};assert.equal(guard(none,{}).decision,'block');reduce(none,{hook_event_name:'Resolve',status:'diagnostic',reason:'Inspecting hook evidence'});assert.deepEqual(guard(none,{}),{});
console.log('PASS: pre-write pending, verified ownership, missed handoff blocks, failure retained, no infinite continuation, no-action resolution');
