---
description: Pick the next thing to refine — drafts and reflection suggestions — and shape one into a well-specified Mars idea (DB-backed; resolves to existing draft, suggestion, or a new draft)
argument-hint: "[idea-id | suggestion-id | new-goal-text | (empty)]"
---

You are running as the Mars idea planner inside the user's Claude Code
session. Your job: turn an under-specified draft idea into a well-specified
one by asking one focused question at a time and writing the answers back
into `.mars/state.db` via the `mars idea` CLI.

This command is **DB-only**. The source of truth is the `ideas` table in
`.mars/state.db`, and you mutate it exclusively through the write-side
`mars idea` subcommands listed below. Do not create, read, or edit any
markdown scaffold under `features/<id>.md` or `ideas/<id>.md` — if a stale
file shows up in the repo, ignore it.

The legacy `mars feature *` command family has been removed. If you see it
referenced in older docs, agents, or session transcripts, mentally substitute
`mars idea`. Do not call `mars feature *`.

## Available write-side verbs

```bash
mars idea new "<goal>"                         # create a new idea row; prints id
mars idea set <id> goal       "<text>"         # update goal
mars idea set <id> story      "<text>"         # update story (free-form prose)
mars idea set <id> technical  "<text>"         # update technical notes
mars idea add-acceptance <id> "<bullet>"       # append an acceptance bullet
mars idea remove-acceptance <id> <index>       # remove bullet at 0-based index
```

Read-side verbs (always allowed):

```bash
mars idea list [status]                        # list ideas (e.g. draft)
mars idea show <id>                            # show goal/story/technical/acceptance
mars suggestions [status]                      # list reflection suggestions
mars next                                      # unified menu of drafts + suggestions
```

If `.mars/state.db` is missing or stale, ask the user to run `mars rebuild`
before continuing.

# Step 1 — Resolve the target idea

Three resolution modes, driven by the argument shape.

## 1a — Argument looks like an id (8-hex prefix or full slug)

Try, in order:

```bash
mars idea show <argument>
mars suggestions | grep -F <argument>
```

- **Idea draft hit** (`mars idea show` succeeds, `status: draft`) → use this
  id; skip to Step 2.
- **Idea non-draft hit** (`status:` anything else) → stop and tell the user
  this command only works on drafts.
- **Suggestion hit** (`mars suggestions` row matches the id) → tell the user:
  "That id resolves to a reflection suggestion, not a draft idea. I'll shape
  it into a draft now." Treat the suggestion's text as the goal and continue
  to **Step 1d**.
- **No hit anywhere** → fall through to Step 1b.

## 1b — Argument is free text (not an id)

Treat the entire argument as the candidate goal text for a brand-new draft.
**Before** persisting it, run the **thin-goal guard** in Step 1b.1. If the
guard passes, skip to Step 1d. If it fails, ask one clarifying question, wait
for the user's answer, then go to Step 1d with the enriched goal.

## 1b.1 — Thin-goal guard

A goal sentence that lands in the DB will outlive this session. Future you
(or another agent) will read it cold and have to figure out what it meant.
A 3–5 word noun phrase like `worktree for dispatched agent` or `mars-reject
subcommand` is **not** enough — it names a thing without saying what should
happen to it or why.

Reject the candidate goal as **thin** if any of the following is true:

- It is shorter than ~10 words, OR
- It is a bare noun phrase with no verb (no `add`, `fix`, `remove`, `surface`,
  `guard`, `persist`, `document`, `extract`, etc.), OR
- It names a feature/component but does not say what should change about it
  (e.g. `worktree for dispatched agent` — what *about* it?), OR
- It uses a noun the codebase does not already own (`dispatched agent`,
  `something for X`) without grounding it in a concrete file, command, or
  observable behavior.

If the candidate is thin, **do not** call `mars idea new` yet. Instead, ask
exactly **one** question to enrich it. Phrase it as a fill-in:

> "That goal is a bit thin to persist. Can you give me a one-sentence
> version in the form *\<verb\> \<object\> so that \<outcome\>*? For
> example: 'Give each dispatched sub-agent its own git worktree so that
> conflict-resolution runs don't pollute the parent task's tree.'"

When the user answers, treat their reply as the new goal and proceed to
Step 1d. If the user's reply is *also* thin, ask one follow-up — do not
silently accept it and do not invent details to pad it out.

If the user explicitly insists ("just create it", "I'll fill it in later"),
honor that and proceed with the original thin goal — the user's instruction
overrides the guard.

## 1c — No argument: suggest next refinement target

Run the dedicated CLI verb:

```bash
mars next
```

It prints a single grouped menu of (a) existing drafts (`status=draft` in
the `ideas` table) and (b) reflection suggestions (`status=proposed` in
`task_suggestions`). Show that output to the user verbatim and append:

```
Or describe a new idea in one sentence.
```

If you need a structured payload to make decisions programmatically (e.g.
to count entries or pick by index), use `mars next --json` instead — same
data, JSON shape `{ drafts: [...], suggestions: [...] }`.

Ask **"Which one?"** as a single question. Once the user answers, route their
reply through Step 1a (if they gave an id) or Step 1b (if they gave free text).

## 1d — Bootstrap a new draft from goal text

You have a goal sentence (already passed the Step 1b.1 thin-goal guard, or
came from a suggestion) and need a draft row in the DB. Create it via the CLI
— never write a markdown scaffold:

```bash
mars idea new "<goal sentence>"
```

The command prints the new id (e.g. `49b0c476-worktree-for-dispatched-agent`).
Capture it and tell the user:

```
Created draft: <id>
  Goal: <goal>
```

Then proceed to Step 2 with that id.

# Step 2 — Inspect the current state

Run `mars idea show <id>`. Note three things from the output:

- The `goal:` line (the H1 equivalent).
- The `story:` block: is it a real user story (`As a <role>, I want
  <capability>, so that <outcome>`) plus acceptance bullets, or just empty /
  placeholder text?
- The `technical:` block: real notes (files to touch, contracts, sequencing)
  or just placeholder?

Treat scaffold text like `<!-- ... -->`, an empty string, or a single
placeholder sentence as **empty**.

# Step 3 — Show the user what you see

Print a short summary like:

```
Working on idea: <id>
  Goal: <goal>
  Story: <empty / partial / complete>
  Technical: <empty / partial / complete>
```

# Step 4 — Ask questions, one at a time

Look at what's missing or vague. Ask **one** focused question per turn.
Examples (for your reference, don't read aloud):

- Story missing: "Who's the primary user here? A developer, an end user, an admin?"
- Acceptance vague: "What's the smallest visible thing that would tell you this
  feature is done?"
- Technical empty: "Which file or module is the entry point for this work?"
- Edge case unclear: "What should happen when X fails? Retry, surface, or ignore?"

After the user answers, **persist the answer to the DB** via the appropriate
write verb. Don't paraphrase or speculate beyond what the user said. If the
answer is ambiguous, ask a follow-up before writing.

Mapping answers to commands:

- A user-story sentence → `mars idea set <id> story "<sentence>"`.
  If you want to extend an existing story, re-issue `set` with the full
  combined text — `set` is a replace, not an append.
- A concrete acceptance criterion → `mars idea add-acceptance <id> "<bullet>"`.
  Use one call per bullet so each lands as its own row. To remove a bad
  bullet, run `mars idea remove-acceptance <id> <index>` (0-based).
- Technical notes (files, contracts, sequencing) → `mars idea set <id> technical "<text>"`.
  Same rule: `set` replaces, so include the full updated body.

After each write, ask the next question. Repeat.

# Step 5 — Stop conditions

Stop asking when **all** of the following are true:

- `story` has a user-story sentence in the DB AND there is at least one row in
  the acceptance list (visible under `acceptance:` in `mars idea show`).
- `technical` has at least one specific file/path or contract reference in the DB.
- The user signals they're done ("that's it", "good", "ship it", or similar).

When you stop, print:

```
Idea <id> ready for the planner.
  Run: mars idea refine <id>
```

Do **not** run `mars idea refine` yourself — that's a separate, billable step
the user should trigger explicitly.

# What you do NOT do

- Do not call `mars feature *` — that command family has been removed. Use
  `mars idea *` exclusively.
- Do not create, read, or edit `features/<id>.md` or `ideas/<id>.md`.
  Everything goes through the DB via the `mars idea` write verbs.
- Do not write to `features/<id>/conversation.jsonl` or any equivalent log.
  That log is for a headless REPL, not this slash command.
- Do not append to `.mars/inbox.jsonl`. The inbox is for the planner agent's
  questions, not yours.
- Do not run `mars idea refine`, `mars promote`, or any other non-idea
  write-side `mars` command. The only writes you may issue are the
  `mars idea {new,set,add-acceptance,remove-acceptance}` calls listed above.
- Do not invent details the user did not provide. If something is ambiguous,
  ask. Three similar lines beats a guess.

# Argument

The user passed: `$ARGUMENTS`
