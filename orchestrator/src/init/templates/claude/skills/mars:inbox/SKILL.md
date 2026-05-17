---
name: mars:inbox
description: Show Mars inbox items only (drafts are excluded) and resolve one item at the user's direction. If the inbox is empty, point the user at `/mars:drafts` and stop. Use when the user says "mars inbox", "show my inbox", "what's in the inbox", or invokes `/mars:inbox`.
---

# Mars: inbox router

You are the Mars **inbox router**. Your job is strictly inbox items —
listing them and letting the user pick one. For an inbox **item**, you
then investigate the root cause and propose a concrete correction — the
default action is enqueuing a fix via `mars task add` — while
`ack` / `resolve` / `dismiss` remain available. You never edit `main`
directly to apply a fix: corrections route through the orchestrator
per the project Routing rules. A direct edit on `main` is a last
resort that requires the user to explicitly opt in *for this specific
change*, stated out loud before any `Edit`/`Write`; a prior
session-level opt-in does not carry over.

Drafts live in their own skill: `/mars:drafts`. If a draft surfaces in
this skill (via the id-redirect path in Step 1a, or as a row in the raw
`mars inbox list` output in Step 2), point the user at `/mars:drafts`
and stop.

# Step 1 — Resolve the target

Three resolution modes, driven by the argument shape.

## 1a — Argument looks like an id (8-hex prefix or full id)

Run `mars inbox show <argument>`:

- **Hit** → target is this item. **Print the full CLI output
  verbatim** in a fenced block — no summarising, no paraphrasing, no
  collapsing the `Last error` excerpt or the `payload`/`context`/`history`
  sections. The user needs the raw content to decide. Then go to
  Step 3 (skip listing).
- **Draft redirect** (`mars inbox show` exits 1 with "is a draft idea,
  not an inbox item …") → the id belongs to a draft. This skill does
  not handle drafts. Print one line:

  > `<id> is a draft idea. Use /mars:drafts <id> to view or refine it.`

  Then stop. Do not call `mars idea show`, do not offer draft actions,
  do not fall through to listing.
- **No hit** → tell the user the id didn't match and stop. Do not
  fall through to listing — the user named something specific.

## 1b — Argument is a state filter (`open`, `acknowledged`, `resolved`, `dismissed`, `all`)

Run `mars inbox list <state>` and present the result per Step 2.
Default state when no argument is given is `open`.

## 1c — No argument: show open items

Run `mars inbox list open` and present the result per Step 2.

# Step 2 — Present the list (inbox rows only)

Run the listing command from 1b/1c, then **drop every row whose `kind`
column starts with `draft(`** before rendering. The CLI mixes drafts
into `inbox list` output for state=`open|all|dismissed`; this skill
does not surface them.

If after filtering there are **no inbox rows left**, print exactly one
line and stop:

> `Inbox is empty. Try /mars:drafts to refine a draft idea.`

Do not list drafts, do not offer a menu, do not run any other command.

Otherwise, print the remaining inbox rows directly to the user — **no
`AskUserQuestion` menu**. Group and order them for skim-ability:

1. Grouped by priority (high → normal → low).
2. Within a priority, order by `seen_count` descending (recurring pain
   first), then most-recent `last_seen_at`.
3. For each row show: 8-hex id, priority, seen_count (`×N` only when
   N > 1), kind summary, message. Truncate the message at ~90 chars
   if needed.

Render the items as a **GitHub-flavored markdown table using exactly
this template every time** — same columns, same order, same headers,
regardless of which resolution mode (1b/1c) led here or how many rows
there are:

```
| Id       | Pri    | Seen | Kind                   | Message                                  |
| -------- | ------ | ---- | ---------------------- | ---------------------------------------- |
| 1a2b3c4d | high   | ×3   | recovery-failed(merge) | Fast-forward into main rejected; …       |
| 9f8e7d6c | normal |      | stale-worktree         | Worktree for task/55 has no live run     |
```

Column rules, applied identically on every invocation:

- **Id** — 8-hex prefix.
- **Pri** — `high` / `normal` / `low`. Never blank.
- **Seen** — `×N` only when N > 1; otherwise leave the cell empty.
- **Kind** — the kind summary (with its `(...)` qualifier if present).
- **Message** — truncated at ~90 chars.

If items naturally cluster by `kind` prefix (e.g. many
`recovery-failed(...)` or `stale-worktree(...)` rows), collapse the
cluster into one summary line **below the table** (not as a table row):

> `… plus 12 more stale-worktree items (use mars inbox list to expand)`

After printing, **stop and wait**. Do not ask a follow-up question.
The user's next message is expected to be one of:

- An id (or 8-hex prefix) → re-enter this skill via Step 1a.
- A state name → re-enter via Step 1b.
- Free text describing what they want to do next → handle inline; this
  skill's contract ends at "user picked an item" or "user moved on".

# Step 3 — Act on a single inbox item

When the user has resolved a specific inbox item (Step 1a hit, or by
replying with an id after Step 2), you've already printed `mars inbox
show <id>` verbatim. Now:

1. **Investigate the root cause.** Read the implicated files and
   symptoms the item points at and form a diagnosis. Use `mars context
   search` / `mars context tree` and `Read` as needed. Keep it
   bounded — this is a diagnosis, not a rebuild. The orchestrator's
   read-span watcher is not in play for an interactive skill session,
   but stay focused: a few targeted reads, then conclude.
2. **Present the diagnosis** to the user in prose: what's actually
   wrong + the suggested correction (with trade-offs if there are
   alternatives).
3. **Offer the five actions via one `AskUserQuestion`**, in this
   order:

   - **Fix it (enqueue)** — default/recommended. Compose a standalone
     `mars task add "..."` prompt for the diagnosed fix following the
     CLAUDE.md "Loose ends" task-prompt contract: file path(s) +
     symptom, suggested fix (with trade-offs if alternatives),
     verification command(s), and a closing **"Save your work."**
     line. After enqueuing, also resolve the inbox item:
     `mars inbox resolve <id> --note "fix enqueued as <new-task-id>" --root-cause "<one-line cause>"`.
     Print both CLI outputs verbatim.
   - **Acknowledge** — `mars inbox ack <id>`. Read it, defer the fix;
     keeps the item out of the open list but the underlying cause is
     not fixed yet.
   - **Resolve** — `mars inbox resolve <id> [--note <text>] [--root-cause <text>]`.
     Use when the underlying cause is already fixed (or known
     harmless). Ask the user for an optional one-line note +
     root-cause; pass them only if non-empty.
   - **Dismiss** — `mars inbox dismiss <id> [--note <text>]`. Use
     when the item is noise / a false positive. Ask the user for an
     optional one-line note.
   - **Skip** — do nothing and stop.

4. Run the chosen verb(s) via Bash; print whatever the CLI reports
   verbatim. Stop after the dispatch.

# What you do NOT do

- Do not show, list, or act on drafts. Drafts go to `/mars:drafts`.
- Do not edit `main` directly to apply a fix. Corrections route
  through `mars task add` per the project Routing rules; a direct
  edit on `main` is a last resort that requires the user to
  explicitly opt in *for this specific change*, stated out loud
  before any `Edit`/`Write`. A prior session-level opt-in does not
  carry over.
- Do not call `mars inbox raise`. That's for self-heal and dispatched
  agents, not for the human-facing router.
- Do not bulk-act on multiple items in one turn. One id per dispatch.
  If the user wants to clear a cluster, they ask explicitly; treat
  each id as a separate Step 3.
- Do not browse `mars list` or other queue surfaces — this skill is
  inbox-only. Composing and enqueuing a `mars task add` for the
  picked item is allowed (that's the Fix-it action); browsing the
  queue is not.

# Argument

The user passed: `$ARGUMENTS`
