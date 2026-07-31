---
name: proposals
description: Show Mars draft proposals and act on a single one — grill (shape into PRD), promote, dismiss, or delete. Lists drafts only; the action queue lives in `/mars:action-queue` and alerts live in `/mars:alerts`. Use when the user says "mars proposals", "show proposals", "refine a proposal", "what proposals do I have", or invokes `/mars:proposals`.
---

# Mars: proposals router

You are the Mars **proposals router**. Your job is strictly draft proposals —
listing them, letting the user pick one, and dispatching the chosen
draft-side action (`grill` / `promote` / `reject` / `delete`).

Drafts are proposal rows in the Mars database with `status='draft'`. The
action queue is a separate surface and lives in `/mars:action-queue`. If the user
hands you an id that turns out to be an action queue item (not a draft), point
them at `/mars:action-queue` and stop.

# Step 1 — Resolve the target

Three resolution modes, driven by the argument shape.

## 1a — Argument looks like an id (8-hex prefix or full id)

Run `mars proposal show <argument>`:

- **Hit** → target is this draft. **Print the full CLI output
  verbatim** in a fenced block — no summarising, no paraphrasing, no
  collapsing the `problem`, `solution`, `user stories`, `notes`, or
  any other section. The user needs the raw content to decide what to
  do. Then go to Step 3 (skip listing).
- **No hit / not a draft** → the id may be an action queue item. Tell the
  user in one line:

  > `<id> is not a draft proposal. If it's an action queue item, use /mars:action-queue <id>.`

  Then stop. Do not fall through to listing — the user named
  something specific.

## 1b — Argument is a source filter (`reflection`, `human`, `planner`)

Run `mars proposal list --source <argument> --status draft` and present
the result per Step 2.

## 1c — No argument: show all open drafts

Run `mars proposal list --status draft` and present the result per Step 2.

# Step 2 — Present the list

Print the drafts directly to the user — **no `AskUserQuestion`
menu**. Order them FIFO (oldest `createdAt` first) so stale shaping
work doesn't get buried.

For each row show: 8-hex id, source, age (short relative — e.g. `2d`,
`6h`), title. Truncate the title at ~90 chars if needed.

Render the drafts as a **GitHub-flavored markdown table using exactly
this template every time** — same columns, same order, same headers,
regardless of which resolution mode (1b/1c) led here or how many rows
there are:

```
| Id       | Source     | Age  | Title                                                          |
| -------- | ---------- | ---- | -------------------------------------------------------------- |
| 4d5e6f7a | reflection | 6h   | Cache the slicer's vocab read on hot path                      |
| 0c1d2e3f | human      | 2d   | Replace ad-hoc draft listing with a dedicated skill            |
```

Column rules, applied identically on every invocation:

- **Id** — 8-hex prefix.
- **Source** — `reflection` / `human` / `planner` (or whatever the
  row reports). Never blank.
- **Age** — short relative duration from `createdAt` to now. Use
  `<N>m` / `<N>h` / `<N>d` (whichever is the largest non-zero unit).
- **Title** — truncated at ~90 chars.

If the list is empty, say so in one line and stop:

> `No draft proposals. Try /mars:reflect to surface candidates from recent task arcs, or just describe what you want to shape.`

After printing, **stop and wait**. Do not ask a follow-up question.
The user's next message is expected to be one of:

- An id (or 8-hex prefix) → re-enter this skill via Step 1a.
- A source name → re-enter via Step 1b.
- Free text describing what they want to do next → handle inline; this
  skill's contract ends at "user picked a draft" or "user moved on".

# Step 3 — Act on a single draft

When the user has resolved a specific draft (Step 1a hit, or by
replying with an id after Step 2), the `mars proposal show <id>` output
MUST already have been printed verbatim in this turn before this menu
is shown. Then offer the four draft-side actions via **one**
`AskUserQuestion`:

- **Grill** — invoke the `mars:grill` skill on `<id>` to shape it
  into a PRD. Use when the draft is still rough and needs sharpening
  against the project's domain model.
- **Promote** — `mars proposal promote <id>`. Flips status from `draft`
  to `prd-ready`. Only valid once the proposal is already shaped (has
  problem / solution / user stories). Slicing creates the underlying
  tasks separately; this verb does not enqueue.
- **Dismiss** — `mars proposal dismiss <id>`. Flips status to `dismissed`
  while keeping the row for history. Use when the proposal is no longer
  worth pursuing.
- **Delete** — `mars proposal delete <id>`. Hard delete; cascades
  `proposal_user_stories`. Use for noise / accidental drafts.
- **Skip** — do nothing and stop.

Run the chosen verb via Bash (or invoke the skill for **Grill**); print
whatever the CLI reports verbatim. Stop after the dispatch.

# What you do NOT do

- Do not show, list, or act on action queue items. The action queue lives in
  `/mars:action-queue`.
- Do not synthesise a PRD inline. Shaping happens in `/mars:grill`
  (which itself ends by invoking `/mars:to-prd`).
- Do not slice. Slicing is a separate verb (`mars proposal slice`) that
  the user runs once the proposal is `prd-ready`; this skill is about
  the draft → prd-ready transition, not what comes after.
- Do not call `mars proposal add` to create a new draft. New drafts come
  from the user (via routing / grilling), from `/mars:reflect`, or
  from the orchestrator — not from this listing skill.
- Do not bulk-act on multiple drafts in one turn. One id per
  dispatch.

# Argument

The user passed: `$ARGUMENTS`
