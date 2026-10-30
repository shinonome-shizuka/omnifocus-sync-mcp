# OmniFocus MCP parity

This fork is not full OmniFocus parity. This document separates implemented fields from behavior that still requires OmniFocus.

| Area | Current support | Remaining work |
| --- | --- | --- |
| Actions | Read, create, edit, move subtrees, Inbox moves, drop/reactivate, complete non-repeating actions, delete | Arbitrary sibling reorder, complete action groups with native semantics |
| Dates | Due, defer and planned read/create/edit/clear | Explicit floating-time/time-zone preservation across host zones |
| Repetition | RRULE, fixed/defer-after-completion/due-after-completion, due/defer/planned anchor for fixed schedules, catch-up, clear; applies to existing project root tasks too | Modern planned-after-completion settings and native app end-to-end validation; occurrence generation remains owned by OmniFocus |
| Tags | List, create/rename/reparent, delete unused tags, add/remove existing tags without replacing unrelated tags | Tag status, exclusive groups and location behavior |
| Projects | List, create, edit existing task-backed fields, review scheduling | Deletion/status/type/move APIs and full project lifecycle |
| Folders | List paths, create/rename/reparent, delete empty folders | Native app validation |
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

`of_complete_task` refuses repeating items and descendants of repeating groups/projects. Writing only `<completed>` is not equivalent to OmniFocus's recurrence engine and cannot safely promise a next instance. Complete these items in OmniFocus ; recurrence generation remains owned by OmniFocus.

## Validation

Offline builder/parser round trips cover daily, weekly, monthly relative-day, yearly, COUNT/UNTIL, completion-relative methods, planned dates, clear operations and malformed input. AFK tests cover ownership, idempotency and preserving unrelated tags/notes. Live MCP tool discovery was verified; live sync access in the development environment has timed out. No successful production recurrence write is claimed.

Field vocabulary was checked against locally generated OmniFocus XML without publishing user data. Product semantics reference: https://support.omnigroup.com/documentation/omnifocus/universal/4.10/en/inspector/


## Hierarchy and Action state

- `of_move_task(id, parentId)`: move an Action subtree under a project/group ID; null means Inbox. Append after existing siblings; reject self/descendant cycles, inactive destinations and project roots. A no-op keeps rank. Rank exhaustion requires reordering in OmniFocus.
- `of_set_task_status(id, status)`: dropped or active. Active clears the Action's own completed/dropped dates; it does not reactivate parents, alter descendants, or merge generated repetition instances. Reactivate a completed Action before dropping it.
- `of_set_group_order(id, order, completedByChildren?)`: set parallel/sequential execution and optional complete-by-children. Does not manually rearrange children or mark the group completed immediately.

These APIs reload before planning and verify the written values by reading the sync database again. Tests cover planner and XML parser/builder behavior; native app end-to-end writes remain unverified while sync connectivity is unreliable.

## Catalog management

of_manage_folder and of_manage_tag accept operation create/update/delete. Updates preserve omitted fields; parentId null moves to root. Deletion rejects children and references, including task-to-tag joins. of_create_project creates an active project. All new writes refresh before planning and verify after commit. Live mutation validation remains outstanding; these additions do not constitute full native feature parity.


## Transaction and hierarchy safety

Every transaction through `OmniFocusStore.writeTransaction` is validated before ZIP packaging, encryption and upload. Invalid declaration position, malformed XML, multiple/nested OmniFocus roots, incorrect namespace, illegal XML controls and DTD/entity declarations are rejected without a PUT. Literal markup inside CDATA is allowed. This validates XML structure, not the complete proprietary OmniFocus field schema. Client registration plist files use a separate writer.

`of_delete_task` accepts `dryRun` (default false). A dry run refreshes the database and returns `canDelete`, direct child IDs/names, and `deleted: false`, without uploading. Actual deletion rejects any children, including completed and dropped children, refreshes before checking, and reads back to verify deletion. Move or delete children explicitly first. This also permits deleting an empty project. No automatic recursive deletion is performed.

Task moves reject destinations whose ancestor is missing, in addition to the existing cycle and inactive-ancestor checks. Deletion inspection scans the task map once (O(n)); regression coverage includes 10,000 children. Offline tests verify blocked writes and unchanged valid ZIP contents. Simultaneous writes by other sync clients are not made atomic by these checks.

## Conditional tags and agent hooks

Leading emoji on workflow tags are ignored for matching; ambiguous normalized names are rejected. Agent start adds 等待 and 进行中; completion/handoff leaves 等待 unchanged (additive rule). Explicit tag editing also adds the existing unique 等待 tag when resulting tags contain AFK and 进行中. Removing 等待 while both conditions remain is rejected.

The Codex context hook reminds the model at SessionStart/UserPromptSubmit to bind authorized work to an exact Action ID and call lifecycle tools. The Stop hook only retries explicit pending transitions; it does not infer completion. Hook scripts record last invocation timestamps locally. Configuration/trust approval and a new host event are required to verify real host execution; manually executing a hook is only a script smoke test. Hermes uses the installed workflow skill and SOUL instruction, with its existing agent:end retry hook.
