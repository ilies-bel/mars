# CLAUDE.md

This repo is managed by **Mars** — a CLI (`mars`) and orchestrator that
runs Claude Code in parallel git worktrees, verifies the result, and
fast-forwards into the integration branch. The orchestrator surfaces
work that needs a human via a single action queue.

This file tells Claude Code sessions running in this repo how to route
work through Mars instead of editing the integration branch directly.

## Routing

Route silently between four pipelines — never name the route, narrate
the decision, or ask the user to pick. Reads and searches are always
direct.

**General rule:** run `mars workflow list` to see every available
pipeline. Each is a runbook with declared execution modes and Step
guides, renderable via `mars workflow render <name>`. Pick the
pipeline whose shape fits the work and select it at enqueue with
`--workflow <name>`.

The four lines:

1. **Hard / cross-repo / term-defining work → grill first.** While
   grilling, file `mars proposal add` for out-of-scope observations
   and enqueue high-confidence loose ends directly (`mars task add`).
2. **Small tweaks / backend work → background task.** `mars task add
   "..."` — the orchestrator dispatches, codes, verifies, and merges
   headlessly.
3. **Visual or user-present work → live task.** `mars task add --live`;
   the task parks in `awaiting-human` with the Step guide in the action
   queue. Work in the worktree, then `mars step done <id>`. The verify +
   merge gate is the exit condition.
4. **Investigation / audit / report-only work → report pipeline.**
   `mars task add --workflow report "..."` — the report pipeline is
   read-only: it runs setup + agent, then persists the transcript and
   marks the task done — no commit, no verify, no merge. Reach for it
   whenever the requested outcome is a finding or decision note, not a
   code change.

**Direct editing on the integration branch is a last resort, not a
fourth route.** It is never silent and never implied. The bar is all of:

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

Tasks live in the embedded PostgreSQL database the daemon provisions
per repo (data dir `.mars/pg/data`, DSN published to `.mars/pg.dsn`).
Enqueue via `mars task add "..."`; the orchestrator dispatches
automatically (worktree → code → verify → merge). Inspect via `mars
list`. For direct reads, query with `psql "$(cat .mars/pg.dsn)"`.

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
- Per-repo state lives under `.mars/` (gitignored): `pg/data/` (the
  embedded Postgres data dir), `pg.dsn`/`pg.port`,
  `worktrees/<task-id>/`, `.merge.lock`.
- **Incident kill-switch:** `mars operator set recovery on|off` suppresses
  fix-task / Investigator spawns (persisted across daemon
  restarts). Toggle off during failure storms to stop the self-heal cascade
  while you diagnose.

## The action queue

The Mars action queue is the single human-facing work surface. Everything
that needs the user — operational alerts from self-heal, tasks the
orchestrator stopped on after exhausting retries (kind
`task-blocked`), and draft proposals waiting to be shaped (kind
`draft-proposal`) — appears as an action queue message. Pick one via
`mars action-queue list` or `/mars:action-queue`; the action queue dispatches to the right
resolver (`/mars:unblock`, `/mars:grill`, or
terminal restart/purge — the queue is a pure projection, no operator gesture closes a row).

## Live execution

When a task parks at a manual step, the worktree is ready and the
workflow renders its Step guide (the runbook for that pipeline) in the
action queue.

**Handoff:** read the Step guide in full before touching
anything. It states what the current step expects, which criteria gate
`step done`, and what the next auto step will do once you signal
completion.

**Step-guide discipline:**

- `mars task note <id> "<observation>"` — journal progress or blockers
  at any point during a step.
- `mars task check <id> <criterion>` — mark a done-criterion as
  complete.
- Commit early and often inside the worktree; the lease does not
  auto-commit.
- `mars step done <id>` — signal step completion; the workflow advances
  to the next step (auto steps run immediately; the next manual step
  parks awaiting your input).

**Exit gates:**

- The verify step runs automatically after `step done` on the final
  implementation step and gates the merge.
- If verify fails, fix inside the worktree and run `step done` again.
- `mars release --abort <id>` exits without merging; the worktree is
  preserved for inspection.

## Glossary and ADRs

- `CONTEXT.md` — domain glossary. Edit only via `mars glossary
  set/remove`; read via `mars glossary list/show`.
- `docs/adr/NNNN-<slug>.md` — ADRs. Add via `mars adr add`; read via
  `mars adr list/show`. ADR only when hard-to-reverse, surprising, and
  embodying a real trade-off.

Never edit `CONTEXT.md` or `docs/adr/**` directly. Reads are fine.

The `/mars:chat` slash command is the conversational entry point. It
classifies the user's input (an id, free text, or empty) and
dispatches to the right sub-skill: `/mars:action-queue` for triage,
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
waits on `blocker_task_id`). When a task is enqueued with
`--blocked-by <id>`, if any named blocker is not yet `done`, the task
lands in `status='blocked'` immediately; if all named blockers are
already `done`, it lands in `'queued'`. A `blocked` task only flips
to `queued` once **every** one of its blockers reaches `done` — and a
successful recovery counts as its origin reaching `done`, so a
recovered blocker unblocks the whole chain.

When a task fails, the orchestrator spawns exactly **one** recovery
task per origin failure. A recovery task is itself non-recoverable: if
it fails for any reason, the origin goes to `failed` with one
actionable action queue item and the operator resolves it explicitly (e.g.
`mars restart`).

- Create edges at enqueue with `mars task add ... --blocked-by <id>`
  (repeatable; each id must already exist) or after the fact with
  `mars block <task-id> <blocker-id> [<blocker-id> ...]`.
- `mars unblock <id> <blocker-id> ...` removes specific edges (status
  unchanged). `mars unblock <id>` with no blocker ids is
  phantom-recovery: it clears all edges and flips the task to `failed`
  so it can be `mars purge`d or `mars restart`ed.
- A blocker that ends in `failed` leaves its dependents waiting in
  `blocked`; resolve the chain via the action queue item on the failed
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
- **Never `git stash`.** `refs/stash` lives in the common git dir, so every
  Mars worktree shares one stack addressed by shifting positions
  (`stash@{0}`, `stash@{1}`) — a `pop` in one worktree can restore an entry
  pushed by a different task and silently move its uncommitted work into your
  tree. Park changes with `git checkout <ref> -- <paths>`, a wip commit on your
  own branch, or a scratch clone instead.
- Never `cd` between Mars worktrees. Bash CWD persists across tool
  calls, and `mars` resolves the repo from CWD upward — once shifted
  into `.mars/worktrees/<id>/`, every later `mars` call silently binds
  to that worktree's `.mars/` and hits the wrong DB. Use `git -C
  <path>`, tool `--cwd` flags, absolute paths, or `mars --repo <root>
  …`. If a one-off subshell is unavoidable, spell it `(cd <abs-path>
  && …)` so the parent shell never moves.
- The `.mcp.json` at your repo root registers the **codegraph** MCP
  server; install it first (`brew install codegraph` or
  `npm install -g @codegraph/cli`) for the `codegraph_*` tools to
  work.
