import {handoffReason} from '../handoffLink.js';
import os from 'node:os';
import path from 'node:path';
import {Ledger, names, type Live, type TransitionRequest} from './engine.js';
import {LedgerStore, canonical} from './store.js';
import {writeWorkflow} from '../workflowWrites.js';
import {getLiveTask} from '../localWorkflow.js';
export const stateRoot=()=>process.env.OF_AGENT_STATE_DIR||path.join(os.homedir(),'.local/state/omnifocus-agent');
export function verifyWrite(before:Live,after:Live,r:TransitionRequest) {
  const expected=new Set(names(before));expected.delete(r.event==='start'?'HITL':'进行中');expected.add(r.event==='start'?'进行中':'HITL');
  let note=before.note||'';
  if(r.event!=='start'){const handoff=(r.event==='done'?'交付：':'需要你处理：')+handoffReason(r.reason!,r);if(!note.endsWith(handoff))note+=(note?'\n\n':'')+handoff;}
  return after.id===before.id&&!after.isProject&&!after.completed&&!after.dropped&&
    canonical([...expected].sort())===canonical([...new Set(names(after))].sort())&&
    (after.note||'')===note&&(r.event!=='start'||after.available);
}
export function runtimeLedger() {
  return new Ledger(new LedgerStore(stateRoot()),{
    read:getLiveTask,
    async write(r,before){
      if(/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY||''))throw Error('Server is read-only');
      await writeWorkflow(r.id,r.event,before,r.event==='start'?undefined:handoffReason(r.reason!,r));
    },verify:verifyWrite
  });
}
export function writable(){if(/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY||''))throw Error('Server is read-only');}
export async function transitionV2(input:any){writable();return runtimeLedger().transition(input);}
