import {backendService,currentBackend} from './backend.js';
import {nativeDatabasePath,readNativeDatabase} from './nativeDatabase.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Database} from './ofocus/database.js';
import {snapshotInfo} from './snapshot.js';
const readScope=new AsyncLocalStorage<{db?:Database}>();
/** One snapshot per read request, including exports and aggregates. Never cache write verification polls. */
export async function withReadSnapshot(fn:()=>Promise<any>){return readScope.run({},async()=>{
 const result=await fn(),db=readScope.getStore()?.db;
 if(db&&Array.isArray(result?.content))return {...result,content:result.content.map((c:any)=>{if(c.type!=='text')return c;try{const value=JSON.parse(c.text);return {...c,text:JSON.stringify({...value,snapshot:snapshotInfo(db)})};}catch{return c;}})};
 return result;
});}
// Compatibility name: the active request chooses storage; reconstruction is shared.
export async function readLocalDatabase(){const scope=readScope.getStore();if(scope?.db)return scope.db;const file=currentBackend()==='local'?nativeDatabasePath():null;const db=file?await readNativeDatabase(file):(await backendService().refresh()).db;if(scope)scope.db=db;return db;}
export async function localViews(){const db=await readLocalDatabase();return db.allTaskViews().map(t=>{let status=t.status;let n=db.tasks.get(t.id);const visited=new Set<string>();while(n){if(visited.has(n.id))throw Error('Cyclic task ancestry');visited.add(n.id);if(n.droppedDate||n.projectStatus==='dropped'){status='dropped';break;}if(n.completed||n.projectStatus==='done')status='completed';n=n.parentId?db.tasks.get(n.parentId):undefined;}return {...t,status,completionDate:t.completed,completed:status==='completed',dropped:status==='dropped',tags:t.tagNames,project:t.projectName,backend:'local-database'};});}
