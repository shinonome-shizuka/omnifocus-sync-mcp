# omnifocus-sync-mcp

A headless [MCP](https://modelcontextprotocol.io) server that reads **and writes**
OmniFocus data by talking **directly to the Omni Sync Server** over WebDAV — no Mac,
no running OmniFocus app. It implements OmniFocus's client-side end-to-end encryption
in TypeScript, so it can run anywhere Node runs (a Linux NAS, a container, a cloud box).

Every other OmniFocus MCP server automates the local macOS app via AppleScript/JXA.
This one speaks the cloud sync protocol instead, which is what lets it run headless.

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
git clone https://github.com/rosskukulinski/omnifocus-sync-mcp.git
cd omnifocus-sync-mcp
npm install
npm run build
```

## Configure

Set credentials via environment variables (see [`.env.example`](./.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `OMNIFOCUS_SYNC_USERNAME` | yes | Omni Sync Server account name |
| `OMNIFOCUS_SYNC_PASSWORD` | yes | Omni Sync Server account password |
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
| `of_sync` | Reload the database from the server; returns counts |
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
- Writes are append-only transactions; a bad write forks history rather than
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

- `start`: requires an active non-project Action tagged `AFK`; adds `进行中`, removes `HITL` and records the run owner.
- `done`: removes `进行中`, adds `HITL`; reason records the delivered result and validation.
- `needs_human`: same tags as done; reason records what the human must decide or provide.

AFK and other tags remain. No lifecycle event completes the Action. A stable runId makes retries idempotent; another run cannot claim an Action already marked 进行中. Transition notes append to existing notes. Missing workflow tags 进行中/HITL are created in the same transaction. AFK must already exist on the Action.

Accepted transitions are persisted in `~/.local/state/omnifocus-agent/pending` before sync writes and removed after verification. `scripts/agent-hook.mjs` retries these through MCP at Codex Stop / Hermes agent:end. It does not infer success from a stopped conversation. The Agent skill must explicitly call the semantic event. Pending events older than 24 hours are retained for manual inspection. A lock alongside the configured client state serializes lifecycle changes on this machine; it is not a cross-machine distributed lock. After a process crash, inspect a stale `.agent-lock` before removing it.

Local installation includes `omnifocus-agent-workflow` skills for both hosts. Existing sessions/gateway processes must reload their MCP/Hook configuration before these integrations are available. The underlying sync store must be reachable and writable. This installation was tested with pure state transitions and MCP tool discovery; production state changes must be verified against a reachable sync server.

## Repetition and planned dates

`of_add_task` / `of_edit_task` accept `planned` and a structured `repetition` object. `of_edit_task` also supports `clearPlanned` and `repetition: null`. Recurrence validation does not expand infinite schedules. Task reads expose repetition method, schedule, anchor and catch-up alongside the rule.

See [OmniFocus parity and remaining limitations](docs/omnifocus-parity.md). In particular, completing repeating items through sync is blocked until next-instance generation is supported; configure repetition through MCP and complete occurrences in OmniFocus for now.


查询默认返回未完成动作摘要，每页50条，最大200条，以 offset/nextOffset 翻页。完整备注按需用 of_get_task。已完成查询使用 doneDays:7 或 done:"--done7"（14等正整数同理），仅返回最近N×24小时完成的动作。filter:all 不再绕过完成过滤；includeCompleted:true 必须同时指定完成天数。生命周期统一使用 👨 HITL，不再添加 PHV 或等待；已有等待保留。


## 默认本地写入（2026-11-02）
全部13个旧写入工具默认 backend:local，使用本机 OmniFocus 自动化；本地事务包用于读取，本地文件不直接写入。逐次显式传 backend:remote 才使用旧 WebDAV 实现；不存在失败自动回退。启动本地 MCP 无需远端凭据。of_agent_transition 固定本机执行，不提供远端切换。

of_set_task_status 丢弃默认 allOccurrences:false，仅丢弃当前重复实例；只有显式 true 才丢弃整个系列。恢复 active 不接受 allOccurrences:true。远端单次丢弃重复任务暂不支持，会在写入前拒绝，不能偷偷等价成全部丢弃。普通非重复动作远端仍可丢弃。

本地检查周期支持 @Nd/@Nw/@Nm/@Ny；~ 浮动周期因本机API无法完整表达而拒绝，需明确选择远端。本地 review_batch 会先验证全部输入但不是原子事务，响应失败后应查询确认，勿盲目重放。原生完成重复任务可能产生新实例，返回 completedId。

部署：Hermes /reload-mcp；Codex重连MCP。保留原安全规则、HITL及任务有效状态检查。已通过65项测试和隔离临时对象本机写入测试；测试对象已清理。
