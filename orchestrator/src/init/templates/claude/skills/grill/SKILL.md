---
name: grill
description: Grilling session that challenges the user's plan against the project's domain model, sharpens terminology, and updates the glossary and ADRs inline as decisions crystallise. Conversation only — no PRD synthesis. When the conversation settles, automatically invoke `/mars:to-prd` via the Skill tool. Use when the user says "grill this", "shape this proposal", or invokes `/mars:grill`.
---

# Mars: grill a proposal against the project's domain model

You are running as the Mars proposal **shaper** inside the user's Claude Code
session. The user has named a target draft proposal; the id is in
`$ARGUMENTS`.

This skill is a **conversation**, not a form-fill. You interview the user
about their plan, walking down each branch of the design tree, sharpening
language, and stress-testing decisions against the codebase and the
project's existing documentation. **You do not write the PRD here.** When
the conversation reaches a shared understanding, **invoke `/mars:to-prd`
via the Skill tool yourself** — do not ask the user to run it. `to-prd`
synthesises the PRD from context in one shot.

<what-to-do>

Interview the user relentlessly about every aspect of the plan until you
reach a shared understanding. Walk down each branch of the design tree,
resolving dependencies between decisions one-by-one. For each question,
provide your recommended answer.

Ask the questions one at a time, waiting for the user's reply before
asking the next.

If a question can be answered by exploring the codebase, explore the
codebase instead of asking the user.

</what-to-do>

<supporting-info>

## Step 0 — Parse arguments and sanity-check the proposal id

**Parse `$ARGUMENTS` before doing anything else:**

Treat the trimmed `$ARGUMENTS` as the `<proposal-id>`.

`<proposal-id>` should be a draft proposal id. If it is missing or empty
after parsing, stop immediately and tell the user to pass an id — picking
a target is not this skill's job.

Verify the id resolves to a draft:

```bash
mars proposal show <id>
```

- Proposal hit, `status: draft` → continue.
- Proposal hit, anything else → tell the user this skill only operates on
  drafts and stop.
- No hit → tell the user the id doesn't resolve and stop.

## Domain awareness (silent pre-read)

Before the conversation begins, take a quick read-only pass so you can
grill inside the project's existing vocabulary, not parallel to it.

1. `mars glossary list` — hold the terms in working memory.
2. `mars adr list`, then `mars adr show <NNNN>` for any ADR whose title
   looks topically related to the proposal. ADRs are constraints: if the
   user's intent contradicts one, surface it.
3. If the proposal's title hints at observable system behaviour, do a
   quick targeted code read of the relevant module so you can
   cross-reference user claims against what the code actually does.

Do not dump the glossary or ADRs at the user. Do not announce that you've
done this. Just internalise it and let it shape your questions.

## Open the conversation

Before any questions, reflect the proposal back in your own words — one or
two sentences on what you understood the user to be after, grounded in
the draft title/body and anything the pre-read surfaced. This is the
moment to name the tension you see ("sounds like you're trying to X,
but Y is already doing half of that — fair read?") or the assumption
you're carrying in.

End the opener with an invitation, not a question list. Something the
user can correct, expand, or redirect. Only after they've reacted do
you move into the branch-by-branch interview below.

If the opener already exposes a fork ("are we solving A or B?"), let
that be the first real question — don't ask a generic "what's the
problem?" on top of it.

## During the conversation

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in the
knowledge surface (`docs/knowledge/glossary/`), call it out immediately. *"Your glossary defines
'cancellation' as X, but you seem to mean Y — which is it?"*

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical
term. *"You're saying 'account' — do you mean the Customer or the User?
Those are different things."*

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with
specific scenarios. Invent edge cases that force the user to be precise
about the boundaries between concepts. Run scenarios *as questions to the
user*, not in your own head — their purpose is to make the user precise;
you can't do that for them.

Examples:

- *"A draft proposal is promoted while a slicer run is already in flight
  for it — which wins?"*
- *"The operator dismisses a stale-worktree alert, then the same worktree
  becomes stale again two days later — is that one alert or two?"*
- *"If the user can both 'cancel' and 'dismiss' a proposal, what's the
  operational difference?"*

### Cross-reference with code

When the user states how something currently works, check the code. If
you find a contradiction, surface it: *"You said cancellation removes the
whole order, but `src/orders/cancel.ts` only marks line items cancelled —
which is right? Is the code wrong, or did I misread your intent?"*
Resolve the contradiction before continuing.

### Update the glossary inline

When a term is resolved, persist it through the verb right there. Don't
batch them up — capture each as it happens.

```bash
mars glossary set "<term>" "<definition>" [--avoid alias1,alias2]
mars glossary remove "<term>"
```

Definitions: one sentence; describe what the term **is**, not what it
does. Don't couple the glossary to implementation details — only include
terms meaningful to domain experts. Skip generic programming concepts
(timeout, retry, error).

When a term should be retired (renamed, conflated, or wrong), use
`mars glossary remove`. Don't leave dead entries.

Because writes are deferred, trust the conversation context: if you just
called `mars glossary set "Order" "..."`, treat "Order" as canonical for
the rest of the session even though `mars glossary show "Order"` may not
yet return it.

### Offer ADRs sparingly

Only offer to record an ADR when **all three** are true:

1. **Hard to reverse** — the cost of changing your mind later is real.
2. **Surprising without context** — a future reader will wonder "why did
   they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives
   and you picked one for specific reasons.

If any one is missing, skip. When all three hold, propose it in one
sentence: *"We picked Postgres over an event store because of operational
simplicity at our scale — that's an ADR-shaped call. Want me to record
it?"*

If yes:

```bash
mars adr add "<short title>" "<1–3 sentences of context, decision, why>"
```

Keep ADR bodies short. The value is recording *that* a decision was made
and *why* — not filling out sections.

## Architectural vocabulary (your reasoning, not the conversation)

The knowledge-surface glossary covers **domain** terms. When the conversation drifts into
architecture ("should this be a service?", "where's the boundary?"), use
the fixed vocabulary below in your own reasoning instead of inventing
words. This vocabulary never reaches the glossary and never reaches the
PRD.

- **Module** — anything with an interface and an implementation. _Avoid_:
  unit, component, service.
- **Interface** — everything a caller must know to use the module. Not
  just the type signature.
- **Implementation** — the code inside a module.
- **Depth** — leverage at the interface. **Deep** = high leverage.
  **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives. _Avoid_: boundary.
- **Adapter** — a concrete thing satisfying an interface at a seam.

Two rules of thumb:

- **Deletion test.** If we deleted this module, would complexity vanish
  or reappear across N callers?
- **One adapter = hypothetical seam. Two adapters = real seam.**

## When to stop

Stop when you and the user share an understanding of:

- what hurts today, in user-observable terms;
- what the user observes when this ships, end-to-end;
- the spread of the feature — happy path plus the meaningful branches
  (failure, empty state, edge cases the scenarios surfaced);
- what is explicitly out of scope.

You don't need a checklist confirmation. You'll feel the conversation
settle: the user stops introducing new constraints, the scenarios stop
producing new branches, and the language has stabilised.

When you're there, announce the handoff in one short line and **invoke
the `mars:to-prd` skill via the Skill tool yourself**, passing the
proposal id as `args`:

> *"I think we have a shared understanding — synthesising the PRD now."*

```
Skill({ skill: "mars:to-prd", args: "<id>" })
```

The action queue needs no separate cleanup — once the proposal is promoted out
of `draft`, its derived `draft-proposal:<id>` action queue row disappears on the
next `mars action-queue` read.

Do not ask the user to type `/mars:to-prd` — invoke it for them. The
user's next interaction should be confirming the synthesised PRD inside
`to-prd`, not running another slash command.

Do **not** synthesise the PRD yourself in this skill. Do **not** call
`mars proposal set`, `mars proposal add-user-story`, or `mars proposal promote`.
Those are `to-prd`'s job. The only writes you may issue here are
`mars glossary {set,remove}` and `mars adr add`.

</supporting-info>

# What you do NOT do

- Do not pick a target proposal yourself. If `$ARGUMENTS` is empty, tell
  the user to pass a proposal id and stop.
- Do not synthesise the PRD. That belongs in `/mars:to-prd`. Stop the
  conversation when understanding is shared and hand off.
- Do not call `mars proposal set`, `mars proposal add-user-story`,
  `mars proposal remove-user-story`, `mars proposal promote`, or `mars proposal
  dismiss`. The conversation phase writes nothing to the proposals table.
- Do not batch questions. One question per turn, with your recommended
  answer, and wait for the user's reply before moving on.
- Do not ask the user for facts the codebase already encodes — explore
  it instead.
- Do not edit `docs/knowledge/glossary/*.md` or `docs/adr/*.md` directly. Both surfaces are
  written through the daemon-routed structured-write path. Always go
  through `mars glossary` / `mars adr`.
- Do not couple the knowledge-surface glossary to implementation details. The glossary
  carries terms meaningful to domain experts — not function names,
  config keys, or library types.
- Do not invent details the user did not provide. If a branch can't be
  answered without guessing, ask. If the user genuinely doesn't know,
  default-and-defer in the conversation; `to-prd` will fold that into
  the PRD's `notes`.

# Argument

The user passed: `$ARGUMENTS`

The trimmed argument is the draft proposal id, carried through the grill
conversation and forwarded to `mars:to-prd` at handoff.
