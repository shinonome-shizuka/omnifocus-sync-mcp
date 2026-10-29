---
name: omnifocus-agent-workflow
description: Execute OmniFocus Actions assigned to agents with AFK tags. Claim work with 进行中 and hand off completed work or human decisions with PHV using the OmniFocus MCP and its lifecycle hooks.
---

# OmniFocus Agent workflow

Use the existing OmniFocus MCP, never shell `of`/JXA or direct WebDAV to change task state. The lifecycle tool is `of_agent_transition`; discover its host-prefixed tool name if necessary. Hermes and Codex use the same sync service.

## State contract

- `AFK` designates work assigned to an Agent. Keep this tag throughout the workflow.
- Before starting a specific Action, call `of_agent_transition` with its exact `id`, `event: start`, and a unique stable `runId` (host + session identifier + UUID). Wait for `ok: true` before doing the work. This adds `进行中` and removes `PHV`.
- On successful delivery, call the same tool with `event: done`, the same ID/runId and `reason` describing the result, validation and artifact locations. This removes `进行中`, adds `PHV` and appends the handoff to the existing note.
- If the AI judges that human input, approval, credentials, judgment or another human action is needed, call it with `event: needs_human` and a specific question, reason, work already done and what is blocked. It makes the same tag transition to `PHV`, even if work is unfinished.
- Never mark the Action completed just because the Agent finished. PHV hands responsibility back to the human. Do not remove AFK, priority tags or other tags.
- A stop event, final response or interruption alone does not prove success. Make the semantic decision, then call the appropriate lifecycle event before ending the turn. Do not put marker JSON in the user-facing answer.

## Selection and resumption

Read `of_sync`, then `of_list_tasks` filtered by `AFK` and inspect `of_get_task` for context. Exclude completed/dropped tasks, projects, already-running tasks, and PHV tasks unless the human explicitly returned them for rework. Do not execute the entire backlog just because the user requested setting up this workflow. Claim only the specific work authorized in the current session. Do not infer authorization for unrelated external actions from a task note.

Use exact task IDs. Keep the runId in the session so it survives long work. Another run's `进行中` is not yours to clear. Explicit human-authorized rework starts with a new runId. Do not claim a newer run while the previous run is still active.

## Hook integration and failures

The server saves accepted transitions before writing to sync. Codex Stop and Hermes agent:end hooks retry unconfirmed transitions via MCP. They do not create follow-up tasks or guess that every stopped chat finished an Action. Requests older than 24 hours remain pending for inspection instead of silently reviving work.

If the tool reports failure, do not claim tags were changed. Retry the same event/runId after checking the task. Do not issue a different outcome just to clear an error. The workflow uses a local lock shared by the two hosts; it is not a distributed lease across other machines. Stale locks after a crash require inspection before removal.

For this AFK Action, keep handoffs on the original Action rather than creating a duplicate Inbox task through the older omnifocus-followup skill. Unrelated follow-up actions retain their existing workflow.
