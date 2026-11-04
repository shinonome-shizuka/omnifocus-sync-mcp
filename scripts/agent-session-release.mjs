#!/usr/bin/env node
// Operator recovery: releases a verified stale session binding, never writes OF.
import {update,root} from './session-state.mjs';
import {releaseVerified} from './hermes-guard-policy.mjs';
import {getLiveTask} from '../dist/localWorkflow.js';
const opts={};const args=process.argv.slice(2);for(let i=0;i<args.length;i+=2)opts[args[i].replace(/^--/,'')]=args[i+1];
if(!opts.session||!opts.id||!opts.run||!opts.reason)throw Error('Required: --session --id --run --reason');
const result=await update(opts.session,async s=>{
 const b=(s.bindings||[]).find(b=>b.id===opts.id&&b.runId===opts.run);if(!b)throw Error('Exact session/Action/run binding not found');
 await releaseVerified(root,b,getLiveTask,opts.reason);
 s.resolution={status:'released',reason:opts.reason,at:new Date().toISOString()};
 return {id:b.id,runId:b.runId,phase:b.phase,release:b.release};
});
console.log(JSON.stringify(result));
