#!/usr/bin/env node
import {input,sessionId,update,reduce} from './session-state.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=path.join(os.homedir(),'.local/state/omnifocus-agent');
await fs.mkdir(dir,{recursive:true,mode:0o700});
await fs.writeFile(path.join(dir,'last-context-hook.json'),JSON.stringify({at:new Date().toISOString(),event:'context'}),{mode:0o600});
console.log('OmniFocus Agent workflow: Before implementing a concrete user request, load omnifocus-agent-workflow and check whether the requested work matches an AFK Action via MCP. An explicit omnifocus:///task/ID link identifies the candidate directly; otherwise search using the requested work title and inspect the candidate. Do not assume that absence of an OF link means no assigned Action. Bind only an unambiguous matching Action whose work the user actually authorized; ask on ambiguity and never claim unrelated backlog. When a link is supplied only as a bug example, inspect it without claiming or replaying its lifecycle. Before work call of_agent_transition(event=start) via MCP with a stable unique runId. On delivery or human intervention call done or needs_human with the same ID/runId and a concrete reason. Never claim unrelated AFK backlog, infer completion from Stop, or create duplicate actions. AFK/进行中/HITL/等待 may have emoji prefixes; use IDs from actual tags. Never automatically add or remove 等待. If this chat has no authorized OF Action, do not change task state.');

try { const payload=await input(); const id=sessionId(payload); if(id){const state=await update(id,s=>{reduce(s,payload);return s;});console.log('OmniFocus session mapping: session='+id+'. Active records: '+JSON.stringify(state.bindings.filter(b=>b.phase!=='handed_off'))+'. Before ending this turn, either confirm lifecycle via MCP or explicitly record why no Action was bound: node /Users/maira_yuki_/dev/omnifocus-sync-mcp-fork/scripts/agent-session.mjs resolve --session '+id+' --status no_match|diagnostic|not_actionable|blocked --reason "specific reason". This records a decision only; it never changes OF state. Stop checks the map and requests one continuation for unresolved bindings.');}}catch(e){console.error('OmniFocus session map: '+e.message);}

console.log("Only execute unfinished, non-dropped Actions. Re-read before claiming; completed/dropped Actions or inactive ancestors/projects are forbidden, including direct links and doneN results. Failed claim means stop work, never bypass or restore automatically.");
