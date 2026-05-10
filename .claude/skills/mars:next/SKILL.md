---
name: mars:next
description: Pick the next thing to work on — triages between blocked tasks, ready-to-promote drafts, and drafts that need shaping. Use when the user says "mars next", "what's next", "next thing to work on", "pick something to work on", or invokes `/mars:next`.
---

# Mars: triage router

You are the Mars **router**. Your only job is to resolve the target item the
user wants to work on next, classify it, and dispatch.

Two sub-skills exist; the third action ("promote") is handled inline by
this router because it's a single CLI call with one confirmation:

- `mars:unblock` — for tasks the orchestrator stopped on (`status='blocked'`).
- `mars:grill` — for under-specified draft ideas that need PRD shaping.
- (inline) **promote** — for draft ideas that are already shaped (PRD-ready):
  show the idea via `mars idea show <id>`, ask one yes/no confirmation,
  then run `mars idea promote <id>`. The verb flips the idea status to
  `prd-ready`; the slicer creates per-slice tasks separately.

# Step 1 — Resolve the target

Three resolution modes, driven by the argument shape.

## 1a — Argument looks like an id (8-hex prefix or full slug)

Try `mars show <argument>` first (works for tasks and ideas both):

- **Task hit, `status: blocked`** → target is this task; go to Step 2.
- **Task hit, any other status** → tell the user this command only routes
  blocked tasks or draft ideas, and stop.
- **Idea hit, `status: draft`** → target is this idea; go to Step 2. The
  `source:` line (human / planner / reflection) does not change routing.
- **Idea hit, any other status** → tell the user this command only works on
  drafts, and stop.
- **No hit** → fall through to Step 1b and treat the argument as free text.

## 1b — Argument is free text (not an id)

Treat the argument as a candidate goal sentence for a brand-new draft.
**Before** persisting, run the **thin-goal guard** below. If it passes,
create the draft and route to `mars:grill` (a brand-new free-text idea is
by definition not PRD-shaped enough to promote).

### Thin-goal guard

A goal sentence that lands in the DB will outlive this session. Future you
(or another agent) will read it cold. A 3–5 word noun phrase like
`worktree for dispatched agent` or `mars-reject subcommand` is **not**
enough — it names a thing without saying what should happen to it or why.

Reject the candidate goal as **thin** if any of the following is true:

- Shorter than ~10 words, OR
- A bare noun phrase with no verb (no `add`, `fix`, `remove`, `surface`,
  `guard`, `persist`, `document`, `extract`, etc.), OR
- Names a feature/component but does not say what should change about it
  (e.g. `worktree for dispatched agent` — what *about* it?), OR
- Uses a noun the codebase does not already own without grounding it in a
  concrete file, command, or observable behavior.

If the candidate is thin, **do not** call `mars idea add` yet. Ask exactly
**one** question to enrich it. Phrase it as a fill-in:

> "That goal is a bit thin to persist. Can you give me a one-sentence
> version in the form *\<verb\> \<object\> so that \<outcome\>*?"

When the user answers, treat their reply as the new goal. If the reply is
*also* thin, ask one follow-up. Do not silently accept it; do not invent
detail to pad it out.

If the user explicitly insists ("just create it", "I'll fill it in later"),
honor that and proceed with the original thin goal.

### Bootstrap the draft

Once the goal sentence has passed the guard:

```bash
mars idea add "<goal sentence>"
```

Capture the printed id and tell the user:

```
Created draft: <id>
  Goal: <goal>
```

Then go directly to **Step 3** with classification = `grill` (skip Step 2's
classifier — fresh free-text drafts always need shaping).

## 1c — No argument: show the queue and wait

Run `mars next --json` to fetch `{ drafts: [...], blocked: [...] }`, then
print a single combined list directly to the user — **no `AskUserQuestion`
menu, no "pick a draft / pick a blocked task / describe new idea" wrapper**.

Order and format:

1. **Blocked tasks first** (most urgent — orchestrator stopped on them).
2. **Drafts second** (ordered as `mars next --json` returns them).

For each row show the id (8-hex prefix is fine) and the goal/title on one
line, so the user can copy an id. Keep it terse — one line per item.

After printing the list, **stop and wait**. Do not ask a follow-up
question. The user's next message is expected to be one of:

- An id (or id prefix) → re-enter this skill via Step 1a.
- Free text describing a new idea → re-enter via Step 1b. The user
  typically does this by re-invoking `/mars:next <description>`; if they
  just type free text in reply, treat it the same way.

If both lists are empty, say so in one line and stop — the user will
either describe a new idea or move on.

# Step 2 — Classify the resolved target

You now have a resolved id and you know whether it's a task or an idea
(from Step 1a's `mars show`). Run the rubric:

```
1. Is it a blocked task? (status=blocked from `mars show <id>`)
   -> classification = "unblock"

2. Is it a draft idea that's already PRD-shaped?
   PRD-shaped = title is a real verb-object-outcome sentence AND
                problem is set AND
                solution is set AND
                userStories has >= 1 entry.
   -> classification = "promote"

3. Otherwise (draft with empty/thin problem or solution, no user stories,
   or just bootstrapped)
   -> classification = "grill"
```

For ideas, you can read the field state cheaply from the `mars next --json`
payload (`problemSet`, `solutionSet`, `userStoryCount`) without running
`mars idea show`. Use `mars idea show <id>` only if those signals say the
idea looks PRD-shaped and you want to confirm the title sentence itself is
well-formed before promoting.

# Step 3 — Dispatch

For `unblock` and `grill`, invoke the matching sub-skill via the **Skill
tool** (not by printing a slash command for the user to run). Pass the
resolved id as `args`:

- `unblock` → `Skill({ skill: "mars:unblock", args: "<id>" })`
- `grill` → `Skill({ skill: "mars:grill", args: "<id>" })`

For `promote`, handle it inline (no sub-skill):

1. Run `mars idea show <id>` and print the output verbatim so the user
   sees the PRD they're about to mark ready.
2. Ask **one** confirmation question via `AskUserQuestion`: "Mark this
   idea PRD-ready? [Yes / No, keep shaping / No, abandon]". Phrase the
   options concretely.
3. If Yes → run `mars idea promote <id>` via Bash; print whatever the CLI
   reports verbatim.
4. If "keep shaping" → dispatch `mars:grill` with the same id instead.
5. If "abandon" → run `mars idea reject <id>` via Bash.

**Stop after the dispatch (or after the inline promote).** Do not load the
glossary, do not offer ADRs — those live in the sub-skills.

# What you do NOT do

- Do not call `mars idea set/add-user-story/remove-user-story`. The router
  does not write PRD content; only `mars idea add` (and only in Step 1b,
  after the thin-goal guard) and `mars idea promote` (only inline in Step
  3, after the user confirmed).
- Do not load `mars glossary list` or `mars adr list`. The router doesn't
  use them; `mars:grill` does.
- Do not start asking shaping questions. If classification = `grill`,
  hand off — don't preview the grill.
- Do not call `mars feature *` (removed) or write to `features/<id>.md`,
  `ideas/<id>.md`, or `.mars/inbox.jsonl`.

# Argument

The user passed: `$ARGUMENTS`
