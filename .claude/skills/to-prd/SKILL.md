---
name: to-prd
description: Turn the current `/mars:grill` conversation context into a PRD and write it to the Mars proposals table. Do NOT re-interview the user — synthesise from what you already know. Use when the user says "write the PRD", "to PRD", or invokes `/mars:to-prd <id>`.
---

# Mars: synthesise a PRD from grilled context

This skill takes the current conversation context — typically a finished
`/mars:grill <id>` session — and produces a PRD on the draft proposal row in
the Mars database. **Do NOT interview the user.** Synthesise from what you
already know. If a field genuinely cannot be inferred from context, ask
*one* short, specific question; do not restart grilling.

The grilling phase wrote nothing to the proposals table. This skill writes
all PRD fields in one batch through the `mars proposal` verbs.

## Step 0 — Parse arguments and sanity-check the proposal id

**Parse `$ARGUMENTS` before doing anything else:**

Treat the trimmed `$ARGUMENTS` as the `<proposal-id>`.

`<proposal-id>` should be a draft proposal id. If it is missing or empty
after parsing, tell the user to pass one (e.g. `mars proposal list
--status draft` to find one), and stop.

Verify it resolves to a draft:

```bash
mars proposal show <proposal-id>
```

- `status: draft` → continue.
- Anything else → tell the user this skill only operates on drafts and
  stop.

## Step 1 — Re-anchor in the project

Take a quick read-only pass so the PRD speaks the project's language:

1. `mars glossary list` — use these terms verbatim in the PRD. Do not
   invent synonyms.
2. `mars adr list`, then `mars adr show <NNNN>` for any ADR topically
   related to the proposal. Respect their constraints; if the synthesis
   violates one, surface it to the user before writing.
3. If you haven't already, do a quick targeted code read of the relevant
   module so the PRD doesn't encode phantom requirements.

Do not dump these back at the user. Internalise them.

## Step 2 — Synthesise the PRD

Draft each field in your head from the conversation context, then write
them to the DB through the verbs below. **Do not edit any markdown
scaffold.** The source of truth is the proposals table.

```bash
mars proposal set <id> title         "<text>"
mars proposal set <id> problem       "<text>"
mars proposal set <id> solution      "<text>"
mars proposal set <id> out-of-scope  "<text>"
mars proposal set <id> notes         "<text>"
mars proposal add-user-story <id>    "<text>"     # one call per story
```

### Field shapes

- **`title`** — one verb-object-outcome sentence. Reads like a product PR
  title, not a commit subject. No file paths, no code.
  Example: *"Surface worktree-stale alerts so the operator notices
  abandoned task branches before they accumulate."*

- **`problem`** — one paragraph, the user's problem from their
  perspective. Avoid "we should refactor X" framing; prefer concrete
  user-observable pain.
  Example: *"The operator can't tell which worktrees are abandoned, so
  they pile up under .mars/worktrees and slow disk operations."*

- **`solution`** — one or two paragraphs describing what the user
  *observes* when this ships, end-to-end. No implementation language.
  Example: *"The TodoPage shows a 'Stale worktrees' alert when a
  worktree has been on disk for >24h without its task reaching done.
  Clicking the alert reveals the worktree path and the task it was for.
  The operator can dismiss alerts they've handled."*

- **`userStories`** — a LONG, numbered list. One `add-user-story` call
  per story. Every story in the form:

  > *"As a \<actor\>, I want \<feature\>, so that \<benefit\>."*

  Cover the spread of the feature, not just the happy path. Aim for
  3–8; more if the conversation surfaced enough branches.

- **`out-of-scope`** — what is explicitly NOT in this PRD, often with a
  brief reason. *"Auto-deletion of stale worktrees (out of scope:
  requires a separate decision about retention policy)."*

- **`notes`** — anything else: open questions the user defaulted-and-
  deferred, links to related ADRs, glossary terms this introduces,
  observability requirements, rollout caveats. Free-form.

### What does NOT go in the PRD

- File paths, module names, function names.
- Schema changes ("add a column to X table").
- Library choices ("we'll use library Y").
- Sequencing or decomposition into steps. The slicer decides how to
  split this PRD into tasks; the PRD just states the end state.

If you find yourself writing implementation language, stop and reframe
in terms of *what the user observes* or *what success looks like*.

### Architectural reasoning, not architectural prose

If the grill conversation produced architectural insights ("this wants
a deep module behind a small interface"), use them to *shape* what you
write — but keep architectural words out of the PRD itself. The PRD is
intent and behaviour; modules and seams belong on the implementation
tasks the slicer produces.

## Step 3 — Summarise and confirm

The PRD is now written to the draft row, but **not yet promoted**.
Surface a tight summary so the user can decide without scrolling through
the full field dump. Do **not** run `mars proposal show <id>` here — that
dumps everything verbatim and defeats the point of the summary. The
user can run it themselves if they want the full text.

The summary should fit in roughly 6–10 lines, e.g.:

```
PRD for <id>:
  Title:     <one-line title>
  Problem:   <one short sentence of the pain>
  Solution:  <one short sentence of what ships>
  Stories:   <N>  (e.g. "operator powers off mid-task", "Claude tokens run out", ...)
  Scope cut: <one short sentence summarising the biggest out-of-scope item>
  Notes:     <one short sentence flagging anything notable — new glossary terms, deferred questions, etc.>
```

Lift the summary text directly from the values you just wrote — do not
re-paraphrase them, or the summary will drift from the PRD itself. For
the stories line, give the count plus 2–3 representative actor phrases
from the stories you added, not the full sentences.

Then ask **one** confirmation question via `AskUserQuestion`:

> *"Promote `<id>`?"* — options: **Yes, promote** / **No, keep
> shaping** / **No, abandon**.

No prose preamble in the question body.

Then act on the answer:

- **Yes, promote** → `mars proposal promote <id>`. Print the CLI output
  verbatim. End with one line: `Promoted <id>.` The action queue needs no
  separate cleanup — the `draft-proposal:<id>` row is derived from the
  proposal's `draft` status, so promoting it (status leaves `draft`)
  removes the row on the next `mars action-queue` read.
- **No, keep shaping** → tell the user to run `/mars:grill <id>` again
  to revisit specific branches. Do not re-interview here. The action queue row
  correctly stays — the proposal is still a draft. End your turn.
- **No, abandon** → `mars proposal dismiss <id>` and end with one line:
  `Dismissed <id>.` Dismissing also moves the proposal out of `draft`, so
  the action queue row clears on the next read.

If the promote (or reject) command fails, surface the error verbatim in
one sentence and stop — do not retry silently.

# What you do NOT do

- Do not re-interview the user. Synthesise from context. One short
  clarifying question is fine if a field is genuinely missing; full
  grilling is not.
- Do not edit `features/<id>.md`, `proposals/<id>.md`, or any markdown
  scaffold. PRD lives in the DB.
- Do not append to `.mars/action queue.jsonl`.
- Do not edit `docs/knowledge/glossary/*.md` or `docs/adr/*.md` directly. If grilling
  surfaced a missing term or ADR you forgot to capture, route through
  `mars glossary set` / `mars adr add` — but prefer to do this during
  `/mars:grill`, not here.
- Do not run any non-proposal write-side `mars` command beyond the verbs
  listed above.
- Do not invent details the user did not provide. Default-and-defer in
  `notes` instead.

# Argument

The user passed: `$ARGUMENTS`

The trimmed argument is the draft proposal id, carried through the skill
for PRD synthesis.
