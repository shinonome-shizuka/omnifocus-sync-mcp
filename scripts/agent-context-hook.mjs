#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=path.join(os.homedir(),'.local/state/omnifocus-agent');
await fs.mkdir(dir,{recursive:true,mode:0o700});
await fs.writeFile(path.join(dir,'last-context-hook.json'),JSON.stringify({at:new Date().toISOString(),event:'context'}),{mode:0o600});
console.log('OmniFocus Agent workflow: When the user assigns an OmniFocus Action, load omnifocus-agent-workflow and bind the exact Action ID. Before work call of_agent_transition(event=start) via MCP with a stable unique runId. On delivery or human intervention call done or needs_human with the same ID/runId and a concrete reason. Never claim unrelated AFK backlog, infer completion from Stop, or create duplicate actions. AFK/进行中/PHV/等待 may have emoji prefixes; use IDs from actual tags. AFK + 进行中 automatically adds 等待. If this chat has no authorized OF Action, do not change task state.');
