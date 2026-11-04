import {backendService} from './backend.js';
const date=(s:any)=>{if(s===undefined)return undefined;if(s===null||s==='')return null;const d=new Date(s);if(!Number.isFinite(d.getTime()))throw Error('Invalid date');return d;};
/** Compatibility entry for old callers; all operations delegate to the shared service. */
export async function executeDataOperation(name:string,a:any){
 const service=backendService();
 switch(name){
 case 'of_manage_folder':return service.manageCatalog({...a,kind:'folder'});
 case 'of_manage_tag':return service.manageCatalog({...a,kind:'tag'});
 case 'of_create_project':return service.createProject(a.name,a.folderId??null,a.note);
 case 'of_update_task_tags':return service.patchTaskTags(a.id,a.add??[],a.remove??[]);
 case 'of_add_task':return service.addTask({...a,projectNameOrId:a.project,tagNameOrId:a.tag,due:date(a.due)??undefined,defer:date(a.defer)??undefined,planned:date(a.planned)??undefined});
 case 'of_edit_task':{
  for(const [key,clear] of [['due','clearDue'],['defer','clearDefer'],['planned','clearPlanned']])if(a[key]!==undefined&&a[clear])throw Error('Cannot set and clear same date');
  await service.editTask(a.id,{name:a.name,note:a.note,flagged:a.flagged,estimatedMinutes:a.estimatedMinutes,repetition:a.repetition,due:a.clearDue?null:date(a.due),defer:a.clearDefer?null:date(a.defer),planned:a.clearPlanned?null:date(a.planned)});return {ok:true,id:a.id};
 }
 case 'of_complete_task':await service.completeTask(a.id,date(a.when)??new Date());return {ok:true,id:a.id};
 case 'of_move_task':return service.moveTask(a.id,a.parentId);
 case 'of_set_task_status':return service.setTaskStatus(a.id,a.status,a.allOccurrences??false);
 case 'of_set_group_order':return service.setGroupOrder(a.id,a.order,a.completedByChildren);
 case 'of_delete_task':return service.deleteTask(a.id,a.dryRun??false);
 case 'of_set_review':await service.setProjectReview(a.id,{nextReview:date(a.nextReview),lastReview:date(a.lastReview),reviewInterval:a.reviewInterval===''?null:a.reviewInterval});return {ok:true,id:a.id};
 case 'of_review_batch':return {ok:true,count:await service.batchProjectReview(a.updates.map((u:any)=>({...u,nextReview:date(u.nextReview),lastReview:date(u.lastReview),reviewInterval:u.reviewInterval===''?null:u.reviewInterval})))};
 default:throw Error('Unsupported data operation');
 }
}
