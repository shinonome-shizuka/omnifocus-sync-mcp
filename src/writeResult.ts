import {nativeWrite} from './nativeBridge.js';
import {readLocalDatabase} from './localDatabase.js';
import {taskState} from './ofocus/taskState.js';
import {Database} from './ofocus/database.js';
import {snapshotInfo} from './snapshot.js';

/** Compare observed persisted data, never infer success from an exit code alone. */
export function observeWrite(db:Database,operation:string,a:any,result:any){
 const id=result.completedId||result.id||a.id||result.project?.id;
 const row=id&&db.tasks.has(id)?taskState(db,id):null;
 const sameDate=(x:any,y:any)=>x==null||y==null?x==null&&y==null:Date.parse(x)===Date.parse(y);
 let matches:boolean|null=null;
 if(typeof id!=='string')return {matches,observedState:row,snapshot:snapshotInfo(db)};
 if(operation==='of_delete_task'&&!a.dryRun)matches=!row;
 else if(operation==='of_complete_task')matches=!!row?.completed;
 else if(result.task){
  const expected=result.task;
  matches=!!row&&['name','note','flagged','estimatedMinutes','parentId','order','completedByChildren','repetitionRule','repetitionMethod','catchUpAutomatically','completed','dropped'].every(k=>expected[k]===undefined||expected[k]===((row as any)[k]??null))&&['due','defer','planned'].every(k=>sameDate(expected[k],(row as any)[k]))&&JSON.stringify([...(expected.tags??[])].sort())===JSON.stringify([...row.tags].sort());
 }else if(operation==='of_create_project')matches=!!row?.isProject&&row.name===a.name&&(a.note===undefined||row.note===a.note)&&row.projectFolderId===(a.folderId??null);
 else if(operation==='of_manage_tag'||operation==='of_manage_folder'){
  const obj=(operation==='of_manage_tag'?db.tags:db.folders).get(result.id||a.id);
  matches=a.operation==='delete'?!obj:!!obj&&(a.name===undefined||obj.name===a.name.trim())&&(a.parentId===undefined||obj.parentId===a.parentId);
 }
 return {matches,observedState:row,snapshot:snapshotInfo(db)};
}

export async function writeAndRead(operation:string,args:any){
 const applicationResult=await nativeWrite(operation,args);
 const base={ok:true,id:applicationResult.id??args.id,writeMode:'app',applicationResult};
 try{
  const observation=observeWrite(await readLocalDatabase(),operation,args,applicationResult);
  return {...base,writeStatus:observation.matches===true?'verified':observation.matches===false?'pending-database':'acknowledged-unverified',databaseVisibility:observation.matches===true?'verified':'not-verified',...observation,syncStatus:'not-verified'};
 }catch(e){return {...base,writeStatus:'acknowledged-unverified',databaseVisibility:'unavailable',readError:String(e),syncStatus:'not-verified'};}
}
