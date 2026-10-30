import { inspectTaskDeletion } from "./deletion.js";
import {planCatalog, CatalogInput} from "./catalog.js";
import {buildAddProject} from "./writer.js";
import { planTaskMove, planTaskStatus } from "./hierarchy.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildTaskTagPatch } from "./writer.js";
import { planAgentTransition, workflowTagName } from "./agentWorkflow.js";
import { Config } from "../config.js";
import { WebDavClient } from "../webdav/client.js";
import { Database } from "./database.js";
import { ClientState, loadOrCreateClientState } from "./clientState.js";
import { OmniFocusStore, StoreListing } from "./store.js";
import { TaskView } from "./model.js";
import {
  AddTaskInput,
  buildAddTask,
  buildBatchProjectReview,
  buildClientPlist,
  buildDeleteTask,
  buildUpdateProjectReview,
  buildUpdateTask,
  ProjectReviewFields,
  UpdateTaskFields,
} from "./writer.js";

interface Loaded {
  db: Database;
  listing: StoreListing;
  headTail: string | null;
}

/** High-level OmniFocus operations over the sync store. */
export class OmniFocusService {
  private readonly store: OmniFocusStore;
  private readonly clientState: ClientState;
  private cache: Loaded | null = null;
  private initialized = false;

  constructor(private readonly config: Config) {
    const dav = new WebDavClient({
      baseUrl: config.ofocusUrl,
      username: config.username,
      password: config.password,
      authScheme: config.authScheme,
    });
    this.store = new OmniFocusStore(dav, config.ofocusUrl);
    this.clientState = loadOrCreateClientState(config.clientStateFile, config.clientName);
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    const listing = await this.store.list();
    if (listing.encrypted) {
      await this.store.unlock(this.config.passphrase);
    }
    this.initialized = true;
  }

  /** Load (or reload) the full database from the server. */
  async refresh(): Promise<Loaded> {
    await this.init();
    this.cache = await this.store.loadDatabase();
    return this.cache;
  }

  private async loaded(): Promise<Loaded> {
    if (!this.cache) return this.refresh();
    return this.cache;
  }

  get readOnly(): boolean {
    return this.config.readOnly;
  }

  get encrypted(): boolean {
    return this.store.isEncrypted;
  }

  // ---- Reads ----

  async tasks(): Promise<TaskView[]> {
    return (await this.loaded()).db.allTaskViews();
  }

  async projects(): Promise<TaskView[]> {
    return (await this.tasks()).filter((t) => t.isProject);
  }

  async db(): Promise<Database> {
    return (await this.loaded()).db;
  }

  private async resolveProjectId(nameOrId: string): Promise<string> {
    const projects = await this.projects();
    const byId = projects.find((p) => p.id === nameOrId);
    if (byId) return byId.id;
    const matches = projects.filter((p) => p.name.toLowerCase() === nameOrId.toLowerCase());
    if (matches.length === 1) return matches[0].id;
    if (matches.length === 0) throw new Error(`No project named "${nameOrId}"`);
    throw new Error(`Ambiguous project name "${nameOrId}" (${matches.length} matches)`);
  }

  private async resolveTagId(nameOrId: string): Promise<string> {
    const db = await this.db();
    if (db.tags.has(nameOrId)) return nameOrId;
    const matches = [...db.tags.values()].filter(
      (t) => t.name.toLowerCase() === nameOrId.toLowerCase(),
    );
    if (matches.length === 1) return matches[0].id;
    if (matches.length === 0) throw new Error(`No tag named "${nameOrId}"`);
    throw new Error(`Ambiguous tag name "${nameOrId}"`);
  }

  // ---- Writes ----

  private assertWritable(): void {
    if (this.config.readOnly) throw new Error("Server is in read-only mode (OMNIFOCUS_READ_ONLY)");
  }

  /** Commit a contents.xml transaction and refresh our client registration. */
  private async commit(contentsXml: string): Promise<void> {
    const loaded = await this.loaded();
    const parents = loaded.headTail ? [loaded.headTail] : [];
    const { tail } = await this.store.writeTransaction(contentsXml, parents);
    // Register/refresh our client file so we're a recognized sync participant.
    const plistXml = buildClientPlist({
      clientId: this.clientState.clientId,
      hostId: this.clientState.hostId,
      name: this.clientState.name,
      registrationDate: new Date(this.clientState.registrationDate),
      lastSyncDate: new Date(),
      tailIdentifiers: [tail],
    });
    await this.store.writeClientFile(this.clientState.clientId, plistXml);
    // Local cache is now stale.
    this.cache = null;
  }

  async manageCatalog(input:CatalogInput){
    this.assertWritable();const {db}=await this.refresh();const plan=planCatalog(db,input);
    await this.commit(plan.xml);const fresh=(await this.refresh()).db;
    const object=(input.kind==='folder'?fresh.folders:fresh.tags).get(plan.id);
    if(input.operation==='delete'){if(object)throw Error('Deletion not verified');return {id:plan.id,deleted:true};}
    if(!object || (input.name!==undefined&&object.name!==input.name.trim()) || (input.parentId!==undefined&&object.parentId!==input.parentId))throw Error('Catalog write not verified');
    return object;
  }
  async createProject(name:string,folderId:string|null,note?:string){
    this.assertWritable();const {db}=await this.refresh();
    if(!name.trim())throw Error('Name required');if(folderId&&!db.folders.has(folderId))throw Error('Folder not found');
    const plan=buildAddProject(name.trim(),folderId,note);await this.commit(plan.xml);
    const fresh=(await this.refresh()).db;const project=fresh.tasks.get(plan.id);
    if(!project?.isProject||project.name!==name.trim())throw Error('Project creation not verified');
    return fresh.view(project);
  }
  async addTask(
    input: AddTaskInput & { projectNameOrId?: string; tagNameOrId?: string },
  ): Promise<{ id: string }> {
    this.assertWritable();
    await this.loaded();
    const resolved: AddTaskInput = { ...input };
    if (input.projectNameOrId) resolved.parentId = await this.resolveProjectId(input.projectNameOrId);
    if (input.tagNameOrId) resolved.tagId = await this.resolveTagId(input.tagNameOrId);
    const { xml, id } = buildAddTask(resolved);
    await this.commit(xml);
    return { id };
  }

  async completeTask(id: string, when: Date = new Date()): Promise<void> {
    this.assertWritable();
    const loaded = await this.loaded();
    const task = loaded.db.tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    let ancestor = task;
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      if (ancestor.repetitionRule) throw new Error("Complete repeating Actions in OmniFocus: sync completion does not generate the next occurrence");
      ancestor = ancestor.parentId ? loaded.db.tasks.get(ancestor.parentId)! : undefined!;
    }
    const xml = buildUpdateTask(id, { completed: when, added: task.added });
    await this.commit(xml);
  }

  async editTask(id: string, fields: UpdateTaskFields): Promise<void> {
    this.assertWritable();
    const loaded = await this.loaded();
    const task = loaded.db.tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    const xml = buildUpdateTask(id, { ...fields, added: task.added });
    await this.commit(xml);
  }

  /** Shared local lock covers Codex, Hermes and hook retries using this client state. */
  async agentTransition(input: {id: string; event: "start" | "done" | "needs_human"; runId: string; reason?: string}) {
    this.assertWritable();
    const lock = this.config.clientStateFile + ".agent-lock";
    await fs.mkdir(lock);
    try {
      const {db} = await this.refresh();
      const plan = planAgentTransition(db, input);
      const pendingDir = path.join(os.homedir(), ".local/state/omnifocus-agent/pending");
      await fs.mkdir(pendingDir,{recursive:true,mode:0o700});
      const pendingFile = path.join(pendingDir,crypto.createHash("sha256").update(input.id).digest("hex")+".json");
      const temporary = pendingFile+"."+process.pid+".tmp";
      await fs.writeFile(temporary,JSON.stringify({...input,requestedAt:new Date().toISOString()}),{mode:0o600});
      await fs.rename(temporary,pendingFile);
      if(plan.xml) await this.commit(plan.xml);
      const verified = (await this.refresh()).db;
      const task = verified.tasks.get(input.id);
      if(!task) throw new Error("Task disappeared during verification");
      const tags = verified.view(task).tagNames.map(workflowTagName);
      const valid = input.event === "start" ? tags.includes("进行中") && tags.includes("等待") && !tags.includes("PHV") : tags.includes("PHV") && !tags.includes("进行中");
      if(!valid) throw new Error("Sync write not yet verified; retry with the same runId/event");
      await fs.unlink(pendingFile);
      return {ok:true,id:input.id,event:input.event,tags,completed:!!task.completed};
    } finally { await fs.rmdir(lock); }
  }

  async patchTaskTags(id: string, add: string[], remove: string[]) {
    this.assertWritable();
    const lock = this.config.clientStateFile + ".agent-lock";
    await fs.mkdir(lock);
    try {
      const {db} = await this.refresh();
      const task = db.tasks.get(id);
      if(!task) throw new Error("Task not found");
      const addIds = await Promise.all(add.map(t=>this.resolveTagId(t)));
      const removeIds = new Set(await Promise.all(remove.map(t=>this.resolveTagId(t))));
      if(addIds.some(id=>removeIds.has(id))) throw new Error("Cannot add and remove the same tag");
      const current = new Set(db.view(task).tagIds);
      const resulting = new Set([...current].filter(tag=>!removeIds.has(tag)).concat(addIds));
      const names = new Set([...resulting].map(tag=>workflowTagName(db.tags.get(tag)?.name??'')));
      if(names.has('AFK') && names.has('进行中')) {
        const waiting=[...db.tags.values()].filter(tag=>workflowTagName(tag.name)==='等待');
        if(waiting.length!==1) throw new Error('Conditional tag rule requires exactly one 等待 tag');
        if(removeIds.has(waiting[0].id)) throw new Error('AFK + 进行中 requires 等待; remove a condition tag first');
        if(!addIds.includes(waiting[0].id)) addIds.push(waiting[0].id);
      }
      const removeJoinIds = db.taskTagJoins(id).filter(j=>removeIds.has(j.tagId)).map(j=>j.id);
      const clearPrimary = !!task.primaryTagId && removeIds.has(task.primaryTagId);
      const missing = [...new Set(addIds)].filter(tag=>!current.has(tag));
      if(missing.length || removeJoinIds.length || clearPrimary) await this.commit(buildTaskTagPatch(id,{addIds:missing,removeJoinIds,clearPrimary,added:task.added}));
      const fresh=(await this.refresh()).db;
      const result=fresh.view(fresh.tasks.get(id)!);
      if(addIds.some(tag=>!result.tagIds.includes(tag)) || [...removeIds].some(tag=>result.tagIds.includes(tag))) throw new Error("Tag update verification failed");
      return {ok:true,id,tags:result.tagNames};
    } finally { await fs.rmdir(lock); }
  }

  async moveTask(id: string, parentId: string | null) {
    this.assertWritable();
    const {db} = await this.refresh();
    const fields = planTaskMove(db,id,parentId);
    await this.commit(buildUpdateTask(id,fields));
    const fresh=(await this.refresh()).db;
    const task=fresh.tasks.get(id);
    if(!task || task.parentId!==parentId || task.inInbox!==(parentId===null)) throw new Error("Move not verified; read current state before retrying");
    return fresh.view(task);
  }

  async setTaskStatus(id:string,status:"active"|"dropped") {
    this.assertWritable();
    const {db}=await this.refresh();
    await this.commit(buildUpdateTask(id,planTaskStatus(db,id,status)));
    const fresh=(await this.refresh()).db;
    const task=fresh.tasks.get(id);
    if(!task || (status==="active" ? !!task.completed || !!task.droppedDate : !task.droppedDate)) throw new Error("Status change not verified");
    return fresh.view(task);
  }

  async setGroupOrder(id:string,order:"parallel"|"sequential",completedByChildren?:boolean) {
    this.assertWritable();
    const {db}=await this.refresh();
    const task=db.tasks.get(id);
    if(!task) throw new Error("Task or project not found");
    await this.commit(buildUpdateTask(id,{order,completedByChildren,added:task.added}));
    const fresh=(await this.refresh()).db;
    const updated=fresh.tasks.get(id);
    if(!updated || updated.order!==order || (completedByChildren!==undefined && updated.completedByChildren!==completedByChildren))throw new Error("Group settings not verified");
    return fresh.view(updated);
  }

  async deleteTask(id: string, dryRun = false) {
    this.assertWritable();
    const { db } = await this.refresh();
    const plan = inspectTaskDeletion(db, id);
    if (dryRun) return { ...plan, deleted: false, dryRun: true };
    if (!plan.canDelete) throw new Error(`Cannot delete ${id}: ${plan.children.length} child items remain. Move or delete them explicitly first; use dryRun to inspect.`);
    await this.commit(buildDeleteTask(id));
    const fresh = (await this.refresh()).db;
    if (fresh.tasks.has(id)) throw new Error("Deletion not verified; read current state before retrying");
    return { ...plan, deleted: true, dryRun: false };
  }

  /** Set review fields on a single project. */
  async setProjectReview(id: string, fields: ProjectReviewFields): Promise<void> {
    this.assertWritable();
    const loaded = await this.loaded();
    const p = loaded.db.tasks.get(id);
    if (!p || !p.isProject) throw new Error(`No project with id ${id}`);
    await this.commit(buildUpdateProjectReview(id, p.projectFolderId, p.projectStatus, fields));
  }

  /** Set review fields on many projects in a single transaction. */
  async batchProjectReview(
    updates: { id: string; nextReview?: Date | null; lastReview?: Date | null; reviewInterval?: string | null }[],
  ): Promise<number> {
    this.assertWritable();
    const loaded = await this.loaded();
    const built = updates.map((u) => {
      const p = loaded.db.tasks.get(u.id);
      if (!p || !p.isProject) throw new Error(`No project with id ${u.id}`);
      const { id, ...fields } = u;
      return { id, folderId: p.projectFolderId, status: p.projectStatus, fields };
    });
    await this.commit(buildBatchProjectReview(built));
    return built.length;
  }
}
