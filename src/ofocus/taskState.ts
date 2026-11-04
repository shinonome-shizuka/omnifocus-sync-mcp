import {Database} from './database.js';
import {OFTask} from './model.js';
import {nativeSnapshots,snapshotInfo} from '../snapshot.js';
const normalized=(s:string)=>s.replace(/^[^\p{L}\p{N}]+/u,'').trim();
/** One interpretation of stored status for both storage paths; never an IPC snapshot. */
export function taskState(db:Database,id:string,ignoreWaiting=false) {
  const t=db.tasks.get(id);if(!t)throw Error('Action not found');
  const v=db.view(t),chain:OFTask[]=[],seen=new Set<string>(),blockers=new Set<string>();
  let n:OFTask|undefined=t;
  while(n){if(seen.has(n.id))throw Error('Cyclic task ancestry');seen.add(n.id);chain.push(n);if(n.parentId&&!db.tasks.has(n.parentId))blockers.add('missing-parent');n=n.parentId?db.tasks.get(n.parentId):undefined;}
  const project=chain.find(x=>x.isProject);
  const projectStatus=project?(project.projectStatus==='inactive'?'on hold':project.projectStatus??'active'):null;
  const completed=chain.some(x=>!!x.completed||x.projectStatus==='done'),dropped=chain.some(x=>!!x.droppedDate||x.projectStatus==='dropped');
  const dates=(key:'due'|'defer')=>chain.map(x=>x[key]).filter((x):x is string=>!!x).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const effectiveDue=dates('due')[0]??null,effectiveDefer=dates('defer').at(-1)??null;
  if(completed||dropped)blockers.add('inactive');
  if(projectStatus&&projectStatus!=='active')blockers.add('project-inactive');
  if(effectiveDefer&&Date.parse(effectiveDefer)>Date.now())blockers.add('deferred');
  if(chain.some(x=>[x.due,x.defer].some(d=>d&&!Number.isFinite(Date.parse(d)))))blockers.add('invalid-date');
  const children=[...db.tasks.values()].filter(c=>c.parentId===id);
  if(children.some(c=>!c.completed&&!c.droppedDate))blockers.add('action-group');
  for(const item of chain){
    for(const tagId of db.view(item).tagIds){let tag=db.tags.get(tagId);const seenTags=new Set<string>();if(!tag)blockers.add('missing-tag');
      while(tag){if(seenTags.has(tag.id))throw Error('Cyclic tag ancestry');seenTags.add(tag.id);
        if(tag.droppedDate)blockers.add('dropped-tag');
        if(tag.prohibitsNextAction&&!(ignoreWaiting&&normalized(tag.name)==='等待'))blockers.add(normalized(tag.name)==='等待'?'waiting-tag':'held-tag');
        if(tag.parentId&&!db.tags.has(tag.parentId))blockers.add('missing-tag-parent');tag=tag.parentId?db.tags.get(tag.parentId):undefined;
      }
    }
    const parent=item.parentId?db.tasks.get(item.parentId):undefined;
    if(parent&&parent.order!=='parallel'&&!parent.singleton){
      const siblings=[...db.tasks.values()].filter(c=>c.parentId===parent.id).sort((a,b)=>(a.rank??0)-(b.rank??0)||a.id.localeCompare(b.id));
      if(siblings.slice(0,siblings.findIndex(c=>c.id===item.id)).some(c=>!c.completed&&!c.droppedDate))blockers.add('sequential-predecessor');
    }
  }
  if(project?.projectFolderId&&!db.folders.has(project.projectFolderId))blockers.add('missing-folder');
  let folder=project?.projectFolderId?db.folders.get(project.projectFolderId):undefined;const seenFolders=new Set<string>();
  while(folder){if(seenFolders.has(folder.id))throw Error('Cyclic folder ancestry');seenFolders.add(folder.id);if(folder.parentId&&!db.folders.has(folder.parentId))blockers.add('missing-folder-parent');if(folder.hidden)blockers.add('folder-inactive');folder=folder.parentId?db.folders.get(folder.parentId):undefined;}
  const native=nativeSnapshots.get(db)?.states.get(id);
  const available=native&&!ignoreWaiting?native.available:blockers.size===0;
  const actualCompleted=native?.completed??completed,actualDropped=native?.dropped??dropped;
  return {...v,note:v.note??'',completed:actualCompleted&&!actualDropped,dropped:actualDropped,completionDate:t.completed,status:actualDropped?'dropped':actualCompleted?'completed':'active',
    tags:v.tagNames,project:v.projectName,projectStatus,projectAllowsExecution:projectStatus===null||projectStatus==='active',effectiveDue:native?.effectiveDue??effectiveDue,effectiveDefer:native?.effectiveDefer??effectiveDefer,
    childrenCount:children.length,available,availabilityVerified:!!native&&!ignoreWaiting,availabilityBlockers:native&&!ignoreWaiting?(available?[]:['native-blocked']):[...blockers],
    ofStatus:native&&!ignoreWaiting?native.ofStatus:dropped?'Dropped':completed?'Completed':!available?'Blocked':effectiveDue&&Date.parse(effectiveDue)<Date.now()?'Overdue':'Available',
    statusSource:native?'omnifocus-sqlite':'transaction-database',snapshot:snapshotInfo(db),statusScope:t.isProject?'project-root-task':'action'};
}
