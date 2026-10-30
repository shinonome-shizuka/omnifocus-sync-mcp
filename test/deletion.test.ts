import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/ofocus/database.js';
import { inspectTaskDeletion } from '../src/ofocus/deletion.js';
import { OmniFocusService } from '../src/ofocus/service.js';
import { planTaskMove } from '../src/ofocus/hierarchy.js';
function fixture() {
  const db = new Database();
  db.applyTransaction('<omnifocus><task id="project"><project><status>active</status></project></task><task id="group"><task idref="project"/></task><task id="done"><task idref="group"/><completed>2026-01-01T00:00:00Z</completed></task><task id="dropped"><task idref="group"/><hidden>2026-01-01T00:00:00Z</hidden></task></omnifocus>');
  return db;
}
test('deletion includes completed and dropped children and rejects unknown IDs', () => {
  const db = fixture();
  assert.equal(inspectTaskDeletion(db, 'project').canDelete, false);
  assert.deepEqual(inspectTaskDeletion(db, 'group').children.map(x => x.id), ['done', 'dropped']);
  assert.equal(inspectTaskDeletion(db, 'done').canDelete, true);
  assert.throws(() => inspectTaskDeletion(db, 'missing'), /No task/);
});
test('service dry run and blocked deletion never commit; leaf deletion refreshes and verifies', async () => {
  const db = fixture(); let commits = 0; let refreshes = 0;
  const service = Object.create(OmniFocusService.prototype);
  service.assertWritable = () => {};
  service.refresh = async () => { refreshes++; return { db }; };
  service.commit = async (xml: string) => { commits++; db.applyTransaction(xml); };
  assert.equal((await service.deleteTask('group', true)).canDelete, false);
  await assert.rejects(service.deleteTask('group'), /child items/);
  assert.equal(commits, 0);
  assert.equal((await service.deleteTask('done')).deleted, true);
  assert.equal(commits, 1);
  assert.equal(refreshes, 4);
  assert.equal(db.tasks.has('group'), true);
});
test('move rejects an existing destination with a missing ancestor', () => {
  const db = fixture(); db.tasks.get('group')!.parentId = 'missing';
  assert.throws(() => planTaskMove(db, 'done', 'group'), /missing ancestor/);
});
test('large group deletion inspection visits children without recursive traversal', () => {
  const db = fixture(); const template = db.tasks.get('done')!;
  for (let i = 0; i < 10000; i++) db.tasks.set(`child${i}`, { ...template, id: `child${i}` });
  assert.equal(inspectTaskDeletion(db, 'group').children.length, 10002);
});
