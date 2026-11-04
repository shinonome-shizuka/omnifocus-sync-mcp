import {readLocalDatabase} from './localDatabase.js';
import {currentBackend} from './backend.js';
import {attachmentMetadata} from './databaseAttachments.js';
import {taskState} from './ofocus/taskState.js';

const norm = (name: string) => name.replace(/^[^\p{L}\p{N}]+/u, '').trim();

/** Shared stored-state interpretation, independent of the storage transport. */
export async function databaseTaskViews() {
  const db=await readLocalDatabase();
  return [...db.tasks.keys()].map(id=>({...taskState(db,id),backend:currentBackend()+'-database'}));
}

export async function databaseTask(id: string, offset = 0, limit = 20) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid attachment page');
  const db=await readLocalDatabase();
  const task=taskState(db,id);
  return {...task,backend:currentBackend()+'-database',...attachmentMetadata(db,id,offset,limit)};
}

export async function databaseTaskList(args: any = {}) {
  const a = {...args, limit: args.limit ?? 50, offset: args.offset ?? 0};
  if (a.done !== undefined) {
    const match = /^--done([1-9][0-9]*)$/.exec(a.done);
    if (!match) throw Error('Use --doneN, for example --done7');
    if (a.doneDays !== undefined && a.doneDays !== Number(match[1])) throw Error('Conflicting done windows');
    a.doneDays = Number(match[1]);
  }
  if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 200 || !Number.isInteger(a.offset) || a.offset < 0) throw Error('limit must be 1–200; offset must be nonnegative');
  if (a.doneDays !== undefined && (!Number.isSafeInteger(a.doneDays) || a.doneDays < 1)) throw Error('doneDays must be a positive integer');
  if (a.includeCompleted && !a.doneDays) throw Error('Use doneDays or --doneN to request completed tasks');

  const now = Date.now(), cutoff = now - (a.doneDays ?? 0) * 86400000;
  let rows = (await databaseTaskViews()).filter(t => !t.isProject && !t.dropped);
  rows = rows.filter(t => a.doneDays ? !!t.completionDate && Date.parse(t.completionDate) >= cutoff && Date.parse(t.completionDate) <= now : !t.completed);
  if (a.project) rows = rows.filter(t => t.project === a.project);
  if (a.tag) rows = rows.filter(t => t.tags.some(name => norm(name) === norm(a.tag)));
  if (a.search) rows = rows.filter(t => (t.name + ' ' + t.note).toLowerCase().includes(a.search.toLowerCase()));
  if (a.filter === 'available') rows=rows.filter(t=>t.available);
  if (a.filter === 'flagged') rows = rows.filter(t => t.flagged);
  if (a.filter === 'inbox') rows = rows.filter(t => t.inInbox);
  if (a.filter === 'due_soon') rows = rows.filter(t => t.effectiveDue && Date.parse(t.effectiveDue) <= now + (a.dueWithinDays ?? 7) * 86400000);
  rows.sort((x, y) => (a.doneDays ? Date.parse(y.completionDate!) - Date.parse(x.completionDate!) : 0) || x.id.localeCompare(y.id));
  const total = rows.length;
  const tasks = rows.slice(a.offset, a.offset + a.limit).map(t => ({id:t.id, name:t.name, tags:t.tags, project:t.project, completed:t.completed, ofStatus:t.ofStatus, available:t.available,availabilityVerified:t.availabilityVerified, statusSource:t.statusSource, completionDate:t.completionDate, flagged:t.flagged, effectiveDue:t.effectiveDue, due:t.due}));
  return {count:tasks.length, total, limit:a.limit, offset:a.offset, hasMore:a.offset + tasks.length < total,
    nextOffset:a.offset + tasks.length < total ? a.offset + tasks.length : null, tasks, backend:currentBackend()+'-database'};
}
