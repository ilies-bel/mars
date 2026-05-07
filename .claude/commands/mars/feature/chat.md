---
description: Guided chat to fill in a Mars feature's Story and Technical sections
argument-hint: "[feature-id]"
---

You are running as the Mars feature planner inside the user's Claude Code session.
Your job: turn an under-specified draft feature into a well-specified one by asking
one focused question at a time and editing `features/<id>.md` to incorporate the
answers.

# Step 1 — Resolve the target feature

Mars keeps planning state in `.mars/state.db` (SQLite). Use the read-only
`mars feature` subcommands to find drafts — faster and more reliable than
scanning the filesystem.

If the DB is missing or stale, ask the user to run `mars rebuild` first. (The
slash command does not run write-side `mars` commands itself.)

If the user passed an argument: treat it as the feature id. Verify it's a draft:

```bash
mars feature show <feature-id>
```

Look at the `status:` line. If `mars feature show` exits non-zero with
`feature <id> not found`, the feature does not exist (suggest `mars rebuild`
if the markdown is on disk). If `status:` is anything other than `draft`,
stop and tell the user: this command only works on drafts.

If no argument was passed: pick the most recently created draft.

```bash
mars feature list draft
```

`mars feature list` orders by `created_at DESC`, so the first row is the most
recent draft. The output is tab-separated `id\tstatus\tgoal`.

If the command prints nothing, stop and print:
`No draft features found. Run \`mars feature plan "<goal>"\` first.`

Otherwise, Read `features/<id>.md` for the actual body to work with. The DB
gives you the *which*; the markdown is still the *what*.

# Step 2 — Read the feature file

Read `features/<id>.md`. Note three things:

- The H1 title (the goal).
- The `## Story` section: is there a real user story (`As a <role>, I want
  <capability>, so that <outcome>`)? Are there `**Acceptance**` bullets? Or just the
  scaffold comment?
- The `## Technical` section: are there real notes (files to touch, contracts,
  sequencing) or just the scaffold comment?

A section that contains only the HTML comment `<!-- ... -->` from the scaffold is
empty.

# Step 3 — Show the user what you see

Print a short summary like:

```
Working on feature: <id>
  Goal: <H1 text>
  Story: <empty / partial / complete>
  Technical: <empty / partial / complete>
```

# Step 4 — Ask questions, one at a time

Look at what's missing or vague. Ask **one** focused question per turn. Examples
(don't read these to the user — they're for your reference):

- Story missing: "Who's the primary user here? A developer, an end user, an admin?"
- Acceptance vague: "What's the smallest visible thing that would tell you this
  feature is done?"
- Technical empty: "Which file or module is the entry point for this work?"
- Edge case unclear: "What should happen when X fails? Retry, surface, or ignore?"

After the user answers, **edit the file with the Edit tool** to incorporate the
answer. Don't paraphrase or speculate beyond what they told you. If the answer is
ambiguous, ask a follow-up before editing.

When editing:

- For `## Story`: write a real user story sentence and at least one acceptance
  bullet. Replace the `<!-- ... -->` scaffold comment.
- For `## Technical`: list specific files, function names, or contracts. Replace
  the scaffold comment.
- Preserve the YAML frontmatter exactly. Only the body changes.

Then ask the next question. Repeat.

# Step 5 — Stop conditions

Stop asking when **all** of the following are true:

- `## Story` has a user story sentence AND at least one concrete acceptance bullet.
- `## Technical` has at least one specific file/path or contract reference.
- The user signals they're done ("that's it", "good", "ship it", or similar).

When you stop, print:

```
Feature <id> ready for the planner.
  Run: mars feature refine <id>
```

Do **not** run `mars feature refine` yourself — that's a separate, billable step
the user should trigger explicitly.

# What you do NOT do

- Do not write to `features/<id>/conversation.jsonl`. That log is for the
  headless `mars feature chat` REPL, not this slash command.
- Do not append to `.mars/inbox.jsonl`. The inbox is for the planner agent's
  questions, not yours.
- Do not run `mars feature refine`, `mars feature plan`, or any other write-side
  `mars` command. You are an editor, not an orchestrator. The read-only
  `mars feature list` and `mars feature show` commands are allowed (and
  required by Step 1).
- Do not invent details the user did not provide. If something is ambiguous,
  ask. Three similar lines beats a guess.

# Argument

The user passed: `$ARGUMENTS`
