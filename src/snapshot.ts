import type {Database} from './ofocus/database.js';
export interface NativeState {available:boolean;completed:boolean;dropped:boolean;ofStatus:string;effectiveDue:string|null;effectiveDefer:string|null}
export const nativeSnapshots=new WeakMap<Database,{observedAt:string;states:Map<string,NativeState>}>();
export const snapshotInfo=(db:Database)=>({source:nativeSnapshots.has(db)?'omnifocus-sqlite':'transaction-database',observedAt:nativeSnapshots.get(db)?.observedAt??new Date().toISOString(),scope:nativeSnapshots.has(db)?'persisted-app-database':'sync-transactions',syncStatus:'not-verified'});
