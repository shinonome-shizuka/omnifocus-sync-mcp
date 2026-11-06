import path from 'node:path';
import { Database } from './ofocus/database.js';
import { taskState } from './ofocus/taskState.js';
import { nativeSnapshots } from './snapshot.js';
import { key, lock, read, save } from './monitor/store.js';

const namespace = 'planned-dispatch';
const norm = (tag: string) => tag.replace(/^[^\p{L}\p{N}]+/u, '').trim();
export const plannedRunId = (id: string, planned: string) => 'planned-' + key(JSON.stringify([id, planned]));
const receiptPath = (root: string, runId: string) => path.join(root, namespace, 'runs', runId + '.json');

export async function activation(root: string, project: string, enable: boolean, now = Date.now) {
  const directory = path.join(root, namespace);
  const file = path.join(directory, key(project) + '.json');
  const load = async () => {
    const config = await read(file);
    if (config && (config.project !== project || !Number.isFinite(config.since))) throw Error('Invalid activation record');
    return config;
  };
  if (!enable) return (await load())?.since ?? null;
  return lock(directory, project, async () => {
    const since = (await load())?.since ?? now();
    await save(file, { project, since });
    return since;
  });
}

export async function ownershipBlock(root: string, id: string) {
  const name = key(id) + '.json';
  const load = (dir: string, suffix = '') => read(path.join(root, dir, name + suffix));
  const [owner, intent, pending, monitor, ledger] = await Promise.all([
    load('local-ownership'), load('local-ownership', '.intent'), load('pending'), load('monitors'), load('ledger-v2'),
  ]);
  if (intent || pending || monitor?.intent) return 'pending-recovery';
  if (monitor?.config?.enabled || monitor?.active || ledger) return 'other-workflow';
  if (owner && !['done', 'needs_human', 'checked'].includes(owner.event)) return 'owned';
  return null;
}

type Candidate = { id: string; name: string; planned: string; priority: number; reason: string };
export async function plannedQueue(db: Database, root: string, project: string, since: number, now: number) {
  if (!nativeSnapshots.has(db)) throw Error('Planned execution requires native SQLite');
  if (!db.tasks.get(project)?.isProject) throw Error('Project ID not found');
  const rows: Candidate[] = [];
  for (const task of db.tasks.values()) {
    if (task.isProject || !task.planned) continue;
    let parent = task.parentId;
    const seen = new Set<string>();
    while (parent && parent !== project && !seen.has(parent)) {
      seen.add(parent);
      parent = db.tasks.get(parent)?.parentId ?? null;
    }
    if (parent !== project) continue;
    const live = taskState(db, task.id);
    const tags = live.tags.map(norm);
    if (!tags.includes('AFK') || live.completed || live.dropped) continue;
    const time = Date.parse(task.planned);
    const reason = !Number.isFinite(time) ? 'invalid-date'
      : time <= since ? 'before-activation' : time > now ? 'future'
      : tags.includes('等待') ? 'waiting' : tags.includes('HITL') ? 'human-handoff'
      : tags.includes('进行中') ? 'in-progress' : !live.available || !live.projectAllowsExecution ? 'unavailable'
      : await ownershipBlock(root, task.id)
        ?? ((await read(receiptPath(root, plannedRunId(task.id, task.planned))))?.status || 'ready');
    const priority = ['P0', 'P1', 'P2', 'P3'].findIndex(tag => tags.includes(tag));
    rows.push({ id: task.id, name: task.name, planned: task.planned, priority: priority < 0 ? 4 : priority, reason });
  }
  return rows.sort((a, b) => a.priority - b.priority || a.planned.localeCompare(b.planned) || a.id.localeCompare(b.id));
}

// Create the receipt before starting a process. An interrupted launch stays visible
// and cannot generate a second worker for the same Action and planned timestamp.
export async function dispatchPlanned(args: {
  root: string; project: string; candidate: Candidate; refresh: () => Promise<Candidate[]>;
  launch: (assignment: {id: string; runId: string; project: string; planned: string}) => Promise<void>;
}) {
  const { root, project, candidate } = args;
  const { id, planned } = candidate;
  const runId = plannedRunId(id, planned);
  const assignment = { id, planned, project, runId };
  const file = receiptPath(root, runId);
  const reserved = await lock(root, id, async () => {
    if (await read(file)) return false;
    const fresh = (await args.refresh()).find(row => row.id === id);
    if (fresh?.planned !== planned || fresh.reason !== 'ready') return false;
    await save(file, { ...assignment, status: 'dispatched' });
    return true;
  }).catch(error => {
    if (error.code === 'EEXIST' && error.path === path.join(root, 'transition-' + key(id) + '.lock')) return false;
    throw error;
  });
  if (!reserved) return { id, status: 'skipped' };
  let workerError: string | undefined;
  try { await args.launch(assignment); } catch (err) { workerError = String(err); }
  return lock(root, id, async () => {
    const owner = await read(path.join(root, 'local-ownership', key(id) + '.json'));
    const pending = await read(path.join(root, 'local-ownership', key(id) + '.json.intent'));
    const status = !pending && owner?.runId === runId && ['done','needs_human'].includes(owner.event)
      ? owner.event : 'needs-inspection';
    const result = { ...assignment, status, workerError };
    await save(file, result);
    return result;
  });
}

export async function scheduledClaim(root: string, input: {event: string; id: string; runId: string}, task: any) {
  if (input.event !== 'start' || !input.runId.startsWith('planned-')) return null;
  if (!task.planned || input.runId !== plannedRunId(input.id, task.planned)) throw Error('Planned date changed');
  const record = await read(receiptPath(root, input.runId));
  if (record?.status !== 'dispatched' || record.id !== input.id || record.planned !== task.planned ||
      task.statusSource !== 'omnifocus-sqlite' || !(Date.parse(task.planned) <= Date.now()) ||
      task.tags.some((t: string) => norm(t) === '等待') || await ownershipBlock(root, input.id)) {
    throw Error('Scheduled dispatch is no longer eligible');
  }
  return { project: record.project, planned: record.planned };
}
