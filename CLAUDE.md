# CLAUDE.md

## Mars Framework

TypeScript CLI (`mars`) + orchestrator running Claude Code in parallel
git worktrees, read-only frontend (`ui/`), design drafts (`design/`).

## Routing

Route silently between three actions: enqueue (`mars task add "..."`),
grill conversationally, or edit directly. Never name the routes, narrate
the decision, or ask the user to pick. Reads and searches are always
direct.

Enqueue by default. Grill instead when any of these hold:

- shape is exploratory or tentative ("should we…", "thinking about…");
- introduces or redefines a term, or affects `CONTEXT.md` / ADRs;
- cross-cutting or architectural trade-off (new seam, dependency, data
  shape, hard-to-reverse choice);
- acceptance criteria or scope are unclear;
- conflicts with an existing ADR, invariant, or queued work.

If both signals fire, grill — by asking a sharpening question, not by
asking the user to choose. Edit directly only when the user explicitly
opts in for this session.

## Tasks

Tasks live in `.mars/queue.db`. Enqueue via `mars task add "..."`; the
orchestrator dispatches automatically (worktree → code → verify → merge).
Inspect via `mars list` or Mastra Studio.

Default mutations route through the orchestrator. Direct `Edit`/`Write`
on the working tree only when the user has explicitly opted in for this
session.

## Top-level directories

- `orchestrator/` — Mastra-driven orchestrator. Headless Claude Code in
  parallel worktrees → verify → fast-forward into `main`. Conflicts go
  to `vcs-supervisor` ("Vega"). Node `>=22.13.0`.
- `.mars/` — per-repo state (`state.db`, `queue.db`, `mastra.db`,
  `worktrees/<task-id>/`, `.merge.lock`). Gitignored.

## Key concepts

- **`mars context search/tree`** — deterministic, no-network, no-LLM
  codebase context (`rg --json` + filtered tree). Prefer over ad-hoc grep.
- **Orchestrator workflow** — 4 steps: `setup` (worktree on `task/<id>` off
  `main`) → `code` (`claude -p`) → `verify` → `merge` (serialized via file
  lock; coding parallel).
- **Merge target** — `main`. Override per-invocation with
  `INTEGRATION_BRANCH=<branch>`.

## Glossary and ADRs

- `CONTEXT.md` — domain glossary. Edit only via `mars glossary
  set/remove`; read via `mars glossary list/show`.
- `docs/adr/NNNN-<slug>.md` — ADRs. Add via `mars adr add`; read via
  `mars adr list/show`. ADR only when hard-to-reverse, surprising, and
  embodying a real trade-off.

Never edit `CONTEXT.md` or `docs/adr/**` directly. Reads are fine.

## Structured tasks

`mars task add` accepts `--files`, `--verify`, `--done`, `--type`. Any of
them stores a typed spec; the implementor receives `<files>`, `<verify>`,
`<done>`, `<task_type>`, `<task_id>` sections so completion is a
checklist. The slicer always emits structured tasks; free-prose still
works and degrades to prompt-only.

## Blockers

Blocker edges live in the `task_blockers` junction table (`task_id` waits
on `blocker_task_id`). A task in `blocked` only flips to `queued` once
**every** one of its blockers reaches `done`; the daemon's
`onBlockerTaskCompleted` runs on each completion, and `recoverBlockedTasks`
re-checks at daemon startup so a crash between completion and unblock
doesn't strand work.

- Create edges at enqueue with `mars task add ... --blocked-by <id>`
  (repeatable; each id must already exist) or after the fact with
  `mars block <task-id> <blocker-id> [<blocker-id> ...]`.
- `mars unblock <id> <blocker-id> ...` removes specific edges (status
  unchanged). `mars unblock <id>` with no blocker ids is phantom-recovery:
  it clears all edges and flips the task to `failed` so it can be
  `mars purge`d or `mars restart`ed.
- Dependents whose retry budget is already exhausted at unblock time go
  to `failed` with an inbox item rather than `queued`.
- Coders that can't make progress should emit a `--blocked-by $TASK_ID`
  follow-up instead of bailing; the deviation-rules brief in the
  orchestrator notes spells this out.

## Orchestrator notes

- Coder runs get a deviation-rules brief: no bailing without an auto-fix
  commit, a `--blocked-by $TASK_ID` follow-up, or a `mars idea add`. A
  watcher SIGKILLs after 5 consecutive Read/Grep/Glob calls without an
  Edit/Write/Bash (`MARS_READ_SPAN_LIMIT` to override) and parks the
  task in `blocked` with a context-gathering child as blocker.
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
