import {Ledger,sameOwner,type Owner} from './engine.js';
export interface Binding {id:string;actor:Owner;revision:number;pending?:boolean}
export const lifecycleTool=(name:string)=>/of_agent_(transition|transfer)$/.test(name);
export const diagnosticTool=(name:string)=>/of_(agent_ledger|agent_check|get_task|list_tasks|sync)$/.test(name);
export async function guardExecution(ledger:Ledger,bindings:Binding[],actorSession:Pick<Owner,'platform'|'sessionId'>,tool:string) {
  if(lifecycleTool(tool)||diagnosticTool(tool))return;
  for(const b of bindings) {
    if(b.actor.platform!==actorSession.platform||b.actor.sessionId!==actorSession.sessionId)throw Error('Session identity mismatch');
    if(b.pending)throw Error('Lifecycle unconfirmed; resolve via MCP');
    // A transferred sender remains fenced even though Stop is now allowed.
    await ledger.execution(b.id,b.actor,b.revision);
  }
}
export async function guardStop(ledger:Ledger,bindings:Binding[],session:Pick<Owner,'platform'|'sessionId'>) {
  for(const b of bindings) {
    if(b.actor.platform!==session.platform||b.actor.sessionId!==session.sessionId)throw Error('Session identity mismatch');
    const d=await ledger.load(b.id);
    if(d.intent)throw Error('Uncertain write blocks Stop');
    const terminal=d.events.find(e=>(sameOwner(e.actor,b.actor)&&['delivered','needs_human'].includes(e.eventType))||(e.eventType==='human_revoked'&&sameOwner(e.fromOwner,b.actor)));
    const transferred=d.events.find(e=>e.eventType==='transfer_accepted'&&sameOwner(e.fromOwner,b.actor));
    if(!terminal&&!transferred)throw Error('No confirmed delivery or accepted transfer; Stop cannot infer completion');
  }
}
export async function refreshBinding(ledger:Ledger,b:Binding) {
  const d=await ledger.load(b.id);
  return {...b,revision:d.projection.revision,pending:!!d.intent};
}
