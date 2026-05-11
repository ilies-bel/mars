---
name: mars:unblock
description: Help unblock a Mars task that the orchestrator stopped on. Loads the task and its blockers, reads implicated files, and proposes 2–3 concrete unblock options via AskUserQuestion. No idea-shaping, no glossary curation, no ADR offers. Use when the user says "unblock <id>", "why is this blocked", "help with <id>", or invokes `/mars:unblock`.
---

# Mars: unblock a stuck task

A task is `status='blocked'` because the orchestrator hit something it
couldn't decide on its own — usually a question for the user, a missing
upstream task, or a decision that needs an ADR. Your job is to surface
**why** it's blocked, give the user enough context to decide, and then
execute their decision through the right `mars` verb.

You do **not** shape ideas, curate the glossary, or offer ADRs. If the
unblock decision turns out to need a new task, enqueue it and stop.

# Step 0 — No argument? Show the blocked list and stop.

If `$ARGUMENTS` is empty, the user doesn't yet know which task they want
to unblock. Run:

```bash
mars list blocked
```

Print the output verbatim (or a tight summary if it's long) and ask the
user which id to work on. Do not guess and do not pick one yourself.
Stop here until they reply with an id — then re-enter the skill with that
id as the argument.

If `mars list blocked` returns no rows, say so plainly ("nothing is
blocked right now") and stop.

# Step 1 — Load the task and its blockers

The argument is the task id. With an id in hand, run:

```bash
mars show <id>
mars blockers <id>
```

## 1a — Re-orient the user first

Before talking about blockers, give the user a **2–3 line recap** of what
this task was actually trying to do. The user may not remember — the task
might have been queued days ago, by another `/mars:next` session, or as a
prerequisite from a sibling task. Diving straight into blocker mechanics
without that context forces them to reconstruct the goal from raw fields.

Print the recap in plain prose, in this shape:

> *"Task `<id>` — `<one-line goal>`. It came from `<origin>` and was meant
> to `<observable outcome>`. The orchestrator stopped on it at `<step>`."*

Pull the goal from the task's prompt/title (the first sentence of the
prompt body usually carries it). Origin candidates: a parent idea
(`fromIdea: <idea-id>`), a sibling task that blocked it, or "user-queued
via `mars task add`". The step is whichever workflow stage flipped it to
blocked (`code`, `verify`, `merge`).

Keep it terse — three lines, no field dump. The user just needs enough to
remember why they cared. Then move on to the blockers.

## 1b — Load the blockers

`mars blockers <id>` lists the open blockers (sibling task ids or note
rows). For each blocker id, run `mars show <blocker-id>` so you see what
the blocker actually says. If a blocker references a file or symbol, read
the file so your proposals are grounded in the code rather than a guess.

Use `Read` and `Grep` for file inspection. (`mars context search/tree` is
referenced in older docs but isn't a current CLI verb — don't try it.)

# Step 2 — Decide the unblock options

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
  every blocker row; **the task itself does not auto-rerun** — `mars retry
  <id>` is the verb to put it back on the queue).
- **Remove only specific blocker edges.** Some blockers are real, others
  aren't. `mars unblock <id> <blocker-id> [<blocker-id> ...]` removes
  those specific edges and leaves status unchanged; the task will
  re-evaluate when its remaining blockers clear.

Phrase the options for `AskUserQuestion` in plain language (not "edge
removal" — say "the missing piece is already done elsewhere; clear the
specific blockers").

If you are sure the blocker is structural (e.g. needs a brand-new
prerequisite task), include the proposed `mars task add` prompt body in
the option's `description` so the user can sanity-check it before you
enqueue.

# Step 3 — Execute the chosen option

Run the corresponding `mars` verb. Verb signatures:

```bash
# Phantom recovery: clear ALL blocker rows, flip task to 'failed'.
# Use when none of the blockers were real. Follow with `mars retry <id>`
# if the user wants the task put back on the queue.
mars unblock <id>

# Edge removal: drop only the listed blocker edges; status unchanged.
# Use when some blockers are real and others aren't.
mars unblock <id> <blocker-id> [<blocker-id> ...]

# Add a new prerequisite task; the blocked task waits for it.
mars task add "<self-contained prompt body>"
mars block <blocked-task-id> <new-task-id>

# Re-queue a failed task (after phantom recovery).
mars retry <id>
```

After the verb runs, print one short confirmation line — what changed,
and (if relevant) what the user should expect next ("orchestrator will
pick up <new-id> automatically" or "<id> is back on the queue").

# What you do NOT do

- Do not call any `mars idea` write verb (`add`, `set`, `promote`, etc.).
  This skill operates on tasks, not ideas. If the unblock requires
  shaping a new feature, enqueue it as a `mars task add` prompt with
  enough self-contained context, or send the user to `/mars:next` for
  idea-shaping.
- Do not run `mars glossary set/remove` or `mars adr add`. Domain-language
  curation belongs to `mars:grill`.
- Do not invent flag combinations not shown above. If `mars unblock` or
  `mars retry` errors, surface stderr verbatim and ask the user how to
  proceed — do not retry blindly with different flags.
- Do not promote the resolved task into "done" by hand. The orchestrator
  owns task lifecycle once a task is queued/running.

# Argument

The user passed: `$ARGUMENTS`

If empty, go to **Step 0** (list blocked tasks and ask which one). If a
task id is present, start at **Step 1**.
