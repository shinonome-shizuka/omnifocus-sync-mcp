#!/usr/bin/env node
// Operator-only offline recovery. Never invoke from a normal agent tool allowlist.
import {runtimeLedger} from '../../dist/ledger/runtime.js';
let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>1024*1024)throw Error('Request too large');}
const r=JSON.parse(raw);
if(process.env.OF_LEDGER_ADMIN!=='explicit-recovery')throw Error('Explicit operator recovery required');
const ledger=runtimeLedger();
const result=r.operation==='import_snapshot'?await ledger.importSnapshot(r.request,r.snapshot,r.source):r.operation==='reconcile'?await ledger.reconcile(r.request,r.outcome):(()=>{throw Error('Unknown operation')})();
console.log(JSON.stringify(result));
