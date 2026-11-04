#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {registerTools,jsonResult,errorResult} from './tools.js';
import {transition} from './localWorkflow.js';
import {reconcileLegacy} from './legacyRecovery.js';
const server=new McpServer({name:'omnifocus-sync-mcp',version:'0.2.0'});
registerTools(server,register=>{
 register('of_agent_reconcile',{description:'Explicit legacy AFK recovery. Inspect first; then accept verified persisted effects or discard an exactly unchanged unwritten intent. Never writes OF or replays the operation.',inputSchema:{id:z.string(),runId:z.string(),decision:z.enum(['inspect','accept_written','discard_not_written']),expectedIntent:z.string().optional(),reason:z.string().optional()}},async args=>{try{return jsonResult(await reconcileLegacy(args));}catch(e){return errorResult(e);}});
 register('of_agent_transition',{description:'AFK lifecycle with stable runId. Native writes through of-cli; reads from database. No direct database workflow writes.',inputSchema:{id:z.string(),event:z.enum(['start','done','needs_human']),runId:z.string().min(1).max(160),reason:z.string().max(12000).optional(),codexThreadId:z.string().uuid().optional()}},async args=>{try{return jsonResult(await transition(args));}catch(e){return errorResult(e);}});
});
await server.connect(new StdioServerTransport());
