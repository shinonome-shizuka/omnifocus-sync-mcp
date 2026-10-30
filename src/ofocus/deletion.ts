import { Database } from './database.js';

/** Include completed/dropped children: deleting their parent would orphan them too. */
export function inspectTaskDeletion(db: Database, id: string) {
  const task = db.tasks.get(id);
  if (!task) throw new Error(`No task with id ${id}`);
  const children = [...db.tasks.values()]
    .filter(child => child.parentId === id)
    .map(child => ({ id: child.id, name: child.name }));
  return { id, name: task.name, isProject: task.isProject, canDelete: children.length === 0, children };
}
