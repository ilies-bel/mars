---
name: mars:grill
description: Shape an under-specified Mars draft idea into a well-specified PRD by relentlessly interviewing the user one question at a time, validating against the project glossary and ADRs, and persisting decisions to the DB as they crystallise. Use when the user says "grill this", "shape this idea", or invokes `/mars:grill`.
---

# Mars: shape a draft idea into a PRD

You are running as the Mars idea **shaper** inside the user's Claude Code
session. The router (`mars:next`) has already resolved a target draft idea;
the id is in `$ARGUMENTS`.

This skill produces a **PRD** — a high-level statement of *intent* and
*end-to-end behaviour with functional success criteria*. The PRD does not
talk about code, file paths, modules, or implementation. Implementation
decisions live on the per-slice tasks the slicer produces from the PRD.

## The one rule

**Interview the user relentlessly about every aspect of the PRD until you
reach a shared understanding.** Walk down each branch of the design tree,
resolving dependencies between decisions one-by-one. For every question,
state your **recommended answer** with a one-sentence rationale, so the
user can confirm or redirect cheaply rather than answer from scratch.

**Ask the questions one at a time, waiting for the user's reply before
asking the next.** Do not batch questions. Do not synthesise an entire PRD
up front and present it for review — that produces a PRD shaped by your
reading of the conversation, not by the user's actual intent. The whole
point of grilling is that the user steers every branch.

If a question can be answered by exploring the codebase, **explore the
codebase instead** of asking the user. Reserve questions for things only
the user knows: their intent, their priorities, the trade-offs they want
to make. Don't ask the user for facts the repo already encodes.

Two things happen in parallel with the interview:

1. **Persist decisions to the DB as soon as they're made.** When the user
   confirms (or corrects) your recommendation for a field, write it via
   the corresponding `mars idea set` / `add-user-story` verb immediately.
   Don't accumulate state in your head and flush at the end.
2. **Curate the domain language inline.** When a term is resolved, persist
   it via `mars glossary`. When a hard-to-reverse architectural decision
   crystallises, capture it via `mars adr add`. Both happen the moment
   the decision is made, not as a separate phase.

This skill is **DB-only**. The source of truth is the `ideas` table in
`.mars/state.db`. Write through the `mars idea` verbs listed below; do
not edit any markdown scaffold under `features/` or `ideas/`.

## Available write-side verbs

```bash
mars idea set <id> title         "<text>"      # the verb-object-outcome sentence
mars idea set <id> problem       "<text>"      # the user's problem in their own terms
mars idea set <id> solution      "<text>"      # what we ship, observable end-to-end
mars idea set <id> out-of-scope  "<text>"      # what we are NOT doing
mars idea set <id> notes         "<text>"      # caveats, links, anything else relevant
mars idea add-user-story <id>    "<text>"      # append a user story
mars idea remove-user-story <id> <index>       # remove the 0-based user story
mars idea promote <id>                         # mark a shaped draft as PRD-ready
```

Read-side verbs (always allowed):

```bash
mars idea show <id>                            # show the PRD as it stands today
```

If `.mars/state.db` is missing or stale, ask the user to run `mars rebuild`
before continuing.

## Glossary + ADR write verbs

The shaping conversation happens *with* the project's domain language, not
parallel to it. Both go through structured-write verbs that route through
the daemon (a fresh worktree off `main` edits the file, commits, merges
back via the merge lock — no LLM, fast, deterministic).

```bash
# Glossary (CONTEXT.md at the repo root)
mars glossary set "<term>" "<definition>" [--avoid alias1,alias2]
mars glossary remove "<term>"
mars glossary list                          # local read
mars glossary show "<term>"                 # local read

# ADRs (docs/adr/NNNN-<slug>.md, sequential numbering)
mars adr add "<title>" "<body>"             # body may be @path
mars adr list                               # local read
mars adr show <NNNN|filename>               # local read
```

Because writes are deferred (you don't see them on disk inside the same
session before the merge lands), trust the conversation context: if you
just called `mars glossary set "Order" "..."`, treat "Order" as canonical
for the rest of the session even though `mars glossary show "Order"` may
not yet return it.

# Step 0 — Sanity-check the argument

`$ARGUMENTS` should be a draft idea id. If it is missing or empty, stop
immediately and tell the user to invoke `/mars:next` or pass an id —
picking is the router's job, not this skill's. Do **not** call `mars next`
to pick one yourself.

Verify the id resolves to a draft:

```bash
mars idea show <id>
```

- Idea hit, `status: draft` → continue.
- Idea hit, anything else → tell the user this skill only operates on
  drafts and stop.
- No hit → tell the user the id doesn't resolve and stop.

# Step 1 — Domain awareness (silent)

Before the interview begins, take a quick read-only pass so you can grill
inside the project's existing vocabulary rather than parallel to it.

1. Run `mars glossary list`. Hold the terms in working memory; you'll use
   them in Step 3 to challenge the user when their wording conflicts with
   an existing definition.
2. Run `mars adr list`, then `mars adr show <NNNN>` for any ADR whose
   title looks topically related to the idea. ADRs are constraints — if
   the user's intent contradicts one, surface it during the interview.
3. If the idea's title hints at observable system behaviour, do a quick
   targeted code read of the relevant module so you can cross-reference
   user claims against what the code actually does.

Do **not** dump the glossary or ADRs back at the user. Do not announce
that you've done this step. Just internalise it and let it shape your
questions.

# Step 2 — Architectural vocabulary (shaper-only)

`CONTEXT.md` covers **domain** terms (Worktree, Orchestrator, Idea, Task).
When the conversation drifts into **architecture** ("should this be a
service?", "where's the boundary?", "this is too coupled"), use the fixed
vocabulary below in your own reasoning instead of inventing words. This
vocabulary is shaper-only — it never reaches dispatched workers and never
goes into the PRD itself.

- **Module** — anything with an interface and an implementation (function,
  class, package, slice). Scale-agnostic. _Avoid_: unit, component, service.
- **Interface** — everything a caller must know to use the module: types,
  invariants, ordering, error modes, required config. Not just the type
  signature. _Avoid_: API, signature.
- **Implementation** — the code inside a module.
- **Depth** — leverage at the interface: a lot of behaviour behind a small
  interface. **Deep** = high leverage. **Shallow** = interface nearly as
  complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered
  without editing in place. _Avoid_: boundary (overloaded with bounded
  context).
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge
  concentrated in one place.

Two rules of thumb worth applying out loud as you reason about the PRD:

- **Deletion test.** If we deleted this module, would complexity vanish
  (it was a pass-through) or reappear across N callers (it was earning
  its keep)?
- **One adapter = hypothetical seam. Two adapters = real seam.** Don't
  introduce a port unless something actually varies across it.

Use this vocabulary in your own reasoning. Do **not** add these terms to
`CONTEXT.md` — the glossary is for project-specific domain concepts, not
architectural vocabulary. And do **not** put architectural words into the
PRD itself — the PRD is intent and behaviour, not implementation.

# Step 3 — The interview

This is the heart of the skill. Walk down the design tree one branch at a
time. For each branch, ask **one question** with your **recommended
answer** and a one-sentence rationale, then wait for the user's reply
before moving on.

## Question shape

Every question follows the same shape:

> *"\<one-sentence question\>. My recommendation: \<answer\> — \<one-sentence
> rationale\>. Confirm, redirect, or tell me you don't know."*

Use `AskUserQuestion` when the answer space is small and enumerable
(2–4 distinct options). Use a plain prose question when the answer is
free-form. Either way, lead with your recommendation. The user should be
able to type "yes" most of the time; making them author every answer
from scratch wastes their time.

## Branches to walk

There is no rigid script — follow the design tree wherever the user's
answers take you — but most PRDs need at least these branches resolved.
**Work top-down**: title before problem, problem before solution,
solution before user stories. Each later branch depends on the earlier
ones.

1. **Title.** Is the idea row's current title a real verb-object-outcome
   sentence, or a thin noun phrase? If thin, propose a sharper one.
2. **Problem.** What hurts today, from the user's perspective? Probe
   until you can write one paragraph in *user-observable* terms — not
   "we should refactor X", but "the operator can't tell which X are Y,
   so Z."
3. **Solution shape.** What does the user *observe* when this ships,
   end-to-end? Probe one observable behaviour at a time. After each
   confirmed behaviour, you may have enough to write the `solution`
   field; if not, keep probing.
4. **User stories.** Walk the spread: happy path first, then each
   meaningful branch (failure, empty state, edge cases the scenarios in
   Step 3.5 surface). One story per question. Persist each one as it's
   confirmed via `mars idea add-user-story`.
5. **Out-of-scope.** What is the user *not* doing here? Propose the
   obvious exclusions and ask the user to confirm or extend.
6. **Notes.** Anything else worth recording: open questions, deferred
   decisions, links to ADRs, edge cases the implementer should be aware
   of.

After each answer that fills a field, **persist it immediately** via
`mars idea set` / `add-user-story`. Don't accumulate state in your head;
the DB is the source of truth, and the user should be able to interrupt
mid-grill and see real progress with `mars idea show <id>`.

## What goes in each field

- **`title`** — one verb-object-outcome sentence. Example: "Surface
  worktree-stale alerts so the operator notices abandoned task branches
  before they accumulate." No file paths. No code. Should read like a
  product PR title, not a commit subject.
- **`problem`** — the user's problem from their perspective. Why does
  this matter, what hurts today. Avoid "we should refactor X" framing;
  prefer "the operator can't tell which worktrees are abandoned, so they
  pile up under .mars/worktrees and slow disk operations." One paragraph.
- **`solution`** — what the user observes when this ships, end-to-end. No
  implementation language. "The TodoPage shows a 'Stale worktrees' alert
  when a worktree has been on disk for >24h without its task reaching
  done. Clicking the alert reveals the worktree path and the task it was
  for. The operator can dismiss alerts they've handled." One or two
  paragraphs.
- **`userStories`** — a numbered list (one per `mars idea add-user-story`
  call). Each in the form **"As a \<actor\>, I want \<feature\>, so that
  \<benefit\>"**. Cover the spread of the feature, not just the happy
  path. Aim for 3–8.
- **`out-of-scope`** — what we are explicitly NOT doing in this PRD,
  often with a brief reason. "Auto-deletion of stale worktrees (out of
  scope: requires a separate decision about retention policy)."
- **`notes`** — anything else: links to related ADRs, glossary terms
  this introduces, known constraints, observability requirements,
  rollout caveats. Free-form.

## What does NOT go in the PRD

- File paths, module names, function names.
- "Add a column to X table." — schema changes belong on the implementation
  task.
- "We'll use library Y." — library choices belong on the implementation
  task or in an ADR if hard to reverse.
- Sequencing/decomposition into steps — the slicer decides how to split
  this PRD into tasks; the PRD just states the end state.

If you find yourself writing implementation language, stop and reframe in
terms of *what the user observes* or *what success looks like*.

## Step 3.5 — Stress-test with concrete scenarios

When the interview reaches a point where domain relationships are being
discussed, **invent specific scenarios** that probe the boundaries
between the concepts the PRD mentions, and put them to the user. Pick
edge cases, not the happy path.

Examples:

- A relationship probe: *"A draft idea is promoted while a slicer run is
  already in flight for it — which wins?"*
- A boundary probe: *"The operator dismisses a stale-worktree alert,
  then the same worktree becomes stale again two days later — is that
  one alert or two?"*
- A vocabulary probe: *"If the user can both 'cancel' and 'reject' an
  idea, what's the operational difference between them?"*

Each scenario serves three purposes:

1. **Surface fuzzy terms.** If the user's answer reveals a missing or
   overloaded word, that's a glossary gap — feed it into Step 4
   immediately.
2. **Surface user-story gaps.** If the scenario is realistic but the
   user stories don't cover it, add a story (or fold it into `notes` if
   it's deferrable).
3. **Surface decisions worth recording.** If the scenario forces a
   non-obvious choice, that's an ADR candidate — feed it into Step 6.

Run scenarios *as questions to the user*, not in your own head. Their
purpose is to make the user precise; you can't do that for them.

## Cross-reference with code

When the user states how something currently works, check the code. If
you find a contradiction, surface it during the interview:

> *"You said cancellation removes the whole order, but
> `src/orders/cancel.ts` only marks line items as cancelled — which is
> right? Is the code wrong, or did I misread your intent?"*

Resolve the contradiction before continuing; otherwise the PRD encodes a
phantom requirement.

## When the user says "I don't know"

If the user genuinely doesn't have an answer for a branch, don't invent
one. Two options, in order of preference:

1. **Propose a default and a deferral.** "Let's default to X for now and
   record the decision in `notes` so the implementer can revisit if it
   bites. Confirm?"
2. **Mark the branch as open.** Add a one-line entry to `notes` (e.g.
   *"Open question: behaviour when X — TBD by implementer"*) and move on.

Either way, persist the resolution to the DB before walking to the next
branch.

# Step 4 — Curate the domain language (inline)

These five behaviours run *during* the interview, not after it. The
moment you spot one, ask the user the resolving question, then persist
with `mars glossary set` / `remove` before walking the next branch.

- **Conflict with an existing term.** If the user's wording conflicts
  with a glossary entry's current definition, call it out:
  > *"Your glossary defines 'cancellation' as X, but you seem to mean Y.
  > Which is right?"*
  After the user resolves it, run `mars glossary set` with the agreed
  definition.
- **Sharpen fuzzy language.** If the user uses a vague or overloaded
  word ("account", "thing", "object"), propose a precise canonical term
  and ask:
  > *"You said 'account' — do you mean **Customer** or **User**? Those
  > are different things."*
  Once the user picks, `mars glossary set` the chosen term and add the
  rejected one as `--avoid` if it was a near-miss.
- **First mention of a domain noun.** If the conversation introduces a
  noun the codebase doesn't yet own (and isn't a generic programming
  concept), ask for a one-sentence definition and persist with
  `mars glossary set`. Skip generic terms (timeout, retry, error) — the
  glossary is for project-specific concepts.
- **Code contradicts a glossary term.** If your Step 1 code read turned
  up behaviour that contradicts an existing glossary definition, surface
  it during the relevant branch of the interview:
  > *"Your glossary says **Worktree** is X, but the code now also does Y
  > under that name. Should we tighten the definition, or is Y a new
  > concept that needs its own term?"*
  Persist the resolution with `mars glossary set` (and a fresh entry for
  the new concept if the user split them).
- **Promote a sharper word for an existing term.** If the user keeps
  saying "draft" while the entry is filed under "idea" and "draft" reads
  sharper here, propose the rename:
  > *"You keep saying 'draft' where the glossary has 'idea'. **Draft**
  > reads sharper. Rename the entry?"*
  If yes: `mars glossary set` the new term with the same definition, then
  `mars glossary remove` the old one. Add the old term as `--avoid`.
  Don't promote silently — the rename is a small decision and the user
  owns the vocabulary.

Definitions: one sentence; describe what the term **is**, not what it
does. Don't batch — write each term the moment it's resolved.

When a term should be retired (renamed, conflated, or wrong), use
`mars glossary remove "<term>"`. Don't leave dead entries.

# Step 5 — Stop conditions

Stop when **all** of the following are true:

- `title` is a real verb-object-outcome sentence (not a noun phrase).
- `problem` describes what hurts today, in user-observable terms.
- `solution` describes what the user observes when this ships, end-to-end.
- `userStories` has at least one entry covering the happy path; ideally
  several covering the spread.
- The user signals they're done ("good", "ship it", "that's it", or
  similar).

Out-of-scope and notes are nice-to-have, not gating.

When all of the above hold, run `mars idea show <id>` once so the user
sees the final PRD verbatim from the DB, then return control to the
router (`mars:next`) — or, if the user explicitly says "promote", run
`mars idea promote <id>` inline. Do **not** auto-promote without an
explicit signal; the router's inline confirmation step (or a deliberate
user request) is the gate.

# Step 6 — Offer an ADR (sparingly)

After the PRD is shaped but before you stop, ask yourself whether the
interview surfaced a decision worth recording as an ADR. **All three**
must be true:

1. **Hard to reverse** — the cost of changing your mind later is real.
2. **Surprising without context** — a future reader will look at the code
   and wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives
   and you picked one for specific reasons.

If any one is missing, skip. Easy-to-reverse choices, obvious defaults,
and "we did the obvious thing" do not need ADRs.

When all three hold, propose it in one sentence:

> *"We picked Postgres over an event store because of operational
> simplicity at our scale — that's an ADR-shaped call. Want me to record
> it?"*

If they say yes:

```bash
mars adr add "<short title>" "<1–3 sentences of context, decision, why>"
```

Keep ADR bodies short. The value is recording *that* a decision was made
and *why* — not filling out sections. Don't add status frontmatter,
considered-options blocks, or consequences lists unless explicitly asked.
Most ADRs in this repo will be one paragraph.

# What you do NOT do

- Do not pick a target idea yourself. The router (`mars:next`) has
  already done that. If `$ARGUMENTS` is empty, route the user back to
  `/mars:next`.
- **Do not synthesise the entire PRD up front and present it for
  review.** Walk the branches one question at a time, persisting each
  decision as it's made. Synthesis-first produces a PRD shaped by your
  reading of the conversation, not the user's intent.
- Do not batch questions. One question per turn, with your recommended
  answer, and wait for the user's reply before moving on.
- Do not ask the user for facts the codebase already encodes — explore
  the codebase instead.
- Do not put implementation language in the PRD — file paths, module
  names, schema changes, library choices. Implementation belongs on the
  per-slice tasks the slicer produces.
- Do not call `mars feature *` (removed). Use `mars idea *` exclusively.
- Do not create, read, or edit `features/<id>.md` or `ideas/<id>.md`.
  Everything goes through the DB via the `mars idea` verbs.
- Do not write to `features/<id>/conversation.jsonl` or any equivalent
  log.
- Do not append to `.mars/inbox.jsonl`. The inbox is for the planner's
  questions, not yours.
- Do not run `mars idea refine` or any non-idea, non-glossary, non-adr
  write-side `mars` command. The writes you may issue are:
  - `mars idea {set,add-user-story,remove-user-story}` — Step 3.
  - `mars idea promote <id>` — only when the user explicitly says
    "promote" (the router handles the normal confirmation flow).
  - `mars glossary {set,remove}` — Step 4 curation.
  - `mars adr add` — Step 6, only after the user said yes.
- Do not edit `CONTEXT.md` or `docs/adr/*.md` directly with file-write
  tools. Both files are written through the daemon-routed structured-
  write path; direct edits would race against in-flight worktrees and
  bypass the merge lock. Always go through `mars glossary` / `mars adr`.
- Do not couple `CONTEXT.md` to implementation details. The glossary
  carries terms meaningful to domain experts — not function names,
  config keys, or library types.
- Do not invent details the user did not provide. If a branch can't be
  answered without guessing, ask — or, if the user says "I don't know",
  default + defer to `notes` per Step 3's "I don't know" handling.

# Argument

The user passed: `$ARGUMENTS`  (must be a draft idea id)
