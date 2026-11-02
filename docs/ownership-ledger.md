# OmniFocus 智能体归属账本（待实现设计）

日期：2026-11-02（Asia/Shanghai）。本文件是后续实现约定；尚未修改运行中的 MCP、Hook 或 Multica 权限。

## 语义

AFK 表示可以交给智能体独立处理；Multica 标签及备注决定执行平台。进行中表示存在唯一执行归属；AFK + HITL 表示需要人验收或决策。等待完全由人管理。派单成功不是业务交付完成，不应仅因派单就进入 HITL。任何流程都不自动勾选 OF 完成。

## 账本与状态

每个 Action 独立账本，按序追加事件，不覆盖历史。事件字段：schemaVersion、eventId、actionId、sequence、eventType、timestamp、actor、fromOwner、toOwner、transferId、expectedRevision、externalTask、reason、evidence。owner 包含 platform、sessionId、runId；externalTask 包含 system、workspaceId、issueId、identifier、url。审计不写凭据或长工具日志。

事件种类：claimed、transfer_offered、transfer_accepted、transfer_cancelled、delivered、needs_human、human_revoked、reconciled。转交双方身份及具体事件时间均须保存。历史资料不完整时记录 imported_snapshot，不能编造缺失事件。

currentOwner、revision、pendingTransfer、phase 为投影。推荐将事件数组及投影保存在同一原子替换文档中，使一次提交同时更新两者；每次读取验证 sequence 与投影一致。需要规模化再迁移 SQLite 单事务。账本具有本机文件权限保护和逻辑不可修改历史约束，不宣称防篡改或跨机器身份认证。

## 两阶段转交

1. 当前持有人 offer：验证 live OF 状态、唯一归属、expectedRevision、没有未决写入，记录接收平台、外部任务、transferId 和期限。进入 transferring 后旧持有人停止业务操作，仅能查状态、取消尚未接收的转交。
2. 接收者 accept：提交 transferId、预先绑定的目标身份、新 runId、单次接收凭证。账本锁内校验，再 CAS 更新 owner 与 revision 并追加 accepted。接收前无执行权，接收后旧 owner 无权执行、完成或再次转交。
3. 重复相同事件和参数返回已记录结果；同一 eventId 参数不同、过期凭证、目标不符、旧 revision 均拒绝。已接受转交不能由旧持有人取消。
4. Multica 初次任务先做接收，不先执行业务。若真实 sessionId 运行前未知，用绑定到 issue/run 的一次性凭证接收时补齐，不能仅靠可猜测的 issueId 授权。凭证不得放公开任务说明或日志；交付渠道需在实现时验证。
5. 接收成功保持进行中，不添加等待/HITL；最终持有人交付或需要人工时才转换 HITL。

## 并发、故障与人工撤回

使用现有按 Action 的排他锁，offer/accept/finish 共用。清理残留锁前验证 PID 已退出；跨机器调度必须经过同一本机 MCP/账本服务，不把本机锁当分布式锁。

OF 写入与本地账本不是同一事务：先保存 intent，执行写入，回读核对后确认事件。结果不确定时保留 pending/uncertain，禁止盲重试，人工或明确的 reconcile 依据前后状态补事件。转交本身不应改 OF 标签，减少双写。

每次重要业务操作前，守卫同时验证账本 owner/runId/revision 和 live OF 状态。旧持有人本地 session 标为 transferred（终止执行权，不等于 delivered），新持有人标为 active。人工移除进行中、添加 HITL、完成、丢弃、暂停或使事务不可执行时，两端停止；不得自行恢复人工状态。旧进程与旧接口也必须拒绝绕过账本写 owner；需版本门槛/停机切换，不能只新增一个 transfer 接口。

## 接口草案

- of_agent_transfer(action=offer|accept|cancel, id, transferId, eventId, expectedRevision, runId, target/externalTask/credential)：精确参数随实现验证。
- of_agent_ledger(id, limit=20, beforeSequence?)：返回当前投影和分页事件，默认不返回全部历史。
- of_agent_transition(start|done|needs_human)：接入同一账本；保留原工具名，但拒绝非当前 owner 的结束请求。
- Codex / Hermes / Multica 的执行、Stop、生命周期 Hook 同时更新；转出者 Stop 不应误报未交付，接收者未确认不得执行。

## 本次案例与迁移

OF Action：oX9UgTGCN3u，《开拓物语》，CaseStudy.202611。
Multica：NPCT-30，issue 01a19cf1-980a-7a3b-813d-7d791dd150b3，CaseStudy生成器 b5dc35ab-9f6c-4f53-b9f6-ecc7c42c71cf。
链接：https://agent.npcent.com/npc-ai/issues/NPCT-30

本次 Codex 已按旧流程结束派单并添加 HITL。Multica 任务说明明确禁止写 OF；目前没有正式转交记录。不能将历史 done 改成 active，也不能伪造接收。明天先核对 Multica 是否已交付：已交付则人工验收；仍运行则明确恢复/接管授权，验证新协议部署后再协调一次真实转交。更新 Multica 说明时保留已经完成的工作，不重新派重复任务。

## 验收清单

- 两个 sender/receiver 并发只允许一次成功；重放幂等且历史不重复。
- 转交后旧 runId 的 start/done/needs_human 均失败；接收者可正常结束。
- 拒绝已结束、HITL、不可执行任务的转交；拒绝过期、错误接收者或重用凭证。
- 故障注入覆盖 intent 写入、OF 写入、账本提交间崩溃；不丢历史、不自动重放未知写入。
- Codex/Hermes/Multica 的 session map、执行守卫、Stop 均遵守转交状态。
- 运行期间无等待/HITL 自动回加；最终交付添加 HITL、保留 AFK、不完成任务。
- 使用模拟任务与临时账本测试；真实任务只做经授权的实际交接，不用于反复测试。
