# OmniFocus unified MCP — development guide

## Current architecture

This fork is the single MCP entrypoint. `src/tools.ts` owns the ordinary tool registry. The companion omnifocus-cli owns all AppleScript/JXA/osascript execution; its `of mcp` only launches this service. Do not duplicate tools in the CLI or execute scripts from this server.

- Local reads: `src/nativeDatabase.ts` opens a read-only SQLite/WAL snapshot and adapts it to the common data model. `src/localDatabase.ts` scopes one snapshot per read request; missing or unsupported native schema fails explicitly.
- Remote / explicit transaction reads: `src/backend.ts`, `src/storage/`, and `src/ofocus/` share the ZIP/XML transaction engine. Read responses expose source and scope; persisted data is not live application memory.
- Default writes: named JSON request through `src/nativeBridge.ts` to of-cli, native modification, Omni Automation `Database.save()`, then independent persisted readback. `src/writeResult.ts` returns verified / pending-database / acknowledged-unverified. Save is not external-data reload or proof of WebDAV completion.
- Direct transaction writes remain explicitly high-risk: each ordinary call must set `writeMode: direct-database` and local/remote backend. No fallback, and never a bypass for AFK/monitor lifecycle failures.
- Exports: data reads followed by pure `src/formatData.ts` formatting. Attachment metadata and payloads also use the data/storage layers.

## Runtime and lifecycle boundaries

`npm run build` produces the production legacy entry from `runtime/`. `src/index.ts` and `src/ledger/` are staged v2, tested separately; do not silently deploy v2 or mix ownership protocols.

`runtime/legacyTransition.js` fences uncertain writes with an intent and only confirms after persisted tag/note verification. `src/legacyRecovery.ts` exposes explicit legacy reconciliation: inspect first, then accept already-observed effects or discard an exactly unchanged unwritten intent with an evidence token. It never writes OmniFocus or automatically replays a request. Old intents without adequate ownership evidence remain fenced.

Both ordinary and monitor lifecycle events must match installed Codex/Hermes Pre/Post Hooks. Stop audits only the current session; it neither scans all pending runs nor retries mutations. Keep complete request parameters, including codexThreadId, actor, eventId and expectedRevision. Never infer done from Stop, steal ownership, automatically remove HITL/等待, or mark an Action completed at handoff.

## Build and verification

Requires Node >=22.16.0. Build the companion CLI separately and configure `OMNIFOCUS_CLI_PATH` when checkouts are not siblings. Runtime credentials, databases, user state, personal host config, generated builds and test artifacts must stay outside commits.

```bash
npm ci
npm run build
npm test
npm run test:staged
```

Use isolated fixtures for failures and ownership races. Live tests require authorized disposable tasks and verified cleanup; report whether tests exercised the actual host, configured Hook commands, or isolated wrappers. Do not claim Hermes gateway hot reload or remote sync without evidence. Existing MCP processes must reconnect for new tools.

Read [unified entry](docs/unified-entry.md), [AFK/Hook verification and recovery](docs/afk-hooks-verification.md), [monitor workflow](docs/monitoring-workflow.md), and the [workflow skill](skills/omnifocus-agent-workflow/SKILL.md).

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **omnifocus-sync-mcp-fork** (648 symbols, 1836 relationships, 50 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/omnifocus-sync-mcp-fork/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/omnifocus-sync-mcp-fork/context` | Codebase overview, check index freshness |
| `gitnexus://repo/omnifocus-sync-mcp-fork/clusters` | All functional areas |
| `gitnexus://repo/omnifocus-sync-mcp-fork/processes` | All execution flows |
| `gitnexus://repo/omnifocus-sync-mcp-fork/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
