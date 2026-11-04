# 统一 MCP 入口与读写边界

2026-11-04。本次统一的是工具服务，不是已经完成单仓库迁移。

## 实际结构

- `omnifocus-cli/src/commands/mcp.ts`：`of mcp` 只启动 fork，不再注册旧工具。原 `src/mcp/server.ts` 已删除。
- `src/tools.ts`：唯一普通 MCP 工具注册表、参数、读写路由。
- `runtime/index.js` 与 `src/index.ts`：分别接生产 legacy / staged v2 生命周期，不重复维护普通工具。没有自动切换生产归属协议。
- `src/nativeDatabase.ts`：默认只读 OmniFocus 已提交的 SQLite/WAL 快照，映射到共用数据模型。不会写 SQLite、checkpoint 或启动应用；缺失/不支持的 schema 报错，不回退陈旧事务数据。
- `src/databaseReads.ts`、`src/readTools.ts`：统一查询和导出，显式 `backend: remote` 读取 WebDAV 事务库。附件元数据走同一数据快照，二进制内容由存储层读取。
- `src/formatData.ts`：纯数据格式化，输出 JSON、CSV、Markdown；不访问磁盘、网络或 OmniFocus。
- `src/nativeBridge.ts`：向 of-cli 的具名操作接口发送 JSON；无脚本字符串、无 shell 拼接、无失败回退。
- CLI 的 `src/lib/native-write*.ts`：原生脚本及执行；只接受具名操作。旧 CLI 的普通命令仍保留，独立 CLI 读取命令尚未整体迁移。
- `src/workflowWrites.ts`：AFK / 监控统一经 CLI 写回，随后有界等待数据库核验；未观察到结果则保留不确定状态，不盲重放。

两项目需要分别构建，数据服务需要 Node >=22.16.0。相邻 checkout 自动定位；其他部署设 `OMNIFOCUS_MCP_LAUNCHER`（fork 的 `scripts/run.sh`）和 `OMNIFOCUS_CLI_PATH`（CLI 的 `dist/cli.js`）。没有复制用户凭据或修改宿主连接配置；常驻 MCP 必须重新连接才加载新版。

`OMNIFOCUS_NATIVE_DATABASE` 可以指定 SQLite 路径。显式设置 `OMNIFOCUS_LOCAL_READ_SOURCE=transactions` 或 `OMNIFOCUS_LOCAL_DATABASE` 时使用事务数据；同时设置时 `OMNIFOCUS_NATIVE_DATABASE` 优先。远端始终读取 WebDAV 事务。每个读取请求只用一个快照，包含 `snapshot.source/observedAt/scope`，不将持久化快照宣称为应用内存的实时状态。

## 读写合同

默认读取：本地数据层。默认写入：`writeMode: app`，由 of-cli 操作 OmniFocus。此时 `backend: remote` 被拒绝，避免误写本机。

高危事务写入仅限普通写工具逐次显式指定 `writeMode: direct-database`，同时 `backend: local | remote` 决定存储；两者复用已有事务系统。此模式可能与应用内存状态冲突，不会刷新界面，不等于原生写入。`of_update_project` 当前只支持 app 模式。AFK/监控不提供直写绕过模式。

CLI 原生写入后调用 Omni Automation 全局 `Database.save()` 提交应用内未保存的数据，然后 MCP 独立读回数据层。删除预览 `dryRun` 不提交。save 可能提交其他未保存改动，并在启用同步时发起同步请求。它不是 Cocoa / AppleScript 的 `defaultDocument.save()`，也不是外部数据库的 reload 接口。文稿 save 触发过覆盖冲突，已移除。

普通写入返回 `applicationResult` 和实际 `observedState`，通过 `writeStatus` 区分：

- `verified`：支持的后置条件已在数据快照中匹配，`databaseVisibility: verified`。
- `pending-database`：应用已应答，但快照仍不匹配；不得当作成功落盘或盲重试。
- `acknowledged-unverified`：应用已应答，但该操作尚无完整核验规则，或读取失败；后者含 `readError`。

生命周期须读回匹配才确认；超时保留 intent 等待核对。所有普通响应的 `syncStatus: not-verified` 保留，因为本地保存不等于 WebDAV 已完成同步。`of_sync` 只刷新数据层快照，并不执行应用同步。

## 旧 CLI MCP 迁移表

| 旧工具 | 统一入口 |
| --- | --- |
| list_tasks / search_tasks / list_inbox | of_list_tasks（search/filter 分页） |
| get_task / get_project | of_get_task（使用 ID） |
| create_task / update_task / delete_task | of_add_task / of_edit_task / of_delete_task；位置、标签、完成状态使用对应专用工具 |
| list_projects / create_project / update_project / delete_project | of_list_projects / of_create_project / of_update_project / of_delete_task（非空删除拒绝） |
| get_task_stats / get_project_stats / get_tag_stats / get_inbox_count | of_stats（统一计数结构，不是旧返回结构的兼容别名） |
| list_tags / list_folders | of_list_tags / of_list_folders |
| get_tag / get_folder | of_get_object（kind + ID） |
| create_tag / update_tag / delete_tag | of_manage_tag（现有名称、层级、删除；旧 status 过滤/设置尚未全部迁移） |
| search_tools | MCP tools/list，只有一套注册表 |
| list_perspectives / get_perspective_tasks | 未迁移；不使用自动化伪装数据查询，不假造自定义透视结果 |
| 数据导出 | of_export_tasks：分页读取后交给 formatData，默认仅未完成动作，已完成需 doneDays |

旧名称不再并行注册。复杂 create/update 组合拆成明确操作，不保证多步原子性。CLI 单独调用及高级透视/筛选的完整迁移仍需继续，不能据此宣称所有旧功能无损迁移。

## 验证及保存冲突

最初只读事务包时，删除已在应用内完成但快照延迟消失。改成 SQLite 后，未提交的应用内修改仍有延迟，因此只换读取来源不足以解决问题。

为探测落盘加入的文稿 save 调用触发“外部更改将丢失”警告。已取消该保存并撤回代码，保留磁盘备份 `/private/tmp/of-conflict-backup-jp806t_n`。没有选择覆盖或重启。该备份是磁盘文件副本，不代表已捕获应用内存中的未落盘内容。

随后用户明确批准官方 Database.save() 的真实库验证。最终默认入口 `of mcp` 的临时动作创建、修改、删除均立即返回 `verified`，备注匹配、删除后搜索总数为 0；界面无冲突弹窗。未通过外部直写测试证明 save 能重载数据库，故不改变高危直写的默认禁用边界。

同次验证又只读检查了 WebDAV：对应创建、修改、删除的 3 个事务全部存在，解密后的内容与本地逐一一致。这个结果只覆盖本次临时动作，不将未来普通写入的 `syncStatus` 自动升级为已同步。证据日志：`/tmp/of-native-save-verification.jsonl`、`/tmp/of-native-save-sync-verification.json`。

最终完整验证：CLI build/typecheck + 64 测试通过，fork 生产 build + 131 测试通过，staged v2 + 154 测试通过（两套 fork 测试有重叠，不合计为独立用例）。最终只读 MCP 检查有 31 个 `of_` 工具、无旧的无前缀工具，临时动作残留为 0。现有宿主常驻 MCP 未自动重启，需重连后加载新构建。

官方接口语义：[OmniFocus Database.save()](https://omni-automation.com/omnifocus/database.html)。
