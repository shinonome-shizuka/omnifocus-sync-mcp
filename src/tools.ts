import {sharedService,withBackend} from './backend.js';
import {registerAttachmentTools} from './attachments.js';
import {registerMonitorTools} from './monitor/tools.js';
import {localWriteTools} from './localWrites.js';
import {writeAndRead} from './writeResult.js';
import {extraReadTools,registerReadTools} from './readTools.js';
import {readLocalDatabase,withReadSnapshot} from './localDatabase.js';
import * as localWorkflow from './localWorkflow.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryTasks, summarizeTask, TaskFilter } from "./ofocus/query.js";
import { ProjectReviewFields } from "./ofocus/writer.js";

const repetitionSchema = z.object({
  rule:z.string().min(1).max(2048).describe("Single RRULE, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR"),
  method:z.enum(["fixed","start-after-completion","due-after-completion"]).default("fixed"),
  anchor:z.enum(["due","defer","planned"]).optional(),
  catchUpAutomatically:z.boolean().default(false),
}).strict();

export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(err: unknown) {
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

export function registerTools(server:McpServer, registerLifecycle:(register:any)=>void): void {
  const service=sharedService;
  const writeTools=new Set([...localWriteTools,'of_update_project']);



  const registerTool=(name:string,definition:any,handler:any)=>{
    const dataTool=extraReadTools.has(name)||writeTools.has(name)||['of_sync','of_list_tasks','of_get_task','of_list_projects','of_list_tags','of_list_folders','of_read_attachment'].includes(name);
    const writes=writeTools.has(name)||['of_agent_transition','of_agent_transfer','of_monitor_configure','of_monitor_transition','of_monitor_reconcile'].includes(name);
    return (server.registerTool.bind(server) as any)(name,{...definition,
      description:definition.description+(dataTool?(writeTools.has(name)?' Default write uses of-cli, commits with OmniFocus Database.save(), then reports persisted readback status. HIGH RISK: writeMode=direct-database explicitly writes transaction files without verified app visibility.':' Reads the local persisted SQLite snapshot by default, or sync transactions for the remote/explicit transaction backend. Snapshot source and scope are returned.') :''),
      inputSchema:{...definition.inputSchema,...(dataTool?{backend:z.enum(['local','remote']).default('local')}:{ }),...(writeTools.has(name)?{writeMode:z.enum(['app','direct-database']).default('app').describe('HIGH RISK: direct-database bypasses OmniFocus and may not refresh its interface')}:{})}
    },async(args:any,extra:any)=>{try{
      if(writeTools.has(name)&&args.writeMode==='app'){
        if(args.backend!=='local')throw Error('Remote writes require explicit writeMode=direct-database (HIGH RISK)');
        if(/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY??''))throw Error('Server is read-only');
        return jsonResult(await writeAndRead(name,args));
      }
      const result:any=await withBackend(dataTool?args.backend:'local',()=>writes?handler(args,extra):withReadSnapshot(()=>handler(args,extra)),writes);
      if(writeTools.has(name)&&args.writeMode==='direct-database'&&!result.isError)return {...result,content:result.content.map((c:any)=>c.type==='text'?{...c,text:JSON.stringify({...JSON.parse(c.text),writeMode:'direct-database',applicationVisibility:'not-verified',syncStatus:'not-verified'})}:c)};
      return result;
    }catch(e){return errorResult(e);}});
  };

  registerTool(
    "of_sync",
    {
      title: "Sync OmniFocus",
      description:
        "Refresh the selected data snapshot and return counts. Does not request or confirm WebDAV synchronization. No AppleScript or app launch.",
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
        "Return a compact page of unfinished tasks (50 default, 200 max). Completed tasks ONLY with doneDays=N or done=--doneN; this returns only tasks completed in the last N rolling days. Use of_get_task for notes and details; follow nextOffset for more. Availability is computed from stored task, project, tag and ordering fields.",
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
      description: "Read task fields and availability from the selected persisted database snapshot. See statusSource and availabilityVerified.",
      inputSchema: { id: z.string(), attachmentOffset:z.number().int().min(0).default(0), attachmentLimit:z.number().int().min(1).max(100).default(20) },
    },
    async ({ id,attachmentOffset,attachmentLimit }:any) => {
      try {
        return jsonResult(await localWorkflow.getTask(id,attachmentOffset,attachmentLimit));
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
  registerAttachmentTools(registerTool,errorResult);
  registerMonitorTools(registerTool,jsonResult,errorResult);
  registerLifecycle(registerTool);
  registerReadTools(registerTool,jsonResult);
  registerTool('of_update_project',{description:'Update project fields through of-cli. Direct database mode is unsupported for this operation.',inputSchema:{id:z.string(),name:z.string().optional(),note:z.string().optional(),folder:z.string().optional(),sequential:z.boolean().optional(),tags:z.array(z.string()).optional(),status:z.enum(['active','on hold','dropped']).optional(),due:z.string().optional(),defer:z.string().optional()}},async()=>{throw Error('of_update_project requires writeMode=app');});

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
        "Set review fields on many projects. App mode uses of-cli; direct-database mode prevalidates all entries and publishes one transaction. Each entry: id plus any of nextReview/lastReview (ISO strings, empty string clears) / reviewInterval.",
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

}
