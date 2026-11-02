# Agent Session Map

Codex 用 session_id 隔离，绑定键为 Action ID + runId，存储事项摘要、OF URL、请求事件、确认事件及时间。工具前保存 pending；工具后只有匹配的 ok:true 才确认。Stop 不写 OF：未完成交接或未说明绑定结果时请求一次继续，第二次仍未解决会保留并提示，防止无限循环。无匹配与诊断要显式记原因；不能用 resolve 抹掉 active。

旧 Stop 重试钩子继续负责已提交失败请求。没有指定 AFK 动作时不创建任务或认领后台任务。旧的进行中且没有 runId 的动作不会被自动接管。

测试：node scripts/agent-session.test.mjs。实际宿主生效依赖 hooks.json 被加载；配置修改未改信任批准字段。Hermes 现有 agent:end 仍仅重试；这次会话检查接在 Codex 的 Pre/PostToolUse 与 Stop，未宣称 Hermes 具有相同宿主事件支持。


## 本机工作流后端（2026-11-02）

`of_get_task`、`of_list_tasks`、`of_sync`、`of_agent_transition` 通过本机 macOS OmniFocus 自动化执行，不请求 Omni Sync Server。保持现有 MCP 工具名和 Session/Action/runId 映射。Codex 与本机 Hermes 的 Hook 仍使用同一个 `scripts/run.sh`。其他同步服务器工具保留原实现。

需要 Mac 登录、本机 OmniFocus 可用且授予自动化权限。正在运行的 MCP 进程需要重新连接才能载入新版本；Hook 每次启动的新进程自动使用新版本。远程 Linux Hermes 不能直接执行本机 osascript，需要连接运行在这台 Mac 上的 MCP。

start 保留备注，添加进行中；done/needs_human 移除进行中、添加 HITL，不勾选完成。交接仅写简短人类可读结果。归属与重试意图存储在 ~/.local/state/omnifocus-agent/local-ownership，拒绝不同 runId 接管。中断后必须用相同 id/event/runId/reason 恢复，不可修改交接理由后盲重试。进程被强制终止后如遗留 local-transition.lock，应先确认无运行中的转换，再移除空锁目录。禁止自动回退服务器写入。

验证：构建成功、58 项测试通过（本地写入逻辑使用隔离模拟），真实 MCP 本机只读调用约 1.3–1.7 秒；未修改真实动作作测试。


查询默认返回未完成动作摘要，每页50条，最大200条，以 offset/nextOffset 翻页。完整备注按需用 of_get_task。已完成查询使用 doneDays:7 或 done:"--done7"（14等正整数同理），仅返回最近N×24小时完成的动作。filter:all 不再绕过完成过滤；includeCompleted:true 必须同时指定完成天数。生命周期统一使用 👨 HITL，不再添加 PHV 或等待；已有等待保留。

最终约定：不新增标签、不迁移任务；AFK 是独立执行，单独 HITL 是人在场协同，AFK+HITL 是交回人类。透视名称由用户维护。人工返工需先移除 HITL，再明确授权新 runId；Agent 不得自行移除 HITL 来绕过领取限制。Codex 执行守卫允许只读 OF 检查及生命周期调用以便诊断，其他工具在活动任务失效时拒绝。该守卫无法撤销已经开始的外部操作。
