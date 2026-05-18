---
name: mars:unblock
description: Help unblock a Mars task that the orchestrator stopped on. Loads the task and its blockers, reads implicated files, and proposes 2–3 concrete unblock options via AskUserQuestion. No proposal-shaping, no glossary curation, no ADR offers. Use when the user says "unblock <id>", "why is this blocked", "help with <id>", or invokes `/mars:unblock`.
---

# Mars: unblock a stuck task

A task is `status='blocked'` because the orchestrator hit something it
couldn't decide on its own — usually a question for the user, a missing
upstream task, or a decision that needs an ADR. Your job is to surface
**why** it's blocked, give the user enough context to decide, and then
execute their decision through the right `mars` verb.

You do **not** shape proposals, curate the glossary, or offer ADRs. If the
unblock decision turns out to need a new task, enqueue it and stop.

# Step 0 — No argument? Point to the inbox and stop.

If `$ARGUMENTS` is empty (after stripping any `--inbox` token — see
"Argument" section at the end), the user doesn't yet know which task
they want to unblock. Do **not** run `mars list blocked`. Instead, tell
the user:

> "Run `/mars:inbox` and pick a `task-blocked` row to continue here."

Stop here. Do not guess and do not pick one yourself.

# Step 1 — Identify whether the id is a task or an inbox item

**Read this carefully — confusing inbox-item ids with task ids is the
most common failure mode.** `mars inbox` prints lines like:

```
blockers (69):
  507862e3  high  no recovery recipe for verify:typecheck/unclassified
```

Those ids under "blockers" are **inbox item ids, not task ids**, and they
are not what `mars blockers <task-id>` operates on. If you pass one to
`mars show`, you'll get `no task or proposal matching <id>` and waste a turn.

Resolve the id **once, up front**, before doing anything else:

```bash
mars show <id> 2>&1 | head -1
```

- If it prints `kind: task` (or `kind: proposal`) → it's a task/proposal id,
  this skill applies as written. Continue to Step 2.
- If it prints `no task or proposal matching <id>` → try
  `mars inbox show <id>`. If that succeeds, the id is an **inbox item**.
  STOP and hand off — see "Inbox-item ids" below.
- If both fail → tell the user the id doesn't resolve and ask them to
  recheck the snapshot.

## Inbox-item ids — not this skill's job

This skill unblocks tasks. Inbox items are a different surface
(`mars inbox show/ack/resolve/dismiss`). If the id resolves to an inbox
item:

1. Print `mars inbox show <id>` so the user can see what it says.
2. Note that the underlying task (the inbox item's `payload.sourceTaskId`)
   may already be `dropped`, `done`, or `failed` — check it with
   `mars show <source-task-id>`. A stale inbox row pointing at a dead
   task is the most common case.
3. Hand off to `/mars:inbox` (which is built for triaging inbox rows) or
   ask the user whether they want to `ack`, `resolve`, or `dismiss` the
   row directly. Do not run those verbs yourself — they're outside this
   skill's scope.

Stop here. Do not proceed to Step 2.

# Step 2 — Load the task and its blockers

The argument is a real task id. Run:

```bash
mars show <id>
mars blockers <id>
```

## 2a — Re-orient the user first

Before talking about blockers, give the user a **2–3 line recap** of what
this task was actually trying to do. The user may not remember — the task
might have been queued days ago or as a prerequisite from a sibling task.
Diving straight into blocker mechanics
without that context forces them to reconstruct the goal from raw fields.

Print the recap in plain prose, in this shape:

> *"Task `<id>` — `<one-line goal>`. It came from `<origin>` and was meant
> to `<observable outcome>`. The orchestrator stopped on it at `<step>`."*

Pull the goal from the task's prompt/title (the first sentence of the
prompt body usually carries it). Origin candidates: a parent proposal
(`fromIdea: <proposal-id>`), a sibling task that blocked it, or "user-queued
via `mars task add`". The step is whichever workflow stage flipped it to
blocked (`code`, `verify`, `merge`).

Keep it terse — three lines, no field dump. The user just needs enough to
remember why they cared. Then move on to the blockers.

## 2b — Load the blockers

`mars blockers <id>` lists the open blockers (sibling task ids or note
rows). For each blocker id, run `mars show <blocker-id>` so you see what
the blocker actually says. If a blocker references a file or symbol, read
the file so your proposals are grounded in the code rather than a guess.

Use `Read` and `Grep` for file inspection.

# Step 3 — Decide the unblock options

Build a short menu of 2–3 concrete options for the user. Choose from these
shapes; combine when it fits:

- **Decide + clear blockers.** The blocker is a question the user can
  answer in one sentence. Their answer plus removing the blocker rows is
  enough to let the task proceed.
- **Split into a new task.** The blocker is real upstream work. Enqueue
  the prerequisite via `mars task add "..."`, leave the blocked task as-is
  (it will be re-checked when the new task lands).
- **Mark non-issue and unblock as-is.** The blocker turns out to be a
  phantom (already done elsewhere, no longer relevant). Phantom-recover
  with `mars unblock <id>` (no blocker ids → flips to `failed` and clears
  every blocker row; **the task itself does not auto-rerun** — `mars
  restart <id>` is the verb to put it back on the queue from setup, or
  `mars continue <id>` if the worktree is still on disk and you only
  want to re-run the failed phase).
- **Remove only specific blocker edges.** Some blockers are real, others
  aren't. `mars unblock <id> <blocker-id> [<blocker-id> ...]` removes
  those specific edges and leaves status unchanged; the task will
  re-evaluate when its remaining blockers clear.
- **Drop the task entirely.** The task isn't worth pursuing anymore.
  Two-step: `mars unblock <id>` (blocked → failed), then `mars purge <id>`
  to delete the row, worktree, and branch. This is the only way to make
  a task disappear from `mars list` — there is no `mars reject` for tasks.
  Irreversible.

Phrase the options for `AskUserQuestion` in plain language (not "edge
removal" — say "the missing piece is already done elsewhere; clear the
specific blockers").

If you are sure the blocker is structural (e.g. needs a brand-new
prerequisite task), include the proposed `mars task add` prompt body in
the option's `description` so the user can sanity-check it before you
enqueue.

# Step 4 — Execute the chosen option

Run the corresponding `mars` verb. Verb signatures:

```bash
# Phantom recovery: clear ALL blocker rows, flip task to 'failed'.
# Use when none of the blockers were real. Follow with `mars restart <id>`
# (or `mars continue <id>`) if the user wants the task put back on the
# queue.
mars unblock <id>

# Edge removal: drop only the listed blocker edges; status unchanged.
# Use when some blockers are real and others aren't.
mars unblock <id> <blocker-id> [<blocker-id> ...]

# Add a new prerequisite task; the blocked task waits for it.
mars task add "<self-contained prompt body>"
mars block <blocked-task-id> <new-task-id>

# Re-queue a failed task (after phantom recovery).
# `continue` resumes on the existing worktree from the failed phase;
# `restart` wipes worktree+branch and runs the pipeline from setup.
mars continue <id>
mars restart <id>

# Drop a task entirely (after flipping it to failed via `mars unblock`).
# Deletes the queue row, the worktree, and the branch. Irreversible.
mars purge <id>
```

After the verb runs, print one short confirmation line — what changed,
and (if relevant) what the user should expect next ("orchestrator will
pick up <new-id> automatically" or "<id> is back on the queue").

## Inbox resolution on success

If an `--inbox <inbox-id>` was passed in `$ARGUMENTS` **and** the
chosen option fully clears the block (the task is now re-queued,
restarted, continued, or dropped — i.e. it is no longer `blocked`),
run:

```bash
mars inbox resolve <inbox-id> --note "<one-line summary of what was done>"
```

**Only resolve when the underlying condition is gone.** If the user
chose "split into a new task" and the original task still has open
blockers (status remains `blocked`), do **not** resolve the inbox row —
it stays open until the chain clears. When in doubt, check the task's
status with `mars show <task-id>` before resolving.

# What you do NOT do

- Do not call any `mars proposal` write verb (`add`, `set`, `promote`, etc.).
  This skill operates on tasks, not proposals. If the unblock requires
  shaping a new feature, enqueue it as a `mars task add` prompt with
  enough self-contained context, or send the user to `/mars:grill` for
  proposal-shaping.
- Do not run `mars glossary set/remove` or `mars adr add`. Domain-language
  curation belongs to `mars:grill`.
- Do not invent flag combinations not shown above. If `mars unblock`,
  `mars continue`, or `mars restart` errors, surface stderr verbatim and
  ask the user how to proceed — do not retry blindly with different
  flags.
- Do not promote the resolved task into "done" by hand. The orchestrator
  owns task lifecycle once a task is queued/running.

# Argument

The user passed: `$ARGUMENTS`

**Parse `$ARGUMENTS` as follows before doing anything else:**

1. Look for a `--inbox <inbox-id>` token anywhere in the string. Extract
   `<inbox-id>` and strip the `--inbox <inbox-id>` token from the string.
   If absent, `inbox-id` is empty.
2. Treat the remainder (trimmed) as `<task-id>`.

If `<task-id>` is empty after parsing, go to **Step 0** (point to the
inbox). If `<task-id>` is present, start at **Step 1** (resolve task vs.
inbox item first). Carry `inbox-id` through to **Step 4** for the inbox
resolution logic.
