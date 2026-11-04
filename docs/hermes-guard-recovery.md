# Hermes 生命周期与会话释放修复

2026-11-03：修复已应用于现有脚本入口，v2 账本仍未部署。

## 原因

1. tool_search / tool_describe 不在恢复工具白名单，pending 或失效绑定会连 MCP 发现入口一起拦截。
2. unpack 先检查 error，丢弃了带 error 的 ok:false/status:rejected；首次领取被拒绝后仍挂在 pending。
3. 会话 active 记录缺少核验后的释放入口。动作移除进行中后，旧会话持续阻塞所有业务工具。
4. 漏掉 Post Hook 时，没有读取精确本地归属记录恢复已确认的交付状态；迟到的 start 响应可能重开已结束的绑定。

## 修复

发现工具与 OF 只读诊断保持可用，不放行任意 MCP 写入或整个 tool_call 桥。Hermes 当前执行器会先解包 tool_call 再传实际工具名给 Hook。

明确 rejected 的首次领取退出 pending；uncertain 或未分类失败继续拦截。迟到的不同 tool_use_id 响应不覆盖当前请求，handed_off/released 不被旧 start 重开。

执行前检查本地归属记录的精确 Action/runId。确认 done/needs_human 且无 intent/pending/Action lock 时修复漏掉的 Post Hook；未知、不一致或仍在写入的记录不自动放行。

人工释放入口为 scripts/agent-session-release.mjs，必须指定 session、id、run、reason。核对实时 OF 已撤回/不可执行或精确记录已交接后，写 released 和原 phase、时间、原因。保留旧 runId 和领取证据，不写 OF、不伪造 done。仍可执行的当前认领、未决写入和 v2 账本均拒绝由此入口释放。被释放的旧 runId 不能再次启动。

## 本次恢复

Hermes 会话 20260921_023851_eb729e7f 的 maoF9N72QQn（育碧40周年）已无进行中；核验后将旧绑定标记 released，cause=revoked_or_inactive。OF 标签、备注、完成状态均未改动。旧认领不等于业务已交付。

备份位于 /tmp/of-guard-before-20261103；活动归属核对与释放记录仍保留在原 session map。

## 验证

100 项隔离测试通过，包括10项新增释放/恢复测试。对真实会话只执行守卫入口验证，未执行模拟名称对应的工具：发现工具、OF 查询、其他 MCP、terminal 返回允许；旧 runId 重新 start 返回拒绝。生产 dist 未重建；Hermes 每次调用脚本，下一次工具调用即可使用修复。
