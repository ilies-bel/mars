# CLAUDE.md

## Mars Framework

TypeScript CLI (`mars`) + orchestrator running Claude Code in parallel
git worktrees, read-only frontend (`ui/`), design drafts (`design/`).

## Project status

Mars is an ongoing project with no external users yet. **Every change is
a hard cut.** No backwards-compat shims, no deprecation aliases, no
"keep both for now" — rename, move, or delete in one step and update
every call site in the same change. No feature flags or migration
windows for internal API churn. If a name, signature, or schema is
wrong, fix it everywhere now; do not leave the old form behind.

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

**Direct editing on `main` is a last resort, not a third route.** It is
never silent and never implied. The bar is all of:

- the user explicitly opts in *for this specific change* (a prior
  session-level "you can edit directly" does **not** carry over);
- the orchestrator path is genuinely unavailable or unsuitable (e.g.
  the orchestrator itself is broken, or the change is a single-line
  CLAUDE.md / docs tweak the user just dictated);
- you state out loud that you are bypassing the orchestrator and why,
  before the first `Edit`/`Write`.

When in doubt, enqueue. A redundant task is cheap; a silent commit on
`main` is not.

## Tasks

Prefer `/mars:task <prompt>` from a Claude Code session for a
light-shaping wrapper that checks terminology against the glossary
before enqueueing.

Tasks live in `.mars/queue.db`. Enqueue via `mars task add "..."`; the
orchestrator dispatches automatically (worktree → code → verify → merge).
Inspect via `mars list` or Mastra Studio.

**All mutations route through the orchestrator.** Direct `Edit`/`Write`
on the working tree (i.e. on `main`) is a last resort — see Routing
above. Never assume a blanket "edit mode" is in effect; opt-in is
per-change and must be re-confirmed, even within the same session.

## Top-level directories

- `orchestrator/` — Mastra-driven orchestrator. Headless Claude Code in
  parallel worktrees → verify → fast-forward into `main`. Conflicts go
  to `vcs-supervisor` ("Vega"). Node `>=22.13.0`.
- `.mars/` — per-repo state (`state.db`, `queue.db`, `mastra.db`,
  `worktrees/<task-id>/`, `.merge.lock`). Gitignored.

## Key concepts

- **Orchestrator workflow** — 4 steps: `setup` (worktree on `task/<id>` off
  `main`) → `code` (`claude -p`) → `verify` → `merge` (serialized via file
  lock; coding parallel).
- **Merge target** — `main`. Override per-invocation with
  `INTEGRATION_BRANCH=<branch>`.

## The inbox

The Mars inbox is the single human-facing work surface. Everything that
needs the user — operational alerts from self-heal, tasks the orchestrator
stopped on after exhausting retries (kind `task-blocked`), and draft ideas
waiting to be shaped (kind `idea-needs-shaping`) — appears as an inbox
message. Pick one via `mars inbox list` or `/mars:inbox`; the inbox
dispatches to the right resolver (`/mars:unblock`, `/mars:grill`, or
ack/resolve/dismiss). A `SessionStart` hook runs `mars inbox --lean` so
the current inbox state primes every Claude Code session.

## Glossary and ADRs

- `CONTEXT.md` — domain glossary. Edit only via `mars glossary
  set/remove`; read via `mars glossary list/show`.
- `docs/adr/NNNN-<slug>.md` — ADRs. Add via `mars adr add`; read via
  `mars adr list/show`. ADR only when hard-to-reverse, surprising, and
  embodying a real trade-off.

Never edit `CONTEXT.md` or `docs/adr/**` directly. Reads are fine.

The `/mars:chat` slash command is the conversational entry point.
It classifies the user's input (an id, free text, or empty) and
dispatches to the right sub-skill: `/mars:inbox` for triage,
`/mars:task` for quick enqueues, `/mars:grill` for ideas that need
PRD-shaping, `/mars:unblock` for stuck tasks. Sub-skills update the
glossary and ADRs inline as decisions crystallise — `/mars:chat`
itself writes nothing to those files.

## Structured tasks

`mars task add` accepts `--files`, `--verify`, `--done`, `--type`. Any of
them stores a typed spec; the implementor receives `<files>`, `<verify>`,
`<done>`, `<task_type>`, `<task_id>` sections so completion is a
checklist. The slicer always emits structured tasks; free-prose still
works and degrades to prompt-only.

## Blockers

Blocker edges live in the `task_blockers` junction table (`task_id` waits
on `blocker_task_id`). A task in `blocked` only flips to `queued` once
**every** one of its blockers reaches `done` — and a successful recovery
counts as its origin reaching `done`, so a recovered blocker unblocks the
whole chain. The daemon's `onBlockerTaskCompleted` runs on each
completion, and `recoverBlockedTasks` re-checks at daemon startup so a
crash between completion and unblock doesn't strand work.

When a task fails, the orchestrator spawns exactly **one** recovery task
per origin failure to finish or fix the work. A recovery task is itself
non-recoverable: if it fails for any reason — the same failure, a
different one, or a watchdog kill — the origin goes to `failed` with one
actionable inbox item and the operator resolves it explicitly (e.g.
`mars restart`). There is no retry budget, retry count, or tunable knob —
exactly one recovery attempt per origin failure, full stop.

- Create edges at enqueue with `mars task add ... --blocked-by <id>`
  (repeatable; each id must already exist) or after the fact with
  `mars block <task-id> <blocker-id> [<blocker-id> ...]`.
- `mars unblock <id> <blocker-id> ...` removes specific edges (status
  unchanged). `mars unblock <id>` with no blocker ids is phantom-recovery:
  it clears all edges and flips the task to `failed` so it can be
  `mars purge`d or `mars restart`ed.
- A blocker that ends in `failed` leaves its dependents waiting in
  `blocked`; resolve the chain via the inbox item on the failed blocker
  (the failure does not cascade down the chain — behaviour unchanged).
- Coders that can't make progress should emit a `--blocked-by $TASK_ID`
  follow-up instead of bailing; the deviation-rules brief in the
  orchestrator notes spells this out.

## Orchestrator notes

- Coder runs get a deviation-rules brief: no bailing without an auto-fix
  commit, a `--blocked-by $TASK_ID` follow-up, or a `mars idea add`. A
  watcher logs (but does not abort) once a coder makes 5+ consecutive
  Read/Grep/Glob calls without an Edit/Write/Bash; override the threshold
  via `MARS_READ_SPAN_LIMIT`.
- **Worker models (defaults):** Coder → `claude-sonnet-4-6`, Fixer →
  `claude-opus-4-7` (recovery resilience), Writer → `claude-haiku-4-5-20251001`,
  Planner/Slicer → `claude-opus-4-7` (architectural reasoning), Triager →
  `claude-sonnet-4-6`. Override the Coder model for the lifetime of a daemon
  process via `MARS_WORKER_MODEL=<model>` (e.g. `MARS_WORKER_MODEL=claude-opus-4-7`
  for a high-complexity session). Planner, Slicer, Writer, and Fixer models are
  always pinned; only Coder is overridable.
- Inspect runs at `http://localhost:4111` (`cd orchestrator && npm run dev`).

## Conventions

- Bun for the framework CLI; Node `>=22.13.0` for the orchestrator.
- Mastra APIs churn — load the `mastra` skill before touching
  `orchestrator/src/mastra/**`.
- Register new Mastra agents/tools/workflows/scorers in
  `orchestrator/src/mastra/index.ts`.
- Never commit `.env`, `.mars/`, or `node_modules`.
- Never `cd`. Bash CWD persists across tool calls, and `mars` resolves
  the repo from CWD upward — once shifted into `.mars/worktrees/<id>/`,
  every later `mars` call silently binds to that worktree's `.mars/` and
  hits the wrong DB. Use `git -C <path>`, tool `--cwd` flags, absolute
  paths, or `mars --repo <root> …`. If a one-off subshell is unavoidable,
  spell it `(cd <abs-path> && …)` so the parent shell never moves.

## Installation

There are two install routes, for two different audiences:

- **Prod consumers** install the `mars` CLI with a one-liner
  curl-pipe-bash bootstrap — `curl -sSL
  https://github.com/<org>/mars-framework/releases/latest/download/get-mars.sh
  | bash`. It detects OS/arch, downloads the matching prebuilt binary
  from the latest GitHub Release, verifies its sha256, and drops `mars`
  onto PATH. This is the route to point users at; it needs no clone and
  no dev toolchain.
- **Dev consumers** run `install.sh` from a clone of this repo. It does
  *not* produce a compiled Bun binary — it writes a small tsx wrapper
  that runs the CLI from source and symlinks that tsx wrapper onto PATH,
  so source edits go live immediately. This is a dev-only flow; prod
  consumers should use the bootstrap above instead.

## Loose ends

Enqueue the moment you spot one — **one `mars task add` per item**, no
batching, no MEMORY.md, no markdown TODOs. Only concrete, actionable work
the user has seen. If user says "skip", drop it. At stopping points
("looks good", "ship it"), do a final sweep as a safety net.

Each task prompt must stand alone. Include:

- file path(s) + symptom,
- suggested fix (with trade-offs if alternatives),
- verification command(s),
- a closing **"Save your work"** line — the orchestrator does not commit
  on the agent's behalf.

The `mars task add "..."` outer call is a CLI invocation; any `git`/`rm`
strings inside the heredoc'd prompt are passed verbatim to the dispatched
agent and don't trip the outer shell's hooks.
