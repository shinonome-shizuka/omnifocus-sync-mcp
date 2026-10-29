import {Database} from './database.js';
import {UpdateTaskFields} from './writer.js';
export function planTaskMove(db:Database,id:string,parentId:string|null):UpdateTaskFields {
 const task=db.tasks.get(id);
 if(!task || task.isProject)throw new Error('An Action ID is required; project movement uses a different operation');
 if(parentId!==null){
  let parent=db.tasks.get(parentId);
  if(!parent)throw new Error('Destination does not exist');
  const seen=new Set<string>([id]);
  while(parent){
   if(seen.has(parent.id))throw new Error('Move would create or enter a hierarchy cycle');
   seen.add(parent.id);
   if(db.view(parent).status!=='active' || parent.projectStatus==='inactive')throw new Error('Destination or its ancestor is inactive');
   parent=parent.parentId?db.tasks.get(parent.parentId):undefined;
  }
 }
 if(task.parentId===parentId && task.inInbox===(parentId===null))return {added:task.added};
 const siblings=[...db.tasks.values()].filter(t=>t.id!==id && !t.isProject && t.parentId===parentId && (parentId!==null || t.inInbox));
 const max=Math.max(0,...siblings.map(t=>t.rank??0));
 if(max>=2147483647)throw new Error('Destination rank range is full; reorder in OmniFocus before moving');
 return {parentId,inInbox:parentId===null,rank:max+1,added:task.added};
}
export function planTaskStatus(db:Database,id:string,status:'active'|'dropped'):UpdateTaskFields {
 const task=db.tasks.get(id);
 if(!task || task.isProject)throw new Error('An Action ID is required');
 if(status==='active')return {completed:null,dropped:null,added:task.added};
 if(status!=='dropped')throw new Error('Invalid task status');
 if(task.completed)throw new Error('Reactivate completed Action before dropping it');
 return {dropped:task.droppedDate?new Date(task.droppedDate):new Date(),added:task.added};
}
