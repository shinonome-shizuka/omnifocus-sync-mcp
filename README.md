# omnifocus-sync-mcp

> **当前架构（2026-11-04）**：唯一 MCP 工具注册表在 `src/tools.ts`。读取默认只读本地 SQLite/WAL 持久化快照（Node >=22.16）；普通写入、AFK 和监控写回通过 **of-cli** 操作 OmniFocus，以官方 `Database.save()` 提交，再独立读回核验。响应区分 `verified`、`pending-database`、`acknowledged-unverified`，不将应用应答或保存视为远端同步完成。仅逐次显式指定 `writeMode: "direct-database"` 才允许高危事务直写，`backend` 选择本地或 WebDAV；不自动回退。`of mcp` 仅启动本服务，CLI 旧 MCP 已删除。见 [结构与工具迁移](docs/unified-entry.md)。以下保留原版同步协议背景。

A unified [MCP](https://modelcontextprotocol.io) server with local SQLite reads and
native app writes through of-cli. The original headless WebDAV protocol engine is
retained for explicit remote reads and high-risk direct transaction writes. That
engine implements OmniFocus's client-side end-to-end encryption in TypeScript;
ordinary app writes require macOS, OmniFocus and the companion CLI.

> ⚠️ **Alpha / use at your own risk.** This talks to your real task database. The
> read and write paths have been validated end-to-end against a live Omni Sync
> Server account (add + delete transactions round-trip correctly), and the crypto
> and parsing have an offline test suite — but this hasn't been exercised across
> every OmniFocus version or edge case. **Keep a backup** (in OmniFocus: File → Back
> Up Database), and consider a throwaway account while evaluating. See [Safety](#safety).

## How it works

An OmniFocus sync store is a WebDAV collection (`OmniFocus.ofocus/`) containing:

- a baseline transaction and a chain of delta transactions, each a `.zip` holding a
  `contents.xml` describing object creates/updates/deletes;
- `.client` files registering each device and the transaction "tail" it has synced to;
- an `encrypted` plist holding the wrapped document keys.

This server:

1. **Resolves the shard** — `sync.omnigroup.com` 302-redirects each account to a
   `syncN.omnigroup.com` host; the client follows it.
2. **Authenticates** with HTTP Digest (what Omni Sync Server negotiates).
3. **Decrypts** using the OmniFileStore format: PBKDF2 derives a wrapping key from your
   passphrase, RFC 3394 unwraps the document key slots, and each file is AES-128-CTR +
   HMAC-SHA256 in 64 KiB segments (encrypt-then-MAC).
4. **Replays** the transaction chain into an in-memory object model.
5. **Writes** by building a new `contents.xml`, zipping, encrypting, `PUT`-ting it as a
   new transaction descending from the current head tail, and refreshing its `.client`
   registration so other clients treat it as a real participant.

The crypto and format were reimplemented from Omni's **own open-source frameworks**
([OmniGroup/OmniGroup](https://github.com/omnigroup/OmniGroup), notably
`OmniFileStore/EncryptionFormat.md` and `DecryptionExample.py`) plus community
reverse-engineering ([tomzx/ofocus-format](https://github.com/tomzx/ofocus-format),
[rubyfocus](https://github.com/jyruzicka/rubyfocus)). See [CREDITS](#credits).

## Install

```bash
git clone https://github.com/shinonome-shizuka/omnifocus-sync-mcp.git omnifocus-sync-mcp-fork
git clone https://github.com/shinonome-shizuka/omnifocus-cli.git
# Check out matching revisions of both repositories before building.
cd omnifocus-cli
bun install
bun run build
cd ../omnifocus-sync-mcp-fork
npm ci
npm run build
```

Use Node >=22.16.0. With these sibling directory names, the service locates the
CLI automatically. For a different layout set `OMNIFOCUS_CLI_PATH` to the CLI's
`dist/cli.js`; `of mcp` can locate this service using `OMNIFOCUS_MCP_LAUNCHER`
pointing to `scripts/run.sh`. Build and deploy both repositories together.

## AFK, Hooks, and recovery

Use `of_agent_transition` for ordinary AFK work and `of_monitor_transition` only
for explicitly configured monitors. Codex/Hermes Pre/Post match both tool names.
Stop only audits its own session and never replays pending writes.

For an uncertain legacy write, call `of_agent_reconcile` with `decision: inspect`.
Inspect its before/current/owner evidence, then explicitly choose `accept_written`
or `discard_not_written` with the returned `expectedIntent` token and a reason.
Recovery does not write OmniFocus. Changed human data, ownership conflicts, locks,
or insufficient historical evidence remain blocked. Monitor recovery uses its
separate `of_monitor_reconcile` API.

Production and staged suites are separate (`npm test`, `npm run test:staged`).
The recorded release verification passed 142 production and 165 staged tests
(with overlap), plus disposable live AFK/monitor and fault-injection checks.
Actual Codex automatic Pre/Post events were observed. Hermes wrapper/configuration
checks do not establish gateway hot reload. See [verification details](docs/afk-hooks-verification.md).
New tools require reconnecting existing MCP clients. Local machine Hook configs
are not shipped as personal configuration files in this repository.

## Configure

Set credentials via environment variables (see [`.env.example`](./.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `OMNIFOCUS_SYNC_USERNAME` | remote only | Omni Sync Server account name |
| `OMNIFOCUS_SYNC_PASSWORD` | remote only | Omni Sync Server account password |
| `OMNIFOCUS_ENCRYPTION_PASSPHRASE` | no | Defaults to the sync password (OmniFocus's default) |
| `OMNIFOCUS_SYNC_URL` | no | Defaults to `https://sync.omnigroup.com` |
| `OMNIFOCUS_DATABASE` | no | Defaults to `OmniFocus.ofocus` |
| `OMNIFOCUS_CLIENT_NAME` | no | Display name for this client's `.client` file |
| `OMNIFOCUS_CLIENT_STATE_FILE` | no | Where the stable client id is stored |
| `OMNIFOCUS_READ_ONLY` | no | `1`/`true` to refuse all writes |

## Try it without an MCP client

A diagnostic CLI exercises the sync path directly:

```bash
export OMNIFOCUS_SYNC_USERNAME=... OMNIFOCUS_SYNC_PASSWORD=...
npm run probe -- sync            # show database counts
npm run probe -- list flagged    # list flagged tasks
npm run probe -- projects        # list projects
npm run probe -- add "Buy milk"  # add an inbox task
```

## Use as an MCP server

Run over stdio. Example Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "omnifocus": {
      "command": "node",
      "args": ["/absolute/path/to/omnifocus-sync-mcp/dist/index.js"],
      "env": {
        "OMNIFOCUS_SYNC_USERNAME": "your-account",
        "OMNIFOCUS_SYNC_PASSWORD": "your-password"
      }
    }
  }
}
```

### Tools

| Tool | Description |
| --- | --- |
| `of_sync` | Refresh the selected data snapshot and return counts; does not trigger app synchronization |
| `of_list_tasks` | List tasks (`remaining`, `available`, `flagged`, `inbox`, `due_soon`, `all`), with project/tag/search filters |
| `of_get_task` | Full detail for one task by id |
| `of_list_projects` | List projects with folder path and status |
| `of_add_task` | Create a task (inbox or in a project) |
| `of_complete_task` | Mark a task complete |
| `of_edit_task` | Edit name/note/flag/due/defer; clear dates |
| `of_delete_task` | Delete a task by id |

## Safety

- **Back up first**, and prefer a **test account** until you trust the write path.
- Start with `OMNIFOCUS_READ_ONLY=1` to explore safely.
- Direct database writes are append-only transactions; a bad write forks history rather than
  destroying data, and OmniFocus merges forks on its next sync — but that is a
  safety net, not a guarantee.
- Secrets come from the environment only; nothing is written to this repo. The client
  identity file (`client.json`) contains no secrets.

## Development

```bash
npm test          # offline test suite (crypto round-trips, parse/write, digest)
npm run dev -- ... # run the CLI via tsx without building
```

The offline tests cover the risky parts without a network or a real account: the
OmniFileStore encrypt/decrypt round-trip at every segment boundary, MAC tamper
detection, the passphrase→PBKDF2→key-unwrap pipeline, `contents.xml` build/parse
round-trips, partial-update merge semantics, and the full zip→encrypt→decrypt→parse
read path.

## Credits

Built by reimplementing formats documented and open-sourced by others:

- [OmniGroup/OmniGroup](https://github.com/omnigroup/OmniGroup) — Omni's own frameworks;
  `OmniFileStore/EncryptionFormat.md` and `DecryptionExample.py` are the authoritative
  encryption spec, and `OmniFoundation/XML/OFXMLIdentifier.m` the id format.
- [tomzx/ofocus-format](https://github.com/tomzx/ofocus-format) — the `.ofocus`
  transaction/format write-up.
- [jyruzicka/rubyfocus](https://github.com/jyruzicka/rubyfocus),
  [kumpelblase2/focus](https://github.com/kumpelblase2/focus) — prior-art parsers.

Not affiliated with or endorsed by The Omni Group. "OmniFocus" is their trademark.

## License

MIT — see [LICENSE](./LICENSE).

## Agent lifecycle (AFK → 进行中 → HITL)

`of_update_task_tags(id, add, remove)` applies tag deltas by existing tag ID/name, preserving unrelated tags. `of_list_tags` exposes the available names and IDs. `of_agent_transition(id, event, runId, reason)` handles the Agent workflow:

- `start`: requires an authorized, executable non-project Action tagged `AFK` without `HITL`; adds `进行中` and records the run owner.
- `done`: removes `进行中`, adds `HITL`; reason records the delivered result and validation.
- `needs_human`: same tags as done; reason records what the human must decide or provide.

AFK, 等待 and other tags remain. No lifecycle event completes the Action. A stable runId makes retries idempotent; another run cannot claim an Action already marked 进行中. Transition notes append to existing notes. Native writes require unambiguous existing workflow tags 进行中/HITL; missing tags cause an error. AFK must already exist on the Action.

Accepted transitions are persisted in `~/.local/state/omnifocus-agent/pending` before sync writes and removed after verification. Codex Stop only reconciles this session against durable evidence; it never replays pending writes. Explicit legacy recovery uses `of_agent_reconcile` after inspecting an intent token. Codex/Hermes Pre/Post hooks record both ordinary and monitor transitions. It does not infer success from a stopped conversation. The Agent skill must explicitly call the semantic event. Pending events older than 24 hours are retained for manual inspection. A lock alongside the configured client state serializes lifecycle changes on this machine; it is not a cross-machine distributed lock. After a process crash, inspect a stale `.agent-lock` before removing it.

Local installation includes `omnifocus-agent-workflow` skills for both hosts. Existing sessions/gateway processes must reload their MCP/Hook configuration before these integrations are available. Lifecycle writes require the local OmniFocus app and of-cli; their persisted effects are verified through the data layer. Remote sync completion is a separate check.

## Repetition and planned dates

`of_add_task` / `of_edit_task` accept `planned` and a structured `repetition` object. `of_edit_task` also supports `clearPlanned` and `repetition: null`. Recurrence validation does not expand infinite schedules. Task reads expose repetition method, schedule, anchor and catch-up alongside the rule.

See [OmniFocus parity and remaining limitations](docs/omnifocus-parity.md). Completing repeating items in direct-database mode is blocked until next-instance generation is supported; the default app mode lets OmniFocus generate the next instance.


查询默认返回未完成动作摘要，每页50条，最大200条，以 offset/nextOffset 翻页。完整备注按需用 of_get_task。已完成查询使用 doneDays:7 或 done:"--done7"（14等正整数同理），仅返回最近N×24小时完成的动作。filter:all 不再绕过完成过滤；includeCompleted:true 必须同时指定完成天数。生命周期统一使用 👨 HITL，不再添加 PHV 或等待；已有等待保留。


## 默认本地写入（更新于 2026-11-04）
普通写入工具默认 `backend:local, writeMode:app`，由 of-cli 使用本机 OmniFocus 自动化并提交，随后读取 SQLite 验证。远端写入必须同时显式传 `backend:remote, writeMode:direct-database`；单独指定 remote 会拒绝，不存在失败自动回退。启动本地 MCP 无需远端凭据。of_agent_transition 固定本机执行，不提供远端切换。

of_set_task_status 丢弃默认 allOccurrences:false，仅丢弃当前重复实例；只有显式 true 才丢弃整个系列。恢复 active 不接受 allOccurrences:true。远端单次丢弃重复任务暂不支持，会在写入前拒绝，不能偷偷等价成全部丢弃。普通非重复动作远端仍可丢弃。

本地检查周期支持 @Nd/@Nw/@Nm/@Ny；~ 浮动周期因本机API无法完整表达而拒绝，选择远端直写仍需显式高危模式。本地 review_batch 会先验证全部输入但不是原子事务，响应失败后应查询确认，勿盲目重放。原生完成重复任务可能产生新实例，返回 applicationResult.completedId。

部署：Hermes /reload-mcp；Codex重连MCP。保留原安全规则、HITL及任务有效状态检查。已通过65项测试和隔离临时对象本机写入测试；测试对象已清理。

AFK/Hook 接线、显式恢复与真实验证边界见 [afk-hooks-verification](docs/afk-hooks-verification.md)。

历史实现记录见 [v2 切换边界](docs/ownership-ledger-v2-implementation.md) 和 [2026-11-03 审计](docs/mcp-audit-fixes.md)。这些记录不代表 v2 已上线；当前状态以统一入口和 AFK Hooks 验证文档为准。
