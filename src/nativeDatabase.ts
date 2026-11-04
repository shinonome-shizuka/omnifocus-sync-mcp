import os from 'node:os';import path from 'node:path';
import {Database} from './ofocus/database.js';import {newTask} from './ofocus/model.js';
import {nativeSnapshots,NativeState} from './snapshot.js';

export function nativeDatabasePath():string|null {
 if(process.env.OMNIFOCUS_NATIVE_DATABASE)return process.env.OMNIFOCUS_NATIVE_DATABASE;
 if(process.env.OMNIFOCUS_LOCAL_READ_SOURCE==='transactions'||process.env.OMNIFOCUS_LOCAL_DATABASE)return null;
 return path.join(os.homedir(),'Library/Group Containers/34YW5XSRB7.com.omnigroup.OmniFocus/com.omnigroup.OmniFocus4/com.omnigroup.OmniFocusModel/OmniFocusDatabase.db');
}
const date=(value:any):string|null=>value===null||value===undefined?null:typeof value==='number'?new Date((value+978307200)*1000).toISOString():String(value);
/** Read the app's committed SQLite/WAL snapshot. No save, checkpoint, or fallback. */
export async function readNativeDatabase(file:string):Promise<Database>{
 const {DatabaseSync}=await import('node:sqlite');
 const connection=new DatabaseSync(file,{readOnly:true,allowExtension:false});
 try{
  connection.exec('PRAGMA query_only=ON; BEGIN');
  const required:Record<string,string[]>={Task:['persistentIdentifier','name','plainTextNote','parent','blocked','blockedByFutureStartDate','effectiveDateCompleted','effectiveDateHidden','effectiveDateDue','effectiveDateToStart','dateModified','projectInfo','containingProjectInfo','effectiveContainingProjectInfoActive','nextTaskOfProjectInfo','overdue','dueSoon'],ProjectInfo:['pk','status','effectiveStatus','task'],Context:['persistentIdentifier','allowsNextAction'],TaskToTag:['persistentIdentifier','task','tag'],Folder:['persistentIdentifier','parent'],Attachment:['persistentIdentifier','task','dataIdentifier']};
  for(const [table,columns] of Object.entries(required)){const found=new Set(connection.prepare(`PRAGMA table_info(${table})`).all().map((c:any)=>c.name));if(columns.some(c=>!found.has(c)))throw Error('Unsupported OmniFocus SQLite schema: '+table);}
  const rows=(table:string):any[]=>connection.prepare(`SELECT * FROM ${table}`).all();
  const projects=new Map(rows('ProjectInfo').map(p=>[p.pk,p])),states=new Map<string,NativeState>();
  const tasks=rows('Task').map(r=>{
   const p=projects.get(r.projectInfo),t=newTask(r.persistentIdentifier);
   Object.assign(t,{name:r.name??'',note:r.plainTextNote??'',added:date(r.dateAdded),modified:date(r.dateModified),completed:date(r.dateCompleted),droppedDate:date(r.dateHidden),due:date(r.dateDue),defer:date(r.dateToStart),planned:date(r.datePlanned),flagged:!!r.flagged,estimatedMinutes:r.estimatedMinutes,parentId:r.parent||null,isProject:!!p,projectStatus:p?.status??null,projectFolderId:p?.folder??null,singleton:!!p?.containsSingletonActions,inInbox:!!r.inInbox,rank:r.rank,order:r.sequential?'sequential':'parallel',completedByChildren:!!r.completeWhenChildrenComplete,repetitionRule:r.repetitionRuleString,repetitionScheduleType:r.repetitionScheduleTypeString,repetitionAnchorDate:r.repetitionAnchorDateKey,repetitionMethod:r.repetitionRuleString?(r.repetitionScheduleTypeString==='from-assigned'?'fixed':r.repetitionAnchorDateKey==='dateToStart'?'start-after-completion':'due-after-completion'):null,catchUpAutomatically:!!r.catchUpAutomatically,nextReview:date(p?.nextReviewDate),lastReview:date(p?.lastReviewDate),reviewInterval:p?.reviewRepetitionString??null});
   const completed=r.effectiveDateCompleted!=null,dropped=r.effectiveDateHidden!=null;
   const projectActive=(!r.containingProjectInfo||!!r.effectiveContainingProjectInfoActive)&&(!p||(p.effectiveStatus||p.status)==='active');
   const available=!completed&&!dropped&&!r.blocked&&!r.blockedByFutureStartDate&&projectActive;
   states.set(t.id,{completed,dropped,available,effectiveDue:date(r.effectiveDateDue),effectiveDefer:date(r.effectiveDateToStart),ofStatus:dropped?'Dropped':completed?'Completed':!available?'Blocked':r.overdue?'Overdue':r.dueSoon?'DueSoon':r.nextTaskOfProjectInfo?'Next':'Available'});
   return [t.id,t];
  });
  const db=Database.fromJSON({tasks,folders:rows('Folder').map(r=>[r.persistentIdentifier,{id:r.persistentIdentifier,name:r.name??'',parentId:r.parent||null,rank:r.rank,hidden:date(r.dateHidden)}]),tags:rows('Context').map(r=>[r.persistentIdentifier,{id:r.persistentIdentifier,name:r.name??'',parentId:r.parent||null,rank:r.rank,prohibitsNextAction:!r.allowsNextAction,droppedDate:date(r.dateHidden)}]),tagJoins:rows('TaskToTag').map(r=>[r.persistentIdentifier,{taskId:r.task,tagId:r.tag}]),attachments:rows('Attachment').filter(r=>r.task).map(r=>[r.persistentIdentifier,{id:r.persistentIdentifier,taskId:r.task,name:r.name??'',dataIdentifier:r.dataIdentifier}]),settings:[]});
  nativeSnapshots.set(db,{observedAt:new Date().toISOString(),states});connection.exec('COMMIT');return db;
 }finally{connection.close();}
}
