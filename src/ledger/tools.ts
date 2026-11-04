import {z} from 'zod';
import {runtimeLedger,writable} from './runtime.js';
const owner=z.object({platform:z.enum(['codex','hermes','multica']),sessionId:z.string().min(1).max(256),runId:z.string().min(1).max(160)}).strict();
const external=z.object({system:z.string(),workspaceId:z.string().min(1),issueId:z.string().min(1),identifier:z.string(),url:z.string().url()}).strict();
export const requestSchema={protocolVersion:z.literal(2),id:z.string().min(1),eventId:z.string().min(1).max(160),expectedRevision:z.number().int().nonnegative(),actor:owner,reason:z.string().max(2000).optional(),evidence:z.array(z.string().max(2000)).max(20).optional(),externalTask:external.optional()};
export function registerLedgerTools(register:any,json:any,error:any) {
  register('of_agent_transfer',{
    description:'Protocol v2 offer/accept/cancel. Offer suspends sender execution; accept requires exact target identity and private single-use credential. No OF tag writes. No automatic external dispatch.',
    inputSchema:{...requestSchema,action:z.enum(['offer','accept','cancel']),transferId:z.string().min(1).max(160),target:owner.extend({sessionId:z.string().min(1).max(256).optional()}).optional(),expiresAt:z.string().datetime().optional(),credential:z.string().min(32).max(256).optional()}
  },async(r:any)=>{try{writable();return json(await runtimeLedger().transfer(r));}catch(e){return error(e);}});
  register('of_agent_ledger',{
    description:'Read v2 ownership projection and paginated audit events. No credentials in response.',
    inputSchema:{id:z.string().min(1),limit:z.number().int().min(1).max(100).default(20),beforeSequence:z.number().int().positive().optional()}
  },async(r:any)=>{try{return json(await runtimeLedger().page(r.id,r.limit,r.beforeSequence));}catch(e){return error(e);}});
  register('of_agent_check',{
    description:'Fail closed unless exact owner/session/run/revision and live OF state permit execution. Check immediately before business tools.',
    inputSchema:{id:z.string().min(1),actor:owner,expectedRevision:z.number().int().nonnegative()}
  },async(r:any)=>{try{return json(await runtimeLedger().execution(r.id,r.actor,r.expectedRevision));}catch(e){return error(e);}});
}
