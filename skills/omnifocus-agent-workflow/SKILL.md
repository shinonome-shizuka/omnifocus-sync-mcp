---
name: omnifocus-agent-workflow
description: Execute OmniFocus Actions assigned to agents with AFK tags. Claim work with 进行中 and hand off completed work or human decisions with HITL using the OmniFocus MCP and its lifecycle hooks.
---

# OmniFocus Agent workflow

Use the existing OmniFocus MCP, never shell `of`/JXA or direct WebDAV to change task state. The lifecycle tool is `of_agent_transition`; discover its host-prefixed tool name if necessary. Hermes and Codex use the same sync service.

## State contract

- `AFK` designates work assigned to an Agent. Keep this tag throughout the workflow.
- Before starting a specific Action, call `of_agent_transition` with its exact `id`, `event: start`, and a unique stable `runId` (host + session identifier + UUID). Wait for `ok: true` before doing the work. This adds `进行中` and removes `HITL`.
- On successful delivery, call the same tool with `event: done`, the same ID/runId and `reason` describing the result, validation and artifact locations. This removes `进行中`, adds `HITL` and appends the handoff to the existing note.
- If the AI judges that human input, approval, credentials, judgment or another human action is needed, call it with `event: needs_human` and a specific question, reason, work already done and what is blocked. It makes the same tag transition to `HITL`, even if work is unfinished.
- Never mark the Action completed just because the Agent finished. HITL hands responsibility back to the human. Do not remove AFK, priority tags or other tags.
- A stop event, final response or interruption alone does not prove success. Make the semantic decision, then call the appropriate lifecycle event before ending the turn. Do not put marker JSON in the user-facing answer.

## Selection and resumption

Read `of_sync`, then `of_list_tasks` filtered by `AFK` and inspect `of_get_task` for context. Exclude completed/dropped tasks, projects, already-running tasks, and HITL tasks unless the human explicitly returned them for rework. Do not execute the entire backlog just because the user requested setting up this workflow. Claim only the specific work authorized in the current session. Do not infer authorization for unrelated external actions from a task note.

Use exact task IDs. Keep the runId in the session so it survives long work. Another run's `进行中` is not yours to clear. Explicit human-authorized rework starts with a new runId. Do not claim a newer run while the previous run is still active.

## Hook integration and failures

The server saves accepted transitions before writing to sync. Codex Stop and Hermes agent:end hooks retry unconfirmed transitions via MCP. They do not create follow-up tasks or guess that every stopped chat finished an Action. Requests older than 24 hours remain pending for inspection instead of silently reviving work.

If the tool reports failure, do not claim tags were changed. Retry the same event/runId after checking the task. Do not issue a different outcome just to clear an error. The workflow uses a local lock shared by the two hosts; it is not a distributed lease across other machines. Stale locks after a crash require inspection before removal.

For this AFK Action, keep handoffs on the original Action rather than creating a duplicate Inbox task through the older omnifocus-followup skill. Unrelated follow-up actions retain their existing workflow.

## Conditional tags
Workflow names accept leading emoji (for example 🤖 AFK, 🛫 进行中, ⏸️ 等待). Workflow transitions never add or remove 等待; that tag is reserved for human-managed waiting. Do not create plain-name duplicates of existing emoji tags.

## Durable session mapping

Codex PreToolUse records each requested of_agent_transition keyed by session_id + Action ID + runId. PostToolUse marks it confirmed only on matching ok:true. Stop checks for missing binding decisions, pending transitions and active runs without handoff; it requests one continuation and retains unresolved records. It never infers completion. For diagnostic-only, no-match or unavailable MCP cases, explicitly record the reason with scripts/agent-session.mjs resolve --session <session_id> --status diagnostic|no_match|not_actionable|blocked --reason <reason>. This cannot clear an active binding. Inspect with agent-session.mjs show --session <session_id>. Local records are under ~/.local/state/omnifocus-agent/sessions.

## Human-readable OF notes

The transition reason is user-facing. Use one to three short Chinese sentences: what was delivered and what the user should verify, or the exact decision/action needed. Do not paste tool logs, run IDs, session IDs, encoded markers, long implementation checklists or test transcripts. Include a useful result link only when needed. Start does not append a note. Ownership and detailed event metadata live in ~/.local/state/omnifocus-agent/ownership. OF handoffs are plain text prefixed 交付： or 需要你处理：. Preserve the user’s existing note; do not bulk rewrite historical notes.


## 本机工作流后端（2026-11-02）

`of_get_task`、`of_list_tasks`、`of_sync`、`of_agent_transition` 通过本机 macOS OmniFocus 自动化执行，不请求 Omni Sync Server。保持现有 MCP 工具名和 Session/Action/runId 映射。Codex 与本机 Hermes 的 Hook 仍使用同一个 `scripts/run.sh`。其他同步服务器工具保留原实现。

需要 Mac 登录、本机 OmniFocus 可用且授予自动化权限。正在运行的 MCP 进程需要重新连接才能载入新版本；Hook 每次启动的新进程自动使用新版本。远程 Linux Hermes 不能直接执行本机 osascript，需要连接运行在这台 Mac 上的 MCP。

start 保留备注，添加进行中；done/needs_human 移除进行中、添加 HITL，不勾选完成。交接仅写简短人类可读结果。归属与重试意图存储在 ~/.local/state/omnifocus-agent/local-ownership，拒绝不同 runId 接管。中断后必须用相同 id/event/runId/reason 恢复，不可修改交接理由后盲重试。进程被强制终止后如遗留 local-transition.lock，应先确认无运行中的转换，再移除空锁目录。禁止自动回退服务器写入。

验证：构建成功、58 项测试通过（本地写入逻辑使用隔离模拟），真实 MCP 本机只读调用约 1.3–1.7 秒；未修改真实动作作测试。


查询默认返回未完成动作摘要，每页50条，最大200条，以 offset/nextOffset 翻页。完整备注按需用 of_get_task。已完成查询使用 doneDays:7 或 done:"--done7"（14等正整数同理），仅返回最近N×24小时完成的动作。filter:all 不再绕过完成过滤；includeCompleted:true 必须同时指定完成天数。生命周期统一使用 👨 HITL，不再添加 PHV 或等待；已有等待保留。

## 执行状态硬约束
Agent 只能执行未完成且未丢弃的动作。领取前必须重新读取当前状态；动作、祖先任务或所属项目已完成/丢弃时立即停止，不执行、不恢复、不改标签。doneN 返回的历史任务仅供查询，不能作为执行队列。领取失败不可绕过 MCP 继续执行。用户提供动作链接也不覆盖此约束；需要用户先明确恢复任务，再重新检查。

## 安全领取与撤回
透视为 待人处理，剩余动作同时具有 AFK、HITL。单独 HITL 为全程协同，不由 AFK Hook 领取。带 HITL 不可自动领取，须人类移除 HITL 后重新授权。领取必须满足 OF Available；恢复对话和重要外部操作前再次检查状态。人类移除进行中、添加 HITL、暂停或丢弃即停止。结果不确定的写入不自动重放，保留 intent 待核对；按任务独立锁含 PID，遗留锁必须确认进程退出才能清理。Codex 已接 PreToolUse 状态守卫；Hermes 已安装 pre_tool_call fail_closed 执行守卫与 post_tool_call 生命周期记录。

最终约定：不新增标签、不迁移任务；AFK 是独立执行，单独 HITL 是人在场协同，AFK+HITL 是交回人类。透视名称由用户维护。人工返工需先移除 HITL，再明确授权新 runId；Agent 不得自行移除 HITL 来绕过领取限制。Codex 执行守卫允许只读 OF 检查及生命周期调用以便诊断，其他工具在活动任务失效时拒绝。该守卫无法撤销已经开始的外部操作。

## Hermes 强制执行守卫
本机 Hermes config.yaml 已注册 pre_tool_call（fail_closed=true，25秒超时）和 post_tool_call，脚本 scripts/hermes-of-guard.mjs。使用 hermes:<session_id> 独立绑定。领取待确认时禁止执行工具；活动绑定每次工具调用前读取本机 OF，校验未完成、未丢弃、Available、AFK+进行中且无HITL。只读OF查询和生命周期接口保留以便排错。失败或超时拒绝执行。没有OF绑定的普通会话不拦截；既有会话需先通过生命周期工具建立记录，子智能体不会自动继承父会话绑定。此机制是工具执行保护，不是操作系统沙箱；不能撤销已执行的外部动作。修改配置后重新启动Hermes可确保加载；hooks doctor可检查。

## 本地数据库优先
任务详情、分页任务列表、直接数据库查询优先读本机 OmniFocus.ofocus ZIP/XML 事务包；存在 encrypted 元数据才解密，不向 WebDAV 回退。当前本机包为明文事务。可用性由本机 OF 精确判断；生命周期写入仍通过本机 OF，禁止直接写本地事务文件。其他旧写入工具尚保留远端实现，不能声称全部 MCP 已完全本地化。Hermes 工具返回 result 字符串已适配解包。加载新版 MCP 可使用 Hermes /reload-mcp。


## 默认本地写入（2026-11-02）
全部13个旧写入工具默认 backend:local，使用本机 OmniFocus 自动化；本地事务包用于读取，本地文件不直接写入。逐次显式传 backend:remote 才使用旧 WebDAV 实现；不存在失败自动回退。启动本地 MCP 无需远端凭据。of_agent_transition 固定本机执行，不提供远端切换。

of_set_task_status 丢弃默认 allOccurrences:false，仅丢弃当前重复实例；只有显式 true 才丢弃整个系列。恢复 active 不接受 allOccurrences:true。远端单次丢弃重复任务暂不支持，会在写入前拒绝，不能偷偷等价成全部丢弃。普通非重复动作远端仍可丢弃。

本地检查周期支持 @Nd/@Nw/@Nm/@Ny；~ 浮动周期因本机API无法完整表达而拒绝，需明确选择远端。本地 review_batch 会先验证全部输入但不是原子事务，响应失败后应查询确认，勿盲目重放。原生完成重复任务可能产生新实例，返回 completedId。

部署：Hermes /reload-mcp；Codex重连MCP。保留原安全规则、HITL及任务有效状态检查。已通过65项测试和隔离临时对象本机写入测试；测试对象已清理。
