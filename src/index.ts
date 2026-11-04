#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {registerTools,jsonResult,errorResult} from './tools.js';
import {registerLedgerTools,requestSchema} from './ledger/tools.js';
import {transition} from './localWorkflow.js';
const server=new McpServer({name:'omnifocus-sync-mcp',version:'0.2.0-staged'});
registerTools(server,register=>{
 registerLedgerTools(register,jsonResult,errorResult);
 register('of_agent_transition',{description:'Ownership protocol v2; native writes through of-cli, database reads. No direct database workflow writes.',inputSchema:{...requestSchema,event:z.enum(['start','done','needs_human']),runId:z.string().min(1).max(160)}},async(args:any)=>{try{return jsonResult(await transition(args));}catch(e){return errorResult(e);}});
});
await server.connect(new StdioServerTransport());
