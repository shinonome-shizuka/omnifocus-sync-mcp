# OmniFocus 原生状态优先（2026-11-03）

> 历史记录：下述通过自动化查询应用内存的实现已于 2026-11-04 被替换。当前默认只读原生 SQLite/WAL 持久化快照，返回 `statusSource: omnifocus-sqlite`；原生写入经 of-cli 的 Database.save() 提交后独立读回验证。具体边界见 [统一入口](unified-entry.md)，不能把这里的旧部署描述当成当前行为。

修复：旧实现只接受 Task.Status.Available，导致 OF 的 Next 被误判不可领取。按官方 Tasks for Processing 定义，Available、Next、DueSoon、Overdue 均属于可处理状态；Blocked、Completed、Dropped 和未知状态不放行。祖先完成/丢弃检查保留。

任务详情和列表返回 ofStatus（OF 原生枚举名称）、available、statusSource: omnifocus。既有 status 字段保留 active/completed/dropped 的兼容含义，不能用它代替 ofStatus。AFK/HITL、归属、授权检查是独立的 Agent 执行条件。

详情读取本机 OF 当前值覆盖数据库摘要；数据库用于补充扩展字段。列表在一次原生调用内筛选、分页，只返回当前页，不逐项 IPC。OF 不可读时报告失败，不拿缓存状态冒充实时状态。sync 与直接数据库工具仍代表数据库快照。

隔离构建及105项测试通过，包括所有状态、领取校验、祖先失效和5000条任务分页。真实只读验证 nlAdd：Next、available=true，且出现在 available 查询；新建只读 MCP 进程协议验证通过。未重试 nlAdd 写入。

部署仅从隔离构建提取 dist/localWorkflow.js 的 helpers/getTask/listScript/listTasks 四项声明，旧 transition 字节内容保持不变。src/ledger/runtime.ts 的同类判断同时修正，但 v2 账本未上线；不得直接全量 build 到生产 dist。部署前备份 /tmp/localWorkflow-before-status.js，源文件备份 /tmp/localWorkflow-before-status.ts。

Hermes 使用 /reload-mcp；Codex 重新连接 MCP。Hook 新进程直接读取更新后模块。

参考：https://omni-automation.com/omnifocus/task.html

## 项目根任务误判修复（2026-11-03）

原生 Project.Status 与 project.task.taskStatus 独立。详情现将 projectStatus 规范为 active/on hold/done/dropped/unknown，并提供 projectAllowsExecution、statusScope、statusInterpretation。根任务 Blocked 不代表项目暂停；目标子动作的原生 available 与项目生命周期分别检查。真正暂停、完成、丢弃或未知项目仍不放行。三份 Workflow 与 Codex context hook 同步说明，自动审批器本身不在本仓库，未修改其实现或绕过拒绝。

105项测试通过；只读验证 KOC 为 Next、项目为 active，同时根任务 Blocked。未重放KOC领取、未修改标签。部署仅替换生产 helpers 声明，保留旧生命周期及附件实现。MCP已有进程需重连才能加载新字段。
