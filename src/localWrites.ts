import {evaluate} from './localWorkflow.js';
export const localWriteTools=new Set(['of_manage_folder','of_manage_tag','of_create_project','of_update_task_tags','of_add_task','of_complete_task','of_edit_task','of_move_task','of_set_task_status','of_set_group_order','of_delete_task','of_set_review','of_review_batch']);
export function writeScript(operation:string,args:any){
 if(!localWriteTools.has(operation))throw Error('Unsupported local operation');
 return `JSON.stringify((()=>{
 const op=${JSON.stringify(operation)},a=${JSON.stringify(args)};
 const requireId=(items,id)=>{const t=items.find(x=>x.id.primaryKey===id);if(!t)throw Error('Object not found: '+id);return t;};
 const resolve=(items,value)=>{const exact=items.find(x=>x.id.primaryKey===value);if(exact)return exact;const matches=items.filter(x=>x.name.toLowerCase()===value.toLowerCase());if(matches.length!==1)throw Error('Missing or ambiguous object: '+value);return matches[0];};
 const task=id=>requireId(flattenedTasks,id);
 const project=id=>flattenedProjects.find(p=>p.id.primaryKey===id||p.task.id.primaryKey===id)||(()=>{throw Error('Project not found');})();
 const date=value=>{if(value===null||value==='')return null;const d=new Date(value);if(!Number.isFinite(d.getTime()))throw Error('Invalid date');return d;};
 const cycle=(obj,parent,getParent)=>{for(let n=parent;n;n=getParent(n))if(n===obj)throw Error('Cycle rejected');};
 const prepare=fields=>{const out={};for(const k of ['name','note','flagged','estimatedMinutes'])if(fields[k]!==undefined)out[k]=fields[k];
 if(out.name!==undefined&&!out.name.trim())throw Error('Name required');
 if(out.estimatedMinutes!==undefined&&(!Number.isFinite(out.estimatedMinutes)||out.estimatedMinutes<0))throw Error('Invalid estimate');
 for(const [key,prop,clear] of [['due','dueDate','clearDue'],['defer','deferDate','clearDefer'],['planned','plannedDate','clearPlanned']]){if(fields[key]!==undefined&&fields[clear])throw Error('Cannot set and clear same date');if(fields[clear])out[prop]=null;else if(fields[key]!==undefined)out[prop]=date(fields[key]);}
 if(fields.repetition!==undefined){const r=fields.repetition;out.repetitionRule=r===null?null:new Task.RepetitionRule(r.rule,null,r.method==='fixed'?Task.RepetitionScheduleType.Regularly:Task.RepetitionScheduleType.FromCompletion,({due:Task.AnchorDateKey.DueDate,defer:Task.AnchorDateKey.DeferDate,planned:Task.AnchorDateKey.PlannedDate})[r.anchor||(r.method==='start-after-completion'?'defer':'due')],r.catchUpAutomatically??false);}
 return out;};
 const apply=(t,fields)=>{for(const [k,v] of Object.entries(fields))t[k]=v;};
 const result=t=>({ok:true,id:t.id.primaryKey,task:view(t),backend:'local'});
 if(op==='of_add_task'){const fields=prepare(a),p=a.project?resolve(flattenedProjects,a.project):null,tag=a.tag?resolve(flattenedTags,a.tag):null;const t=new Task(a.name,p||inbox.ending);apply(t,fields);if(tag)t.addTag(tag);return result(t);}
 if(op==='of_create_project'){if(!a.name.trim())throw Error('Name required');const folder=a.folderId?requireId(flattenedFolders,a.folderId):null;const p=new Project(a.name.trim(),folder||library.ending);if(a.note!==undefined)p.note=a.note;return {ok:true,id:p.task.id.primaryKey,backend:'local'};}
 if(op==='of_manage_folder'||op==='of_manage_tag'){
 const folder=op==='of_manage_folder',items=folder?flattenedFolders:flattenedTags;
 const obj=a.operation==='create'?null:requireId(items,a.id);const parent=a.parentId?requireId(items,a.parentId):null;
 if(a.name!==undefined&&!a.name.trim())throw Error('Name required');if(a.operation==='create'&&!a.name)throw Error('Name required');
 if(obj&&a.parentId!==undefined)cycle(obj,parent,x=>folder?x.parent:x.parent);
 if(a.operation==='delete'){if(folder?(obj.children.length>0):(obj.children.length>0||obj.tasks.length>0))throw Error('Cannot delete referenced or nonempty object');deleteObject(obj);return {id:a.id,deleted:true,backend:'local'};}
 let current=obj;if(!current)current=folder?new Folder(a.name.trim(),parent||library.ending):new Tag(a.name.trim(),parent||tags.ending);
 else {if(a.name!==undefined)current.name=a.name.trim();if(a.parentId!==undefined){if(folder)moveSections([current],parent?parent.ending:library.ending);else moveTags([current],parent?parent.ending:tags.ending);}}
 return {id:current.id.primaryKey,name:current.name,parentId:parent?parent.id.primaryKey:null,backend:'local'};
 }
 if(op==='of_set_review'||op==='of_review_batch'){
 const updates=op==='of_set_review'?[a]:a.updates;
 const prepared=updates.map(u=>{const p=project(u.id),fields={};for(const [k,prop] of [['nextReview','nextReviewDate'],['lastReview','lastReviewDate']])if(u[k]!==undefined)fields[prop]=date(u[k]);
 if(u.reviewInterval!==undefined){if(u.reviewInterval==='')fields.reviewInterval=null;else {const m=/^@([1-9][0-9]*)([dwmy])$/.exec(u.reviewInterval);if(!m)throw Error('Local reviewInterval supports @Nd/w/m/y; floating ~ intervals require explicit remote backend');const ri=p.reviewInterval;if(!ri)throw Error('Project has no editable review interval');ri.steps=Number(m[1]);ri.unit=({d:'days',w:'weeks',m:'months',y:'years'})[m[2]];fields.reviewInterval=ri;}}return {p,fields};});
 for(const {p,fields} of prepared)apply(p,fields);return {ok:true,count:prepared.length,backend:'local'};
 }
 const t=task(a.id);
 if(op==='of_edit_task'){const fields=prepare(a);apply(t,fields);return result(t);}
 if(op==='of_update_task_tags'){const add=a.add.map(n=>resolve(flattenedTags,n)),remove=a.remove.map(n=>resolve(flattenedTags,n));if(add.some(x=>remove.includes(x)))throw Error('Cannot add and remove same tag');for(const tag of add)t.addTag(tag);for(const tag of remove)t.removeTag(tag);return result(t);}
 if(op==='of_complete_task'){const completed=t.markComplete(a.when?date(a.when):new Date());return {ok:true,id:a.id,completedId:completed?.id.primaryKey||a.id,backend:'local'};}
 if(op==='of_set_task_status'){if(view(t).isProject)throw Error('Individual Action required');if(a.status==='dropped'){const resolved=t.drop(a.allOccurrences===true);return {...result(t),allOccurrences:a.allOccurrences===true,resolvedId:resolved?.id?.primaryKey};}else {if(a.allOccurrences)throw Error('allOccurrences only applies to dropping');t.markIncomplete();t.active=true;}return result(t);}
 if(op==='of_set_group_order'){if(a.completedByChildren&&t.children.length&&t.children.every(x=>x.completed))throw Error('Would immediately complete group; explicit completion required');t.sequential=a.order==='sequential';if(a.completedByChildren!==undefined)t.completedByChildren=a.completedByChildren;return result(t);}
 if(op==='of_move_task'){if(view(t).isProject)throw Error('Projects cannot be moved as Actions');const parent=a.parentId?task(a.parentId):null;cycle(t,parent,x=>x.parent);moveTasks([t],parent?parent.ending:inbox.ending);return result(t);}
 if(op==='of_delete_task'){const children=t.children.map(x=>({id:x.id.primaryKey,name:x.name}));if(a.dryRun)return {id:a.id,dryRun:true,canDelete:!children.length,blockers:children,backend:'local'};if(children.length)throw Error('Cannot delete nonempty task/project');const p=t.containingProject;deleteObject(p&&p.task===t?p:t);return {ok:true,id:a.id,deleted:true,backend:'local'};}
 throw Error('Unsupported operation');
})());`;
}
export async function writeLocal(name:string,args:any){
 if(/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY??''))throw Error('Server is read-only');
 return evaluate(writeScript(name,args));
}
