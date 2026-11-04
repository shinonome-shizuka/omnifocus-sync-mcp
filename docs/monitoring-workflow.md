# Third-party waiting monitors

Implemented 2026-11-03. No real Action has been configured or enabled by this change. No daemon, launch agent, cron job or Codex automation is installed/started.

## API and lifecycle

- `of_monitor_get(id, limit=20)`: configuration, eligibility, projection and bounded recent events.
- `of_monitor_configure(id, expectedRevision, source, intervalMinutes, timeZone, notifyWhen, nextCheckAt, maxFailures=3, enabled=false)`: explicit per-Action setup. The source is a reference to an authorized channel; never store passwords/tokens. Interval is elapsed minutes, not a calendar recurrence; timeZone documents presentation. Enabling requires user authorization. Configuration does not check the third party or start a timer.
- `of_monitor_due(limit=50, offset=0)`: read-only, due enabled configurations, P0–P3 then unprioritized. Returns revision for compare-and-set claim. Re-read and claim before executing. Unconfigured AFK+等待 candidates are found via ordinary unfinished paginated OF listing, not this configured queue.
- `of_monitor_transition`: `id`, `platform` (codex/hermes), actual `sessionId`, fresh `runId`, unique `eventId`, `expectedRevision`, `event` required. `start` claims a due round. `checked` requires `outcome` unchanged/changed/error and `summary`; successful observations also require `fingerprint` and `evidence`. `done` and `needs_human` require `summary`.
- `of_monitor_check(id, runId)`: durable ownership plus eligibility from a fresh local data snapshot (no automation for this read), used by execution guards.
- `of_monitor_reconcile(id, expectedRevision, decision, reason)`: explicit operator-only recovery after inspecting uncertain native writes. `accept_written` verifies exact expected tags/note and ownership; `discard_not_written` verifies unchanged before snapshot. Neither replays an OF write. Human edits/ownership changes are rejected. This is not automatic retry or permission to override human changes.

Start adds existing 进行中 only. Checked removes only 进行中, preserves AFK/等待, notes and completion status. No HITL for an ordinary observation. Each confirmed round releases execution ownership and schedules nextCheckAt relative to completion. Changed fingerprints return notify=true once per latest notified fingerprint; caller is responsible for delivering the meaningful update. Unchanged returns false. A query error does not change last known fingerprint/evidence; maxFailures consecutive errors escalate to needs_human and disable the schedule. Done/needs_human add HITL and a concise note, disable future checks, never complete OF or change 等待.

## Eligibility and concurrency

Claim prechecks and execution guards read the data layer (SQLite/WAL by default). Monitor eligibility permits the waiting-tag blocker only when no independent blockers exist; this is not proof of live application memory. The actual write runs through of-cli and checks native OF eligibility and expected tags/note again. Check projectStatus separately from the project root task status. Completed/dropped actions or ancestors, inactive projects, future effective defer, preceding unfinished sequential siblings, action groups and other held/dropped tags are rejected. HITL and removed AFK/等待 revoke execution. No temporary tag removal is used to test availability.

All transitions and configuration use the same per-Action `transition-<hash>.lock` as legacy and staged v2. Existing v2 records are refused: no cross-protocol transfer is implied. Legacy active owners and uncertain intents are refused. Monitor compatibility owner records use monitor_start/monitor_checked so ordinary lifecycle calls cannot finish a monitor round. Session hooks recognize monitor transitions and terminal checked, with live checks through the monitor engine; ordinary execution retains its Available requirements.

An intent is saved before native writes. A crash/failure leaves it fenced; inspection/reconciliation is mandatory. No TTL steals a running claim, no Stop infers completion, no automatic stale-lock deletion. Unrelated owner changes invalidate reconciliation.

## Persistence and uncertain outcomes

of-cli commits native changes with Omni Automation Database.save(), then the shared write path polls the persisted data layer for expected tags/note before confirming the event. A timeout, save error or mismatch is uncertain, not a successful round; preserve the intent and inspect before explicit reconciliation. Do not call Cocoa document.save(), retry blindly or fall back to direct transactions. Database.save() is not a proven reload mechanism for external database edits, and local verification does not prove WebDAV completion. See [current read/write contract](unified-entry.md). Ordinary writeStatus fields do not replace monitor event/ledger confirmation.

For an unwritten start where only the user's note/modified timestamp changed, explicitly authorized discard_not_written can preserve the new note while clearing the failed intent, provided other guarded fields, tags and ownership still match. Re-read and use fresh runId/eventId after recovery; never ask the user to restore the old note. Other changed fields remain rejected. Fixed daily schedules require explicit alignment of nextCheckAt; intervalMinutes alone schedules relative to round completion.

## Opt-in dispatcher

`node scripts/monitor-scheduler.mjs` is a dry-run due-queue read by default.

`node scripts/monitor-scheduler.mjs --run -- /absolute/worker [args]` dispatches one bounded batch (50); `--watch` explicitly adds a 60-second poll. Never run either mode as part of installation/testing on real configuration. No shell interpolation. Per-Action dispatch locks prevent duplicate local worker launches; actual MCP claims remain authoritative across hosts. Worker receives Action ID/revision on stdin, loads config, claims using its own actual agent session, observes the source and confirms the terminal transition. It returns one JSON object. The dispatcher verifies the ledger terminal result; unchanged rounds stay silent. Worker timeout is 10 minutes with termination escalation; dispatch failures are throttled by interval and stop after maxFailures, with an error report. Operator inspects the dispatch failure record before clearing it. An uncertain/active round is never redispatched.

This is an adapter for an explicitly chosen agent worker, not a repair-portal crawler, universal login mechanism or permission to send messages/pay/approve. Source access and the worker executable must be configured when monitoring is later authorized.

## Deployment and tests

The normal build includes monitor modules and registers six tools in the legacy production entry; staged v2 entry registers the same APIs but existing v2-owned Actions are fenced. Source hooks for both hosts are updated. Reconnect/reload MCP to discover newly installed tools. Existing running processes are not restarted by this work.

Tests use temporary state directories and mocked native OF objects. MCP smoke tests use readonly mode and an empty state root. They do not configure real Actions or start the dispatcher.
