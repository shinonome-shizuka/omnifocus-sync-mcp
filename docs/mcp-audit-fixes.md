# MCP 审计修复 · 2026-11-03

> 历史审计记录，以下部署与测试结果仅描述 2026-11-03 当次验证。2026-11-04 默认读取已改为 SQLite/WAL；以 [统一入口](unified-entry.md) 和 [当前验证](afk-hooks-verification.md) 为准，不据此判断常驻进程已升级。

运行标识：2026-11-03-audit-2；MCP server version 0.1.0-audit.2。

已部署：
- Codex 与 Hermes 共享归属确认策略；start_pending/handoff_pending/unconfirmed 不放行业务工具，发现及只读恢复工具可用。
- 同一已确认终态重试必须匹配原理由；匹配则只返回结果，不重复写备注、不恢复人工移除的标签。理由变化拒绝。
- due_soon 使用 effectiveDueDate，返回直接及继承截止时间。真实只读验证此前遗漏的9条可用动作现已返回。
- 详情全部使用当前 OF 原生读取；标签ID、名称、计划日期、重复规则不再拼入数据库旧快照。返回 ofStatus、available、statusSource 与 runtimeRevision。数据库专用工具仍是快照接口。
- 生产构建可重现：npm run build 使用 runtime/index.js 和 runtime/legacyTransition.js 固定当前协议，源码其余模块编译进入产物。v2账本目录排除；不要直接运行 tsc 覆盖生产 dist。

验证：生产 npm test 86/86；npm run test:staged 在独立临时目录构建和测试109/109。原先104项生产验证混有18项v2账本测试，清理残留后分离为86项生产测试，未以跳过失败来宣称通过。新只读MCP进程及真实OF详情/截止筛选验证成功；无业务任务测试写入。

旧的已连接MCP进程不会自动重新加载JS。Hermes /reload-mcp；Codex重连MCP。新返回应包含runtimeRevision；不能把磁盘已部署当成所有现存客户端已切换。Hook每次新进程自动使用新文件。

待办范围：nlAdd POST uncertain 是另一任务，本轮未重放或修复。v2 未上线；未执行真实归属转交。当时未提交 Git；相关实现此后已纳入版本控制。

回滚备份：/tmp/of-audit-deploy-backup。
