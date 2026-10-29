import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildTaskTagPatch } from "./writer.js";
import { planAgentTransition } from "./agentWorkflow.js";
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
      const tags = verified.view(task).tagNames;
      const valid = input.event === "start" ? tags.includes("进行中") && !tags.includes("PHV") : tags.includes("PHV") && !tags.includes("进行中");
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

  async deleteTask(id: string): Promise<void> {
    this.assertWritable();
    const loaded = await this.loaded();
    if (!loaded.db.tasks.get(id)) throw new Error(`No task with id ${id}`);
    await this.commit(buildDeleteTask(id));
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
