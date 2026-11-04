# 归属账本 v2 实现与切换边界

2026-11-03 初版，2026-11-04 更新。实现及暂存适配器已纳入版本控制，但 v2 未切换为生产协议。生产仍使用 legacy 生命周期；普通 Hook 的后续修复不代表 v2 上线。以下协议与切换说明仅适用于 staged v2。当前验证见 [AFK Hooks 验证](afk-hooks-verification.md)。

## 文件及接口

- src/ledger/store.ts：私有存储、原子替换、fsync、按 Action 排他锁、runId 全局保留。
- src/ledger/engine.ts：追加事件、投影验证、两阶段转交、幂等、故障恢复、快照导入。
- src/ledger/runtime.ts：本机 OF 端口；写入仍用原生自动化，不写事务包。
- src/ledger/tools.ts：MCP 注册及参数限制。
- src/ledger/guard.ts：三个宿主共用执行/Stop 判定。
- scripts/ledger-v2/guard.mjs：暂存的 Codex/Hermes/Multica 入口；部署时显式传宿主名。
- scripts/ledger-v2/admin.mjs：人工核查后的导入/恢复入口，不注册为智能体 MCP 工具。

staged v2 的 of_agent_transition 保留 start/done/needs_human 名称，新增必填 protocolVersion=2、actor（platform/sessionId/runId）、eventId、expectedRevision；顶层 runId 必须与 actor 一致。旧参数调用被拒绝，不继续旧 owner 覆盖逻辑。

of_agent_transfer 使用 offer/accept/cancel、transferId，以及同一组身份和修订号。offer 指定目标 platform/runId/sessionId 与 24 小时内期限。Multica session 未知时必须绑定 externalTask 的 system、workspaceId、issueId、identifier、url；accept 补齐真实 session，精确匹配外部任务与私有凭证。接收后旧持有人不能 start/done/needs_human/cancel。

of_agent_ledger 默认返回最近20条事件、上限100，beforeSequence 向前分页。投影与事件输出剔除凭证哈希和私有文件路径。of_agent_check 验证当前 owner/session/run/revision 与实时 OF Available 状态。

## 账本与幂等

根目录默认 ~/.local/state/omnifocus-agent；测试使用 OF_AGENT_STATE_DIR 指向临时目录。每个 Action 一个 ledger-v2 文档，包含只追加的 events、projection、intent。事件保存双方身份、时间、顺序、预期修订、外部任务、原因和证据。加载时验证连续 sequence、唯一 eventId、owner 链与最终投影。该机制是应用层历史不可修改约束，不声称能防止同一 OS 用户篡改文件。

eventId 相同且参数相同可幂等回放；参数不同或 revision 过旧被拒绝。已转出的 start、已结束的 offer 和不再属于当前执行人的 accept 不恢复旧执行权。runId 保留记录跨 Action 唯一，失败或结束也不自动释放；崩溃产生的不完整保留文件会拒绝使用，需人工核查。

所有修改使用与旧版相同的 transition-ActionHash.lock。不会自动抢占残留锁。锁不是分布式锁，所有宿主必须访问同一权威服务/状态目录。执行前检查只能拒绝后续调用，不能撤销已经开始的外部工具。

## 双写和恢复

生命周期先记录完整 intent，再调用 OF，回读核对标签、备注、完成/丢弃状态，然后把事件和投影一起保存并清空 intent。任何不确定结果保留 intent，禁止盲重试。offer/accept/cancel 不修改 OF。

admin 恢复要求明确原因和证据。applied 必须匹配原请求的预期后状态，补原事件及 reconciled；not_applied 必须与原快照完全一致，只追加 reconciled，不自动重写 OF；revoked 要求实时状态确实不可执行，释放逻辑归属但不恢复人改过的标签。恢复权限依赖受控部署入口，环境开关不是安全沙箱。

历史仅以 imported_snapshot 导入，保存源说明与证据，不补造旧 claimed/accepted。发现旧 local-ownership、pending、备注 marker 或进行中而没有新账本时，拒绝直接 start。

## 宿主与凭证通道

暂存 guard 接受可信宿主提供的 session_id、hook_event_name、tool_name、tool_input。Codex 使用 PreToolUse/PostToolUse/Stop；Hermes 使用 pre_tool_call/post_tool_call/pre_verify。已核对本机 agent/shell_hooks.py 与 agent/turn_stop_gates.py：pre_verify 接受 action=continue，但仅代码编辑回合触发，受 max_verify_nudges 限制，超时不享受 pre_tool_call 的 fail_closed 保证。因此暂存适配器可请求续跑，不能宣称 Hermes 所有工作都有硬 Stop。要达到全任务强制结束校验，需要宿主提供通用结束门禁或调度器在报告任务完成前调用同一 guard；本轮不改 Hermes 核心。Multica 适配器采用同一规范，**当前尚未验证 Multica 实际部署的插件/worker Hook 注册点**，不能声称线上已拦截。

执行守卫同时校验平台、session、run、revision 与实时 OF；只读诊断及生命周期接口保留。Post 不相信工具响应的 ok:true，直接读账本确认事件。转出者即使本地 map 尚未更新也无法执行业务；Stop 以 accepted 的 fromOwner 作为转出证据。接收者未交付时 Stop 拒绝放行。

派给接收方的任务启动前，宿主必须私下提供 OF_LEDGER_ASSIGNMENT_FILE，包含 Action、目标 platform/runId、预期修订和可选 session。guard 在首个业务调用前建立 pending 记录；不能等 accept 调用之后才绑定。没有 assignment 的普通聊天仍不受此任务约束，因此必须由调度器强制注入，不能依赖模型自觉。

offer 生成256位随机凭证，返回私有 credentialPath；文件目录0700、文件0600，事件仅含哈希。凭证只能经受控宿主通道传给指定 worker，不能放任务描述、评论、OF 备注、环境日志或工具转录。accept 接口接受凭证，但宿主日志必须脱敏。**本轮没有验证线上 Multica 私密投递通道，也不开放新的网络服务或分发真实凭证。** 跨机器 Multica 需连接这台 Mac 上同一权威 MCP，不能复制账本作为独立主库。

## 切换要求

必须停机切换所有旧 MCP/Hook 进程；仅替换源码不能约束已加载旧代码的进程。先清点 active/pending/intent 并核对迁移，再构建新版到独立发布目录、安装三个宿主入口、私下配置 assignment 通道，验证旧协议请求拒绝和转交守卫后再恢复工作。旧服务凭据/入口不得继续允许生命周期写入。本轮未执行这些部署步骤。

在临时副本中构建并执行 npm test；测试使用 fake Action、临时账本和模拟 OF 端口。覆盖竞争、幂等、过期/错接收者、人工撤回、意图/写入/提交各阶段崩溃、迁移、投影损坏、三宿主 Hook、接收前拦截。npm test 也包含既有 scripts 下的守卫测试。运行测试前需在隔离副本构建，不要用生产 dist 作试验。

初版历史隔离验证：90 项测试通过（包括旧有测试）；当时生产 dist 内容哈希保持一致。这不是当前测试数量。GitNexus 公共入口变更影响9条流程，切换风险 HIGH；按停机整体切换处理。
