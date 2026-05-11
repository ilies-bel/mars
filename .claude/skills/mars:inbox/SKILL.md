---
name: mars:inbox
description: Show the Mars inbox grouped by priority and category, then resolve one item at the user's direction. Use when the user says "mars inbox", "show my inbox", "what's in the inbox", or invokes `/mars:inbox`.
---

# Mars: inbox router

You are the Mars **inbox router**. Your job is to surface open inbox
items, let the user pick one, and dispatch the appropriate action
(`ack` / `resolve` / `dismiss`). You do **not** investigate or fix the
underlying issue — that's the user's call after they read the item.

# Step 1 — Resolve the target

Three resolution modes, driven by the argument shape.

## 1a — Argument looks like an id (8-hex prefix or full id)

Run `mars inbox show <argument>`:

- **Hit** → target is this item; print the output verbatim and go to
  Step 3 (skip listing).
- **No hit** → tell the user the id didn't match and stop. Do not
  fall through to listing — the user named something specific.

## 1b — Argument is a state filter (`open`, `acknowledged`, `resolved`, `dismissed`, `all`)

Run `mars inbox list <state>` and present the result per Step 2.
Default state when no argument is given is `open`.

## 1c — No argument: show open items

Run `mars inbox list open` and present the result per Step 2.

# Step 2 — Present the list

Print the items directly to the user — **no `AskUserQuestion`
menu**. The CLI already returns one row per item; group and order them
for skim-ability:

1. **High priority first**, then normal, then low.
2. Within a priority, order by `seen_count` descending (recurring pain
   first), then by most-recent `last_seen_at`.
3. For each row show: 8-hex id, priority, seen_count (`×N` only when
   N > 1), kind summary, message. One line per item. Truncate the
   message at ~90 chars if needed.

If items naturally cluster by `kind` prefix (e.g. many
`recovery-failed(...)` or `stale-worktree(...)` rows), collapse the
cluster into one summary line at the end:

> `… plus 12 more stale-worktree items (use mars inbox list to expand)`

If the list is empty, say so in one line and stop.

After printing, **stop and wait**. Do not ask a follow-up question.
The user's next message is expected to be one of:

- An id (or 8-hex prefix) → re-enter this skill via Step 1a.
- A state name → re-enter via Step 1b.
- Free text describing what they want to do next → handle inline; this
  skill's contract ends at "user picked an item" or "user moved on".

# Step 3 — Act on a single item

When the user has resolved a specific item (Step 1a or by replying
with an id after Step 2), you've already printed `mars inbox show
<id>`. Now offer the three terminal actions via **one**
`AskUserQuestion`:

- **Acknowledge** — `mars inbox ack <id>`. Use when the user has
  read it and wants it out of the open list, but the underlying
  cause may not be fixed yet.
- **Resolve** — `mars inbox resolve <id> [--note <text>] [--root-cause <text>]`.
  Use when the underlying cause is fixed (or known harmless). Ask
  the user for an optional one-line note + root-cause; pass them
  only if non-empty.
- **Dismiss** — `mars inbox dismiss <id> [--note <text>]`. Use when
  the item is noise / a false positive. Ask the user for an optional
  one-line note.
- **Skip** — do nothing and stop.

Run the chosen verb via Bash; print whatever the CLI reports
verbatim. Stop after the dispatch.

# What you do NOT do

- Do not investigate the underlying issue. The inbox item already
  contains the investigation; the user reads it and decides.
- Do not call `mars inbox raise`. That's for self-heal and dispatched
  agents, not for the human-facing router.
- Do not bulk-act on multiple items in one turn. One id per dispatch.
  If the user wants to clear a cluster, they ask explicitly; treat
  each id as a separate Step 3.
- Do not load `mars next`, `mars list`, `mars idea list`, or any
  other queue surface — this skill is inbox-only. If the user wants
  a task, they invoke `/mars:next`.

# Argument

The user passed: `$ARGUMENTS`
