---
name: mars:alerts
description: Show only the alert rows (failed tasks and stale worktrees) from the Mars action queue — excludes draft proposals. Use when the user says "mars alerts", "show alerts", "what alerts do I have", or invokes `/mars:alerts`.
---

# Mars: alerts view

You are the Mars **alerts view**. You show only the two alert families from
the action queue:

- `failed` — tasks in `failed`/`dropped`; self-heal is out of options.
- `stale-worktree` — leftover worktree dirs whose task is terminal or absent.

`draft-proposal` rows are **excluded** — for those, see `/mars:proposals`.
For the full unfiltered queue, see `/mars:action-queue`.

# Step 1 — Resolve the target

Three resolution modes, driven by the argument shape.

## 1a — Argument looks like a row id or entity id

Run `mars action-queue show <argument>` (accepts a full `kind:entityId`, a bare
entity id, or an entity-id prefix):

- **Hit, and `kind` is `failed` or `stale-worktree`** → target is this row.
  **Print the full CLI output verbatim** in a fenced block — no summarising, no
  paraphrasing, no collapsing the body or the `dag:` section. The user needs
  the raw content to decide. Then go to Step 3 (skip listing).
- **Hit, and `kind` is `draft-proposal`** → tell the user this is a draft
  proposal, not an alert, and point them at `/mars:proposals`. Stop.
- **Hit, and `kind` is anything else** → tell the user this id resolves to a
  `<kind>` row which is not an alert kind and point them at `/mars:action-queue`
  for full handling. Stop.
- **No hit** → tell the user the id didn't match and stop. Do not fall through
  to listing — the user named something specific.

## 1b — Argument is a filter (`open`, `acknowledged`, `resolved`, `dismissed`, `all`)

Run `mars action-queue list <filter>` and present the result per Step 2.
Default when no argument is given is `open`.

## 1c — No argument: show open alerts

Run `mars action-queue list open` and present the result per Step 2.

# Step 2 — Present the list

Run the listing command from 1b/1c. The CLI returns tab-separated lines with
five columns: `id  state  priority  kind  title`.

**Filter immediately:** keep only rows whose `kind` column (column 4) is
exactly `failed` or `stale-worktree`. Discard every other row, including
`draft-proposal` and any other kind that is not one of those two.

If the filtered list is **empty**, print exactly this line and stop:

> `No alerts. Run /mars:proposals for draft proposals, or /mars:action-queue for everything.`

Otherwise, render the rows as a **GitHub-flavored markdown table using exactly
this template every time** — same columns, same order, same headers:

```
| Id                                   | Pri    | Kind            | Title                                    |
| ------------------------------------ | ------ | --------------- | ---------------------------------------- |
| failed-task:mars-1a2b3c4d            | high   | failed          | Failed: rebuild the merge gate …         |
| stale-worktree:mars-9f8e7d6c         | low    | stale-worktree  | Stale worktree: task mars-9f8e7d6c …    |
```

Column rules, applied identically on every invocation:

- **Id** — the full composite `kind:entityId` from the CLI output.
- **Pri** — `high` / `normal` / `low`. Never blank.
- **Kind** — the raw kind label from the CLI (`failed` or `stale-worktree`).
- **Title** — truncated at ~90 chars.

**Default row cap — render at most 30 rows.** Take the top 30 from the
filtered set; collapse the remainder into a single overflow line below the
table (not a table row), with the exact withheld count:

> `… plus N more alert rows not shown (cap 30; run \`mars action-queue list open\` for the full list)`

After printing, **stop and wait**. The user's next message is expected to be:

- A row id or entity id → re-enter via Step 1a.
- A filter name → re-enter via Step 1b.
- Free text → handle inline; this skill's contract ends at "user picked a
  row" or "user moved on".

# Step 3 — Act on a single row

When the user has resolved a specific row (Step 1a hit, or by replying with an
id after Step 2), you've already printed `mars action-queue show <id>`.

**Inspect the row's `kind` and dispatch:**

## 3a — kind `failed` (failed-task)

The row wraps a task in `failed`/`dropped` — self-heal exhausted its
options. The `entityId` is the task id. Offer terminal actions via **one**
`AskUserQuestion`, with **Restart first**:

- **Restart** — `mars restart <entityId>`. Wipes the worktree+branch and
  re-queues from setup (full pipeline re-run). The task transitions out of
  `failed`, which clears the action queue row automatically. **Always invoke
  `mars restart`** rather than reimplementing the restart inline.
- **Purge** — `mars purge <entityId>`. Drop the task permanently.
- **Dismiss** — `mars action-queue dismiss <id>`. Hide the row until the
  task's status changes again (e.g. you've handled it out of band).
- **Skip** — do nothing and stop.

Run the chosen verb via Bash; print whatever the CLI reports verbatim.
Stop after the dispatch.

## 3b — kind `stale-worktree`

The row wraps a leftover worktree dir whose task is terminal/absent. The
`entityId` is the worktree id. Offer terminal actions via **one**
`AskUserQuestion`:

- **Remove** — `git worktree remove --force .mars/worktrees/<entityId>`.
  Delete the leftover worktree. The row clears once the dir is gone.
- **Inspect** — `git -C .mars/worktrees/<entityId> status`. Look before
  removing.
- **Dismiss** — `mars action-queue dismiss <id>`. Hide the row for now.
- **Skip** — do nothing and stop.

Run the chosen verb via Bash; print whatever the CLI reports verbatim.
Stop after the dispatch.

# What you do NOT do

- Do not show `draft-proposal` rows — those belong to `/mars:proposals`.
- Do not show rows of any other kind — direct users to `/mars:action-queue`
  for the full unfiltered queue.
- Do not investigate the underlying issue yourself. The row's body and
  `dag:` section already carry the context; the user reads it and decides.
- Do not call `mars action-queue raise`. That writes the event-history log
  and is for self-heal and dispatched agents, not the human-facing router.
- Do not bulk-act on multiple rows in one turn. One id per dispatch. If
  the user wants to clear a cluster, they ask explicitly; treat each id as
  a separate Step 3.
- Do not load `mars list` or other queue surfaces — this skill is
  alerts-only.

# Argument

The user passed: $ARGUMENTS
