# OmniFocus MCP parity

This fork is not full OmniFocus parity. This document separates implemented fields from behavior that still requires OmniFocus.

| Area | Current support | Remaining work |
| --- | --- | --- |
| Actions | Read, create, edit, move subtrees, Inbox moves, drop/reactivate, complete non-repeating actions, delete | Arbitrary sibling reorder, complete action groups with native semantics |
| Dates | Due, defer and planned read/create/edit/clear | Explicit floating-time/time-zone preservation across host zones |
| Repetition | RRULE, fixed/defer-after-completion/due-after-completion, due/defer/planned anchor for fixed schedules, catch-up, clear; applies to existing project root tasks too | Next-instance generation, skip occurrence, modern planned-after-completion semantics and native app end-to-end validation |
| Tags | List and add/remove existing tags without replacing unrelated tags | General tag CRUD, exclusive groups and location behavior |
| Projects | List, edit existing task-backed fields, review scheduling | Exposed creation/deletion/status/type/move APIs and full project lifecycle |
| Folders | Internal parsing | Public CRUD and hierarchy operations |
| Agent workflow | AFK -> 进行中 -> PHV, ownership, handoff notes, durable MCP retries | Distributed cross-machine ownership |
| Perspectives | Not exposed | Query rules and saved perspectives |
| Attachments / notifications | Not exposed | Storage, metadata, delivery semantics |

## Repetition input

`of_add_task` and `of_edit_task` accept `repetition`:

- `rule`: one RRULE string; optional `RRULE:` prefix. Examples: `FREQ=WEEKLY;BYDAY=MO,WE,FR`, `FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1`.
- `method`: `fixed` (default), `start-after-completion`, or `due-after-completion`.
- `anchor`: `due`, `defer`, or `planned`. Defaults to defer for start-after-completion and due otherwise. Completion-based methods require their matching anchor.
- `catchUpAutomatically`: boolean, default false; valid only for fixed schedules.

`repetition: null` clears all repetition fields together. Omitting the field preserves the existing rule. Dates remain separate from the recurrence definition: use `due`, `defer`, or `planned` to set the starting date and time. Editing supports `clearDue`, `clearDefer`, `clearPlanned`; setting and clearing the same date is rejected.

Reads expose all five underlying repetition fields. Unknown values from newer OmniFocus versions are preserved on reads and unrelated edits rather than normalized away.

`of_complete_task` refuses repeating items and descendants of repeating groups/projects. Writing only `<completed>` is not equivalent to OmniFocus's recurrence engine and cannot safely promise a next instance. Complete these items in OmniFocus until recurrence generation has been implemented and validated.

## Validation

Offline builder/parser round trips cover daily, weekly, monthly relative-day, yearly, COUNT/UNTIL, completion-relative methods, planned dates, clear operations and malformed input. AFK tests cover ownership, idempotency and preserving unrelated tags/notes. Live MCP tool discovery was verified; live sync access in the development environment has timed out. No successful production recurrence write is claimed.

Field vocabulary was checked against locally generated OmniFocus XML without publishing user data. Product semantics reference: https://support.omnigroup.com/documentation/omnifocus/universal/4.10/en/inspector/


## Hierarchy and Action state

- `of_move_task(id, parentId)`: move an Action subtree under a project/group ID; null means Inbox. Append after existing siblings; reject self/descendant cycles, inactive destinations and project roots. A no-op keeps rank. Rank exhaustion requires reordering in OmniFocus.
- `of_set_task_status(id, status)`: dropped or active. Active clears the Action's own completed/dropped dates; it does not reactivate parents, alter descendants, or merge generated repetition instances. Reactivate a completed Action before dropping it.
- `of_set_group_order(id, order, completedByChildren?)`: set parallel/sequential execution and optional complete-by-children. Does not manually rearrange children or mark the group completed immediately.

These APIs reload before planning and verify the written values by reading the sync database again. Tests cover planner and XML parser/builder behavior; native app end-to-end writes remain unverified while sync connectivity is unreliable.
