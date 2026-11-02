#!/usr/bin/env node
import {localWriteTools,writeLocal} from './localWrites.js';
import {readLocalDatabase} from './localDatabase.js';
import * as localWorkflow from './localWorkflow.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { OmniFocusService } from "./ofocus/service.js";
import { queryTasks, summarizeTask, TaskFilter } from "./ofocus/query.js";
import { ProjectReviewFields } from "./ofocus/writer.js";

const repetitionSchema = z.object({
  rule:z.string().min(1).max(2048).describe("Single RRULE, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR"),
  method:z.enum(["fixed","start-after-completion","due-after-completion"]).default("fixed"),
  anchor:z.enum(["due","defer","planned"]).optional(),
  catchUpAutomatically:z.boolean().default(false),
}).strict();

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
    isError: true,
  };
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

async function main(): Promise<void> {
  let remote:OmniFocusService|undefined;
  const service=new Proxy({} as OmniFocusService,{get(_target,key){remote??=new OmniFocusService(loadConfig());const value=(remote as any)[key];return typeof value==='function'?value.bind(remote):value;}});

  const server = new McpServer({ name: "omnifocus-sync-mcp", version: "0.1.0" });

  const registerTool=(name:string,definition:any,handler:any)=>{
    if(!localWriteTools.has(name))return (server.registerTool.bind(server) as any)(name,definition,handler);
    return (server.registerTool.bind(server) as any)(name,{...definition,description:definition.description+' Defaults to local OmniFocus. Explicit backend=remote uses WebDAV; no automatic fallback.',inputSchema:{...definition.inputSchema,backend:z.enum(['local','remote']).default('local')}},async(args:any,extra:any)=>{
      if(args.backend==='remote')return handler(args,extra);
      try{return jsonResult(await writeLocal(name,args));}catch(e){return errorResult(e);}
    });
  };

  registerTool(
    "of_sync",
    {
      title: "Sync OmniFocus",
      description:
        "Read local OmniFocus counts via macOS automation. No sync-server request.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await localWorkflow.sync());
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool(
    "of_list_tasks",
    {
      title: "List OmniFocus tasks",
      description:
        "Return a compact page of unfinished tasks (50 default, 200 max). Completed tasks ONLY with doneDays=N or done=--doneN; this returns only tasks completed in the last N rolling days. Use of_get_task for notes and details; follow nextOffset for more.",
      inputSchema: {
        filter: z
          .enum(["remaining", "available", "flagged", "inbox", "due_soon", "all"])
          .optional(),
        project: z.string().optional().describe("Filter to a project by name"),
        tag: z.string().optional().describe("Filter to a tag by name"),
        search: z.string().optional().describe("Substring match on name/note"),
        includeCompleted: z.boolean().optional().describe("Deprecated; requires doneDays"),
        doneDays: z.number().int().positive().optional(),
        done: z.string().regex(/^--done[1-9][0-9]*$/).optional().describe("Shorthand such as --done7 or --done14"),
        offset: z.number().int().nonnegative().optional(),
        dueWithinDays: z.number().optional().describe("Window for the due_soon filter (default 7)"),
        limit: z.number().int().min(1).max(200).optional().describe("Page size: default 50, max 200"),
      },
    },
    async (args:any) => {
      try {
        return jsonResult(await localWorkflow.listTasks(args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool(
    "of_get_task",
    {
      title: "Get an OmniFocus task",
      description: "Get a single task by its id, with full detail.",
      inputSchema: { id: z.string() },
    },
    async ({ id }:any) => {
      try {
        return jsonResult(await localWorkflow.getTask(id));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool(
    "of_list_projects",
    {
      title: "List OmniFocus projects",
      description: "List all projects with their folder path and status.",
      inputSchema: { includeDropped: z.boolean().optional() },
    },
    async ({ includeDropped }:any) => {
      try {
        const db = await readLocalDatabase();
        const projects = db.allTaskViews().filter(p => p.isProject)
          .filter((p) => includeDropped || p.status !== "dropped")
          .map((p) => ({
            id: p.id,
            name: p.name,
            folder: db.folderPath(p.projectFolderId),
            status: p.projectStatus ?? "active",
            flagged: p.flagged || undefined,
            due: p.due ?? undefined,
            nextReview: p.nextReview ?? undefined,
            lastReview: p.lastReview ?? undefined,
            reviewInterval: p.reviewInterval ?? undefined,
          }));
        return jsonResult({ count: projects.length, projects });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool("of_list_folders",{description:"List folders with IDs, parent IDs and full paths",inputSchema:{}},async()=>{try{const db=await readLocalDatabase();return jsonResult({folders:[...db.folders.values()].map(f=>({...f,path:db.folderPath(f.id)}))});}catch(e){return errorResult(e);}});
  registerTool("of_manage_folder",{description:"Create, rename, move or delete an empty folder. Reject cycles and referenced deletes.",inputSchema:{operation:z.enum(["create","update","delete"]),id:z.string().optional(),name:z.string().min(1).optional(),parentId:z.string().nullable().optional()}},async (args:any)=>{try{return jsonResult(await service.manageCatalog({...args,kind:"folder"}));}catch(e){return errorResult(e);}});
  registerTool("of_manage_tag",{description:"Create, rename, reparent or delete an unused tag. Reject cycles and referenced deletes.",inputSchema:{operation:z.enum(["create","update","delete"]),id:z.string().optional(),name:z.string().min(1).optional(),parentId:z.string().nullable().optional()}},async (args:any)=>{try{return jsonResult(await service.manageCatalog({...args,kind:"tag"}));}catch(e){return errorResult(e);}});
  registerTool("of_create_project",{description:"Create an active project, optionally inside a folder",inputSchema:{name:z.string().min(1),folderId:z.string().nullable().default(null),note:z.string().optional()}},async (args:any)=>{try{return jsonResult(await service.createProject(args.name,args.folderId,args.note));}catch(e){return errorResult(e);}});

  registerTool("of_list_tags", {
    description:"List tag IDs and names",inputSchema:{}
  },async()=>{try{return jsonResult({tags:[...(await readLocalDatabase()).tags.values()]});}catch(e){return errorResult(e);}});
  registerTool("of_update_task_tags", {
    description:"Add/remove existing tags by ID or exact name; preserves other tags and fields.",
    inputSchema:{id:z.string(),add:z.array(z.string()).default([]),remove:z.array(z.string()).default([])}
  },async({id,add,remove}:any)=>{try{return jsonResult(await service.patchTaskTags(id,add,remove));}catch(e){return errorResult(e);}});
  registerTool("of_agent_transition", {
    description:"AFK workflow: start adds 进行中; done or needs_human removes 进行中 and adds HITL. Keeps AFK and never completes the task. Use a stable unique runId. reason required for HITL; uses local OmniFocus; ownership stays local and notes contain concise handoff only.",
    inputSchema:{id:z.string(),event:z.enum(["start","done","needs_human"]),runId:z.string().min(1).max(160),reason:z.string().max(12000).optional()}
  },async(args:any)=>{try{return jsonResult(await localWorkflow.transition(args));}catch(e){return errorResult(e);}});

  registerTool(
    "of_add_task",
    {
      title: "Add an OmniFocus task",
      description:
        "Create a task. Without a project it goes to the inbox. Dates accept ISO 8601 strings.",
      inputSchema: {
        name: z.string(),
        note: z.string().optional(),
        project: z.string().optional().describe("Project name or id; omit for inbox"),
        tag: z.string().optional().describe("Primary tag name or id"),
        due: z.string().optional().describe("Due date (ISO 8601)"),
        defer: z.string().optional().describe("Defer/start date (ISO 8601)"),
        planned: z.string().optional(),
        repetition: repetitionSchema.nullable().optional(),
        flagged: z.boolean().optional(),
        estimatedMinutes: z.number().optional(),
      },
    },
    async (args:any) => {
      try {
        const { id } = await service.addTask({
          name: args.name,
          note: args.note,
          projectNameOrId: args.project,
          tagNameOrId: args.tag,
          due: parseDate(args.due),
          defer: parseDate(args.defer),
          planned: parseDate(args.planned),
          repetition: args.repetition,
          flagged: args.flagged,
          estimatedMinutes: args.estimatedMinutes,
        });
        return jsonResult({ ok: true, id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool(
    "of_complete_task",
    {
      title: "Complete an OmniFocus task",
      description: "Mark a task complete (optionally at a specific ISO 8601 time).",
      inputSchema: { id: z.string(), when: z.string().optional() },
    },
    async ({ id, when }:any) => {
      try {
        await service.completeTask(id, parseDate(when) ?? new Date());
        return jsonResult({ ok: true, id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool(
    "of_edit_task",
    {
      title: "Edit an OmniFocus task",
      description:
        "Edit fields of a task. Use clearDue/clearDefer to remove a date. Only provided fields change.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        note: z.string().optional(),
        flagged: z.boolean().optional(),
        due: z.string().optional().describe("New due date (ISO 8601)"),
        defer: z.string().optional().describe("New defer date (ISO 8601)"),
        planned: z.string().optional(),
        clearPlanned: z.boolean().optional(),
        repetition: repetitionSchema.nullable().optional().describe("Set repeating rule; null clears repetition"),
        clearDue: z.boolean().optional(),
        clearDefer: z.boolean().optional(),
        estimatedMinutes: z.number().optional(),
      },
    },
    async (args:any) => {
      try {
        if ((args.planned && args.clearPlanned) || (args.due && args.clearDue) || (args.defer && args.clearDefer)) throw new Error("Cannot set and clear the same date");
        await service.editTask(args.id, {
          name: args.name,
          note: args.note,
          flagged: args.flagged,
          due: args.clearDue ? null : parseDate(args.due),
          defer: args.clearDefer ? null : parseDate(args.defer),
          planned: args.clearPlanned ? null : parseDate(args.planned),
          repetition: args.repetition,
          estimatedMinutes: args.estimatedMinutes,
        });
        return jsonResult({ ok: true, id: args.id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool("of_move_task",{
    description:"Move an Action and its subtree under a project or action group ID. parentId null moves to Inbox. Appends to destination order. Projects cannot be moved with this tool.",
    inputSchema:{id:z.string(),parentId:z.string().nullable()}
  },async({id,parentId}:any)=>{try{return jsonResult(summarizeTask(await service.moveTask(id,parentId)));}catch(e){return errorResult(e);}});
  registerTool("of_set_task_status",{
    description:"Drop the current occurrence by default. Set allOccurrences=true explicitly to drop the entire repeating series. Reactivation does not merge generated instances.",
    inputSchema:{id:z.string(),status:z.enum(["active","dropped"]),allOccurrences:z.boolean().default(false)}
  },async({id,status,allOccurrences}:any)=>{try{return jsonResult(summarizeTask(await service.setTaskStatus(id,status,allOccurrences)));}catch(e){return errorResult(e);}});
  registerTool("of_set_group_order",{
    description:"Set an action group or project's child execution order and optional complete-when-children-complete setting. Does not reorder existing children or complete them immediately.",
    inputSchema:{id:z.string(),order:z.enum(["parallel","sequential"]),completedByChildren:z.boolean().optional()}
  },async({id,order,completedByChildren}:any)=>{try{return jsonResult(summarizeTask(await service.setGroupOrder(id,order,completedByChildren)));}catch(e){return errorResult(e);}});

  registerTool(
    "of_delete_task",
    {
      title: "Delete an OmniFocus task",
      description: "Delete a leaf task or empty project. Refuses any remaining children, including completed/dropped items. Use dryRun to inspect blockers without writing.",
      inputSchema: { id: z.string(), dryRun: z.boolean().default(false) },
    },
    async ({ id, dryRun }:any) => {
      try {
        return jsonResult({ ok: true, ...await service.deleteTask(id, dryRun) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool(
    "of_set_review",
    {
      title: "Set project review schedule",
      description:
        "Set review fields on a project: next review date, last review date, review interval. Interval strings look like \"@1w\", \"@2w\", \"~1m\" (@ = anchored from schedule, ~ = floating from last review). Clear a date by passing an empty string.",
      inputSchema: {
        id: z.string().describe("Project id"),
        nextReview: z.string().optional().describe("Next review date (ISO 8601); empty string clears"),
        lastReview: z.string().optional().describe("Last review date (ISO 8601); empty string clears"),
        reviewInterval: z.string().optional().describe("e.g. @1w, @2w, ~1m; empty string clears"),
      },
    },
    async (args:any) => {
      try {
        const fields: ProjectReviewFields = {};
        if (args.nextReview !== undefined)
          fields.nextReview = args.nextReview === "" ? null : parseDate(args.nextReview)!;
        if (args.lastReview !== undefined)
          fields.lastReview = args.lastReview === "" ? null : parseDate(args.lastReview)!;
        if (args.reviewInterval !== undefined)
          fields.reviewInterval = args.reviewInterval === "" ? null : args.reviewInterval;
        await service.setProjectReview(args.id, fields);
        return jsonResult({ ok: true, id: args.id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  registerTool(
    "of_review_batch",
    {
      title: "Batch set project review schedules",
      description:
        "Set review fields on many projects. Local mode prevalidates all entries but is not an atomic transaction; remote mode uses one transaction. Each entry: id plus any of nextReview/lastReview (ISO strings, empty string clears) / reviewInterval.",
      inputSchema: {
        updates: z
          .array(
            z.object({
              id: z.string(),
              nextReview: z.string().optional(),
              lastReview: z.string().optional(),
              reviewInterval: z.string().optional(),
            }),
          )
          .describe("Project review updates"),
      },
    },
    async (args:any) => {
      try {
        const updates = args.updates.map((u:any) => ({
          id: u.id,
          nextReview: u.nextReview === undefined ? undefined : u.nextReview === "" ? null : parseDate(u.nextReview),
          lastReview: u.lastReview === undefined ? undefined : u.lastReview === "" ? null : parseDate(u.lastReview),
          reviewInterval: u.reviewInterval,
        }));
        const count = await service.batchProjectReview(updates);
        return jsonResult({ ok: true, count });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; all logging must go to stderr.
  console.error(
    `omnifocus-sync-mcp running (local default; remote explicit)`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
