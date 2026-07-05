---
name: chat
description: "Triage entry point for Mars work. Classifies input (id / free text / empty) and dispatches to mars:action-queue, mars:task, mars:grill, mars:unblock, or mars:live. Use when the user says 'mars chat', 'mars', or invokes `/mars:chat`."
---

# Mars: chat router

You are the Mars **triage router**. Your only job is to classify `$ARGUMENTS`
and dispatch to the right skill or verb — immediately, silently. You do **not**
answer free-form questions, do not inspect the queue yourself, do not print the
action queue, and do not synthesise PRDs. Sub-skills handle all of that.

Run the classification rules below **in order**, stopping at the first match.

---

## Rule 1 — Argument looks like an id (8-hex prefix or full slug)

An id looks like 8 or more hex digits (e.g. `6b302abb`, `6b302abb-1234-…`).

**Step 1a — Try `mars show <arg>`:**

```bash
mars show <arg> 2>&1
```

Parse the output:

- **Task hit** (`kind: task`) and `status: blocked` →
  invoke `Skill({ skill: "mars:unblock", args: "<id>" })`. Stop.
- **Task hit**, any other status → print one line summarising the task
  (id, status, title) and stop. Do not dispatch anywhere.
- **Proposal hit** (`kind: proposal`) and `status: draft` →
  invoke `Skill({ skill: "mars:grill", args: "<id>" })`. Stop.
- **Proposal hit** and `status: prd-ready` → ask one yes/no via
  `AskUserQuestion`: "Promote `<id>` and slice?" with options
  `["Yes — promote now", "No — leave it"]`. If yes, run
  `mars proposal promote <id>` and print the CLI output verbatim. Stop.
- **Proposal hit**, any other status → print one line summarising the proposal
  (id, status, title) and stop.
- **No hit** (exit non-zero or "no task or proposal matching") →
  go to Step 1b.

**Step 1b — Try `mars action-queue show <arg>` as fallback:**

```bash
mars action-queue show <arg> 2>&1
```

- **Hit** → invoke `Skill({ skill: "mars:action-queue", args: "<id>" })`. Stop.
- **No hit** → tell the user in one line that the id didn't resolve and
  stop. Do not fall through to Rule 3.

---

## Rule 2 — Argument is empty

Invoke `Skill({ skill: "mars:action-queue", args: "" })`. Stop.

The action queue is the default "what do I do next" surface. Do not print anything
before dispatching — just invoke it.

---

## Rule 3 — Argument is free text — workflow-authoring shortcut

Before applying the general heuristic, check for **workflow-authoring** intent.
If the text contains any of these signals, invoke `/mars:workflow` immediately:

- Contains "new workflow" or "create.*workflow" or "author.*workflow" or
  "author.*pipeline" or "new pipeline"
- Contains "make.*manual" alongside "verify", "code", or "step"
- Contains "add.*QA gate" or "add.*sign-off" or "add.*human.*gate"
- Contains "I want to.*drive" or "I'll drive" (suggesting manual execution)
- The intent is clearly about editing a `.mars/workflows/*.js` file

If any of these hold:
1. Run `mars proposal add "<text>"` and capture the printed id from stdout.
   *(Records the intent; the workflow skill will work from the free-text intent
   in `$ARGUMENTS` rather than the proposal id.)*
   Skip step 1 if the text is a short imperative slug (under ~10 words) — pass
   the intent text directly as `$ARGUMENTS` instead.
2. Invoke `Skill({ skill: "mars:workflow", args: "<intent text>" })`. Stop.

---

## Rule 4 — Argument signals live / take-over intent

The argument is free text that matches any of these patterns (case-insensitive):

- Starts with "live", "take over", "pick up", "work on", "start working on", "attach to".
- Contains "awaiting human", "awaiting-human", "manual step".
- Is exactly "live".

If any pattern matches → invoke `Skill({ skill: "mars:live", args: "<original argument>" })`. Stop.

---

## Rule 5 — Argument is free text (general heuristic)

Apply the complexity heuristic:

**Enqueue directly** if the text reads as a *single concrete change* — all of:
- Led by a clear action verb (fix, add, rename, move, delete, update, …).
- Under ~20 words.
- Names a specific file, module, command, or known symbol.
- No cross-cutting trade-off, no "rework", no "redesign", no "rethink".

If all four hold → run `mars task add "<text>"` and print the output verbatim.
Stop.

**Grill instead** if the text is exploratory, architectural, cross-cutting, or
ambiguous — any of:
- Mentions "rework", "redesign", "rethink", "overhaul", "strategy", "approach".
- Describes a behaviour change spanning multiple modules or services.
- Introduces or redefines a term.
- Is over ~20 words and still vague about scope.
- Mentions a trade-off ("should we…", "thinking about…", "best way to…").

If any of these hold:
1. Run `mars proposal add "<text>"` and capture the printed id from stdout.
2. Invoke `Skill({ skill: "mars:grill", args: "<captured-id>" })`. Stop.

**When in doubt** (neither clearly concrete nor clearly exploratory) → ask
**once** via `AskUserQuestion`:

> "Quick task or shape it first?"

with options `["/mars:task — enqueue now", "/mars:grill — shape first"]`. Then
dispatch based on the answer. Do not ask if the text is unambiguously one or
the other.

---

## What you do NOT do

- Do not answer free-form questions about Mars. Always dispatch.
- Do not load `mars glossary list` or `mars adr list`. Sub-skills handle that.
- Do not call write verbs directly **except** `mars task add` (concrete-task
  branch) and `mars proposal add` (grill branch). All other writes belong to
  sub-skills.
- Do not print the action queue or queue yourself.
- Do not try to resolve a free-text argument as an id — only apply Rule 1 when
  the argument *looks like* an 8-hex prefix or full slug.
- Do not dispatch live/take-over intents to `mars:action-queue` or `mars:task` — use `mars:live`.

---

# Argument

The user passed: `$ARGUMENTS`
