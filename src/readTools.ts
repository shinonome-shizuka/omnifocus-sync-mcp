import {z} from 'zod';
import {readLocalDatabase} from './localDatabase.js';
import {databaseTaskList,databaseTaskViews} from './databaseReads.js';
import {formatData} from './formatData.js';
export const extraReadTools=new Set(['of_stats','of_get_object','of_export_tasks']);
export function registerReadTools(register:any,json:any){
 register('of_stats',{description:'Database counts for tasks, projects, inbox, tags and folders. Does not launch OmniFocus.',inputSchema:{}},async()=>{
  const db=await readLocalDatabase(),rows=await databaseTaskViews(),tasks=rows.filter(t=>!t.isProject);
  return json({tasks:{total:tasks.length,remaining:tasks.filter(t=>!t.completed&&!t.dropped).length,completed:tasks.filter(t=>t.completed).length,dropped:tasks.filter(t=>t.dropped).length,available:tasks.filter(t=>t.available).length},projects:rows.filter(t=>t.isProject).length,inbox:tasks.filter(t=>t.inInbox&&!t.completed&&!t.dropped).length,tags:db.tags.size,folders:db.folders.size});
 });
 register('of_get_object',{description:'Read a tag or folder by exact ID, including path and direct child IDs.',inputSchema:{kind:z.enum(['tag','folder']),id:z.string()}},async(a:any)=>{
  const db=await readLocalDatabase(),items=a.kind==='tag'?db.tags:db.folders,obj=items.get(a.id);if(!obj)throw Error('Object not found');
  return json({...obj,children:[...items.values()].filter(x=>x.parentId===a.id).map(x=>x.id),...(a.kind==='folder'?{path:db.folderPath(a.id)}:{})});
 });
 register('of_export_tasks',{description:'Read a bounded task page, then format as JSON, CSV or Markdown. Default unfinished tasks; completed export requires doneDays. No app automation.',inputSchema:{format:z.enum(['json','csv','markdown']).default('json'),project:z.string().optional(),search:z.string().optional(),doneDays:z.number().int().positive().optional(),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(200).default(50)}},async(a:any)=>{
  const page=await databaseTaskList(a),wanted=new Set(page.tasks.map(t=>t.id)),rows=(await databaseTaskViews()).filter(t=>wanted.has(t.id));
  const byId=new Map(rows.map(t=>[t.id,t]));
  return json({format:a.format,total:page.total,count:page.count,nextOffset:page.nextOffset,data:formatData(page.tasks.map(t=>byId.get(t.id)!),a.format)});
 });
}
