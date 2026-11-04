# AFK 与 Hook 接线及恢复（2026-11-04）

## 实际入口

- Codex PreToolUse/PostToolUse 的生命周期 matcher 为 `of_(agent|monitor)_transition$`，同时记录普通 AFK 与监控。通用执行守卫核对归属和数据状态；只读查询及显式恢复入口仍可访问。
- Hermes pre_tool_call 保持全工具守卫，post_tool_call matcher 为 `.*of_(agent|monitor)_transition$`。checked 确认后会话轮次释放，不自动加 HITL。
- Codex Stop 的 agent-hook 只核对当前 session 的本地归属证据，不扫描所有人的 pending，不调用写入工具，不重发旧请求。Stop guard 自行核对，以免依赖两个 Hook 的执行顺序。
- 请求日志保留完整参数，包括 codexThreadId、monitor actor/eventId/revision；失败或不确定的请求不会被改造成另一个结果。
- 已确认交付但 Post Hook 丢失时，可以从同 id/runId 的 durable owner 恢复会话。未决 intent、pending、任务锁或其他 owner 均继续阻止执行。

## 普通 AFK 的显式恢复

生产 legacy MCP 新增 `of_agent_reconcile`；staged v2 继续使用自己的账本协议，不混用。

1. 以原 id/runId 调用 `decision: inspect`。返回原 request、before、current、owner、intentToken，以及 canAcceptWritten / canDiscardNotWritten。
2. 确认对应事实后，传同一 id/runId、原样 expectedIntent、具体 reason：
   - `accept_written`：当前原生持久化快照已经准确匹配预期标签、备注及其他被检查字段，归属没有被接管；只补记确认、清理已核对意图，不重复写 OF。
   - `discard_not_written`：当前快照与写前完全一致（含 modified），原 owner 未改变；只清理未执行意图。失败 start 的会话变为 rejected；失败 handoff 回到原 active 归属，后续交付需要明确调用生命周期。
3. token 过期、备注/标签/其他字段被修改、其他 owner、不同 pending 请求、v2 或监控归属、运行中的任务锁均拒绝。旧 intent 如果没有 recoveryVersion/previousOwner 证据，只允许查看，不能猜测后清除。
4. 恢复过程有本地审计记录；与 OF 写入使用相同每动作锁。恢复工具不自动领取、不改标签、不执行 save，不以恢复为名覆盖人类编辑。操作后守卫/Stop 从审计与 owner 核对会话结果。

监控继续用 `of_monitor_reconcile`。对仅修改备注的未写入 start，允许的恢复只排除 note/modified 及快照 observedAt 的变化；其他任务字段、快照来源和归属仍被检查。

## 验证证据及边界

- 隔离回归覆盖完整请求参数、pending/归属/锁冲突、写前失败清理、写后回执丢失确认、错误 token、人类编辑、旧证据不足、监控会话 active→released、丢失 Post Hook 的 Stop 收尾、无关会话 pending 不被重放。
- 真实临时动作经过新构建 MCP 和实际安装的 Codex Hook 命令，完成普通 start/guard/done/Stop 与监控 start/guard/checked/Stop。验证未完成动作、不改变等待、静默 checked、单次交付前缀和真实聊天链接。
- 另外对真实临时动作注入写前失败及写后回执丢失：两者都先阻止继续执行，再分别 discard_not_written / accept_written；恢复没有重放 OF 写入。账本隔离在临时目录，没有启动调度器、没有领取已有业务动作。
- 本聊天也直接通过已连接 MCP 调用了普通 start/done，宿主自动 Pre/Post 后分别观察到 active / handed_off；并非只模拟脚本。
- Hermes 的事件 envelope 与实际守卫进程通过隔离测试，安装配置已修正；不把这些测试宣称为正在运行的 Hermes gateway 已热加载或真实 Hermes 会话已完成全链路。
- 新增恢复工具需要 MCP 常驻服务重连后暴露。测试日志在 `/tmp/of-live-hook-results.jsonl`；安装配置修改前备份在 `/tmp/of-hook-config/`。

最终构建与回归：生产 142 项、staged 165 项全部通过（两组存在重叠，不合计为独立用例）；额外覆盖恢复过程在 owner 已保存后中断，再恢复时不重放 OF。所有真实临时动作已删除，残留为 0。
