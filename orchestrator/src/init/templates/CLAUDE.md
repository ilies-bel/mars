# CLAUDE.md

This repo is managed by **Mars** — a CLI (`mars`) and orchestrator that
runs Claude Code in parallel git worktrees, verifies the result, and
fast-forwards into the integration branch. The orchestrator surfaces
work that needs a human via a single inbox.

This file tells Claude Code sessions running in this repo how to route
work through Mars instead of editing the integration branch directly.

## Routing

Route silently between two actions: enqueue (`mars task add "..."`) or
grill conversationally. Never name the routes, narrate the decision, or
ask the user to pick. Reads and searches are always direct.

Enqueue by default. Grill instead when any of these hold:

- shape is exploratory or tentative ("should we…", "thinking about…");
- introduces or redefines a term, or affects `CONTEXT.md` / ADRs;
- cross-cutting or architectural trade-off (new seam, dependency, data
  shape, hard-to-reverse choice);
- acceptance criteria or scope are unclear;
- conflicts with an existing ADR, invariant, or queued work.

If both signals fire, grill — by asking a sharpening question, not by
asking the user to choose.

**Direct editing on the integration branch is a last resort, not a
third route.** It is never silent and never implied. The bar is all of:

- the user explicitly opts in *for this specific change* (a prior
  session-level "you can edit directly" does **not** carry over);
- the orchestrator path is genuinely unavailable or unsuitable;
- you state out loud that you are bypassing the orchestrator and why,
  before the first `Edit`/`Write`.

When in doubt, enqueue. A redundant task is cheap; a silent commit on
the integration branch is not.

## Tasks

Prefer `/mars:task <prompt>` from a Claude Code session for a
light-shaping wrapper that checks terminology against the glossary
before enqueueing.

Tasks live in `.mars/queue.db`. Enqueue via `mars task add "..."`; the
orchestrator dispatches automatically (worktree → code → verify →
merge). Inspect via `mars list`.

**All mutations route through the orchestrator.** Direct `Edit`/`Write`
on the working tree is a last resort — see Routing above. Never assume
a blanket "edit mode" is in effect; opt-in is per-change and must be
re-confirmed, even within the same session.

## The orchestrator

- 4-step workflow: `setup` (worktree on `task/<id>` off the integration
  branch) → `code` (`claude -p`) → `verify` → `merge` (serialized via
  file lock; coding parallel).
- Default merge target is `main`. Override per-invocation with
  `INTEGRATION_BRANCH=<branch>`.
- Per-repo state lives under `.mars/` (gitignored): `state.db`,
  `queue.db`, `mastra.db`, `worktrees/<task-id>/`, `.merge.lock`.

## The inbox

The Mars inbox is the single human-facing work surface. Everything
that needs the user — operational alerts from self-heal, tasks the
orchestrator stopped on after exhausting retries (kind
`task-blocked`), and draft ideas waiting to be shaped (kind
`idea-needs-shaping`) — appears as an inbox message. Pick one via
`mars inbox list` or `/mars:inbox`; the inbox dispatches to the right
resolver (`/mars:unblock`, `/mars:grill`, or ack/resolve/dismiss).

## Glossary and ADRs

- `CONTEXT.md` — domain glossary. Edit only via `mars glossary
  set/remove`; read via `mars glossary list/show`.
- `docs/adr/NNNN-<slug>.md` — ADRs. Add via `mars adr add`; read via
  `mars adr list/show`. ADR only when hard-to-reverse, surprising, and
  embodying a real trade-off.

Never edit `CONTEXT.md` or `docs/adr/**` directly. Reads are fine.

The `/mars:chat` slash command is the conversational entry point. It
classifies the user's input (an id, free text, or empty) and
dispatches to the right sub-skill: `/mars:inbox` for triage,
`/mars:task` for quick enqueues, `/mars:grill` for ideas that need
PRD-shaping, `/mars:unblock` for stuck tasks. Sub-skills update the
glossary and ADRs inline as decisions crystallise — `/mars:chat`
itself writes nothing to those files.

## Structured tasks

`mars task add` accepts `--files`, `--verify`, `--done`, `--type`. Any
of them stores a typed spec; the implementor receives `<files>`,
`<verify>`, `<done>`, `<task_type>`, `<task_id>` sections so
completion is a checklist. The slicer always emits structured tasks;
free-prose still works and degrades to prompt-only.

## Blockers

Blocker edges live in the `task_blockers` junction table (`task_id`
waits on `blocker_task_id`). A task in `blocked` only flips to
`queued` once **every** one of its blockers reaches `done` — and a
successful recovery counts as its origin reaching `done`, so a
recovered blocker unblocks the whole chain.

When a task fails, the orchestrator spawns exactly **one** recovery
task per origin failure. A recovery task is itself non-recoverable: if
it fails for any reason, the origin goes to `failed` with one
actionable inbox item and the operator resolves it explicitly (e.g.
`mars restart`).

- Create edges at enqueue with `mars task add ... --blocked-by <id>`
  (repeatable; each id must already exist) or after the fact with
  `mars block <task-id> <blocker-id> [<blocker-id> ...]`.
- `mars unblock <id> <blocker-id> ...` removes specific edges (status
  unchanged). `mars unblock <id>` with no blocker ids is
  phantom-recovery: it clears all edges and flips the task to `failed`
  so it can be `mars purge`d or `mars restart`ed.
- A blocker that ends in `failed` leaves its dependents waiting in
  `blocked`; resolve the chain via the inbox item on the failed
  blocker.

## Loose ends

Enqueue the moment you spot one — **one `mars task add` per item**,
no batching, no MEMORY.md, no markdown TODOs. Only concrete, actionable
work the user has seen. If the user says "skip", drop it. At stopping
points ("looks good", "ship it"), do a final sweep as a safety net.

Each task prompt must stand alone. Include:

- file path(s) + symptom,
- suggested fix (with trade-offs if alternatives),
- verification command(s),
- a closing **"Save your work"** line — the orchestrator does not
  commit on the agent's behalf.

## Conventions

- Never commit `.env` or `.mars/`.
- Never `cd` between Mars worktrees. Bash CWD persists across tool
  calls, and `mars` resolves the repo from CWD upward — once shifted
  into `.mars/worktrees/<id>/`, every later `mars` call silently binds
  to that worktree's `.mars/` and hits the wrong DB. Use `git -C
  <path>`, tool `--cwd` flags, absolute paths, or `mars --repo <root>
  …`. If a one-off subshell is unavoidable, spell it `(cd <abs-path>
  && …)` so the parent shell never moves.
