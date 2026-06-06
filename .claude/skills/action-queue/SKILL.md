---
name: action-queue
description: Show the Mars action queue — the per-slice state view of everything that needs a human — and act on one row at the user's direction. Use when the user says "mars action-queue", "show my action queue", "what's in the action queue", or invokes `/mars:action-queue`.
---

# Mars: action queue router

You are the Mars **action queue router**. The action queue is a **per-slice state
view**, not an event log: one row per real thing that currently needs a
human, computed on demand from the live `tasks` / `proposals` tables and
the worktrees on disk. A row appears the moment its entity enters a stuck
state and disappears the moment it leaves — there is no ack/resolve
bookkeeping. Your job is to list the rows, let the user pick one, and
dispatch to the right sub-skill or terminal action.

There are exactly four row kinds:

- `failed-task` — a task in `failed`/`dropped`; self-heal is out of options.
- `blocked-task` — a task waiting on one or more blockers.
- `stale-worktree` — a worktree dir on disk whose task is terminal or
  absent (a finished task should have removed its own worktree).
- `draft-proposal` — a draft proposal awaiting shaping.

Each row's `id` is a stable composite `kind:entityId` (e.g.
`failed-task:mars-abc12345`, `stale-worktree:mars-abc12345`,
`draft-proposal:p-xyz`). The row has no identity of its own — it *is* the
entity's current state.

# Step 1 — Resolve the target

Three resolution modes, driven by the argument shape.

## 1a — Argument looks like a row id or entity id

Run `mars action-queue show <argument>` (accepts a full `kind:entityId`, a bare
entity id, or an entity-id prefix):

- **Hit** → target is this row. **Print the full CLI output verbatim**
  in a fenced block — no summarising, no paraphrasing, no collapsing the
  body or the `dag:` section. The user needs the raw content to decide.
  Then go to Step 3 (skip listing).
- **No hit** → tell the user the id didn't match and stop. Do not fall
  through to listing — the user named something specific.

## 1b — Argument is a filter (`open`, `all`)

Run `mars action-queue list <filter>` and present the result per Step 2.
Default when no argument is given is `open`.

## 1c — No argument: show open rows

Run `mars action-queue list open` and present the result per Step 2.

# Step 2 — Present the list

Run the listing command from 1b/1c. Each line is tab-separated:
`id  state  priority  kind  title`, where `state` is `open`.

If there are **no rows**, print exactly one line and stop:

> `Action queue is empty.`

Otherwise, print the rows directly to the user — **no `AskUserQuestion`
menu**. Group and order them for skim-ability:

1. Grouped by priority (high → normal → low). `failed-task` is high,
   `blocked-task` is normal, `stale-worktree` and `draft-proposal` are low.
2. Within a priority, most-recent first (the CLI already sorts this way).

**Default row cap — render at most 30 rows.** Action queue volume routinely
runs into the hundreds, so the cap is enforced *here*, not by the
command. Take the top 30; collapse the remainder into a single overflow
line below the table (see below). If the user wants the full list they
can run `mars action-queue list <filter>` themselves.

Render the rows as a **GitHub-flavored markdown table using exactly this
template every time** — same columns, same order, same headers:

```
| Id                          | Pri    | Kind           | Title                                    |
| --------------------------- | ------ | -------------- | ---------------------------------------- |
| failed-task:mars-1a2b3c4d   | high   | failed-task    | Failed: rebuild the merge gate …         |
| blocked-task:mars-9f8e7d6c  | normal | blocked-task   | Blocked: sweep auto-prime references …   |
```

Column rules, applied identically on every invocation:

- **Id** — the full composite `kind:entityId`.
- **Pri** — `high` / `normal` / `low`. Never blank.
- **Kind** — one of the four derived kinds.
- **Title** — truncated at ~90 chars.

Whenever rows are withheld — either the 30-row cap fired or rows cluster
heavily by `kind` — collapse the remainder into **one** summary line
**below the table** (not a table row), with the exact withheld count:

> `… plus 82 more open rows not shown (cap 30; run \`mars action-queue list open\` for the full list)`

When the overflow is one dominant `kind`, name it:

> `… plus 119 more blocked-task rows (run \`mars action-queue list\` to expand)`

After printing, **stop and wait**. The user's next message is expected to
be one of:

- A row id or entity id → re-enter via Step 1a.
- A filter name → re-enter via Step 1b.
- Free text → handle inline; this skill's contract ends at "user picked a
  row" or "user moved on".

# Step 3 — Act on a single row

When the user has resolved a specific row (Step 1a hit, or by replying
with an id after Step 2), you've already printed `mars action-queue show <id>`.

**Inspect the row's `kind` and dispatch:**

## 3a — kind `blocked-task`

The row wraps a blocked task. The `entityId` is the task id. Invoke the
unblock sub-skill:

```
Skill({ skill: "mars:unblock", args: "<entityId>" })
```

The unblock skill owns the interaction; stop here once you've invoked it.
The action queue row clears itself when the task leaves `blocked` — no separate
action queue call is needed.

## 3b — kind `draft-proposal`

The row wraps a draft proposal awaiting shaping. The `entityId` is the
proposal id. Invoke the grill sub-skill:

```
Skill({ skill: "mars:grill", args: "<entityId>" })
```

The grill skill (and subsequently `mars:to-prd`) owns the interaction.
The row clears when the proposal leaves `draft`.

## 3c — kind `failed-task`

The row wraps a task in `failed`/`dropped` — self-heal exhausted its
options. The `entityId` is the task id.

**First, diagnose.** Before offering any terminal action, invoke the
diagnoser so the operator sees *what the task was trying to do* and *why
it failed* — the same arc-walk a human would do by hand (origin →
recovery, prompts, failure signatures, whether the fix already landed on
`main`):

```
Skill({ skill: "mars:diagnose", args: "<entityId>" })
```

Let the diagnosis print in full. It is read-only and recommends but does
not execute — its **Recommendation** line tells you which verb is likely
right. THEN offer the terminal actions via **one** `AskUserQuestion`, with
**Restart first** (lead with whichever verb the diagnosis recommended if
it differs):

- **Restart** — `mars restart <entityId>`. Wipes the worktree+branch and
  re-queues from setup (full pipeline re-run). The task transitions out
  of `failed`, which clears the action queue row automatically. **Always invoke
  `mars restart`** rather than reimplementing the restart inline.
- **Purge** — `mars purge <entityId>`. Drop the task permanently.
- **Skip** — do nothing and stop.

Run the chosen verb via Bash; print whatever the CLI reports verbatim.
Stop after the dispatch.

## 3d — kind `stale-worktree`

The row wraps a leftover worktree dir whose task is terminal/absent. The
`entityId` is the worktree id. Offer the terminal actions via **one**
`AskUserQuestion`:

- **Remove** — `git worktree remove --force .mars/worktrees/<entityId>`.
  Delete the leftover worktree. The row clears once the dir is gone.
- **Inspect** — `git -C .mars/worktrees/<entityId> status`. Look before
  removing.
- **Skip** — do nothing and stop.

Run the chosen verb via Bash; print whatever the CLI reports verbatim.
Stop after the dispatch.

# What you do NOT do

- Do not investigate the underlying issue *inline yourself*. For a
  `failed-task` row, delegate the investigation to `/mars:diagnose` (Step
  3c) — it owns the arc-walk and prints the structured diagnosis. You do
  not re-derive it by hand, and you never edit/restart/purge based on your
  own ad-hoc poking. For the other row kinds, the row's body and `dag:`
  section already carry the context; the user reads it and decides.
- Do not call `mars action-queue raise`. That writes the event-history log and is
  for self-heal and dispatched agents, not the human-facing router.
- Do not bulk-act on multiple rows in one turn. One id per dispatch. If
  the user wants to clear a cluster, they ask explicitly; treat each id as
  a separate Step 3.
- Do not load `mars list` or other queue surfaces — this skill is
  action queue-only.

# Argument

The user passed: `$ARGUMENTS`
