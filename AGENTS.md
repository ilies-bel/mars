# CLAUDE.md

## Mars Framework

TypeScript CLI (`mars`) + provider-agnostic orchestrator running agent CLIs in parallel
git worktrees, read-only frontend (`ui/`), design drafts (`design/`).

## Project status

Mars is an ongoing project with no external users yet. **Every change is
a hard cut.** No backwards-compat shims, no deprecation aliases, no
"keep both for now" — rename, move, or delete in one step and update
every call site in the same change. No feature flags or migration
windows for internal API churn. If a name, signature, or schema is
wrong, fix it everywhere now; do not leave the old form behind.

## Routing

Route silently between three pipelines — never name the route, narrate
the decision, or ask the user to pick. Reads and searches are always
direct.

**General rule:** run `mars workflow list` to see every available
pipeline. Each is a runbook with declared execution modes and Step
guides, renderable via `mars workflow validate <name>`. Pick the
pipeline whose shape fits the work and select it at enqueue with
`--workflow <name>`.

The three lines:

1. **Hard / cross-repo / term-defining work → grill first.** While
   grilling, file `mars proposal add` for out-of-scope observations
   and enqueue high-confidence loose ends directly (`mars task add`).
2. **Small tweaks / backend work → background task.** `mars task add
   "..."` — the orchestrator dispatches, codes, verifies, and merges
   headlessly.
3. **Visual or user-present work → live task.** `mars task add --live`,
   then `mars attach <id>` to lease the worktree and work the Step
   guide interactively. The verify + merge gate is the exit condition.

**Direct editing on `main` is a last resort, not a fourth route.** It
is never silent and never implied. The bar is all of:

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

Tasks live in the embedded PostgreSQL database the daemon provisions
per repo (data dir `.mars/pg/data`, DSN published to `.mars/pg.dsn` —
read the file, never guess the port). A legacy `.mars/mars.db` is
imported once by `orchestrator/src/init/import-sqlite.ts` on first
start and renamed to `mars.db.bak-<ts>`; any `mars.db*` / `queue.db` /
`state.db` files on disk are dead pre-import artifacts, NOT the live
data. Enqueue via `mars task add "..."`; the orchestrator dispatches
automatically (worktree → code → verify → merge). Inspect via `mars
list`. For direct reads, query with `psql "$(cat .mars/pg.dsn)"`
(tables `tasks`, `task_blockers`, …).

**All mutations route through the orchestrator.** Direct `Edit`/`Write`
on the working tree (i.e. on `main`) is a last resort — see Routing
above. Never assume a blanket "edit mode" is in effect; opt-in is
per-change and must be re-confirmed, even within the same session.

## Top-level directories

- `orchestrator/` — the orchestrator, running on the in-house
  `@mars/workflow` engine (`packages/workflow/`). Headless provider agents in
  parallel worktrees → verify → fast-forward into `main`. Conflicts go
  to `vcs-supervisor` ("Vega"). Node `>=22.13.0`.
- `.mars/` — per-repo state (`pg/data/` — the embedded Postgres data
  dir; `pg.dsn`/`pg.port` — published connection info;
  `worktrees/<task-id>/`, `.merge.lock`). Gitignored. Any
  `mars.db*`/`queue.db`/`state.db` on disk are dead pre-import
  artifacts.

## Live execution

When you attach to a live task (`mars attach <id>`), the worktree is
leased and the workflow renders its Step guide (the runbook for that
pipeline).

**Handoff:** on attach, read the Step guide in full before touching
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

## Key concepts

- **Orchestrator workflow** — 4 steps: `setup` (worktree on `task/<id>` off
  `main`) → `code` (selected provider CLI) → `verify` → `merge` (serialized via file
  lock; coding parallel).
- **Merge target** — `main`. Override per-invocation with
  `INTEGRATION_BRANCH=<branch>`.

## The action queue

The Mars action queue is the single human-facing work surface. Everything that
needs the user — operational alerts from self-heal, tasks the orchestrator
stopped on after exhausting retries (kind `task-blocked`), and draft proposals
waiting to be shaped (kind `draft-proposal`) — appears as an action queue
message. Pick one via `mars action-queue list` or `/mars:action-queue`; the action queue
dispatches to the right resolver (`/mars:unblock`, `/mars:grill`, or
terminal restart/purge — the queue is a pure projection, no operator gesture closes a row). To see pending work, run `/mars:chat` or `/mars:action-queue`.

## Glossary and ADRs

- `CONTEXT.md` — domain glossary. Edit only via `mars glossary
  set/remove`; read via `mars glossary list/show`.
- `docs/adr/NNNN-<slug>.md` — ADRs. Add via `mars adr add`; read via
  `mars adr list/show`. ADR only when hard-to-reverse, surprising, and
  embodying a real trade-off.

Never edit `CONTEXT.md` or `docs/adr/**` directly. Reads are fine.

The `/mars:chat` slash command is the conversational entry point.
It classifies the user's input (an id, free text, or empty) and
dispatches to the right sub-skill: `/mars:action-queue` for triage,
`/mars:task` for quick enqueues, `/mars:grill` for ideas that need
PRD-shaping, `/mars:unblock` for stuck tasks. Sub-skills update the
glossary and ADRs inline as decisions crystallise — `/mars:chat`
itself writes nothing to those files.

## Structured tasks

`mars task add` accepts `--files`, `--verify`, `--done`, and
`--type auto|checkpoint` (default `auto`; no other values are valid —
the CLI rejects `chore`, `feat`, etc.). Any of them stores a typed
spec; the implementor receives `<files>`, `<verify>`, `<done>`,
`<task_type>`, `<task_id>` sections so completion is a checklist. The
slicer always emits structured tasks; free-prose still works and
degrades to prompt-only. Other useful flags: `--priority 0..3 (0 = lowest, 3 = highest — NOT bug-tracker P-numbers)`,
`--tag coder|writer`, `--blocked-by <id>` (repeatable). Always
`mars task add --help` to confirm the current flag surface before
invoking — this CLAUDE.md note may lag the CLI.

## Blockers

Blocker edges live in the `task_blockers` junction table (`task_id` waits
on `blocker_task_id`). When a task is enqueued with `--blocked-by <id>`,
if any named blocker is not yet `done`, the task lands immediately in
`status='blocked'` (never `'queued'`); if all named blockers are already
`done`, it lands in `'queued'`. A `blocked` task only flips to `queued`
once **every** one of its blockers reaches `done` — and a successful
recovery counts as its origin reaching `done`, so a recovered blocker
unblocks the whole chain. The blocker-resolution outbox subscriber
(`drainBlockerResolution`) drives this on each completion; a startup
reconcile sweep (`blockerDriftRepair`) normalises any legacy rows that
slipped through so a crash never strands dependents permanently.

When a task fails, the orchestrator spawns exactly **one** recovery task
per origin failure to finish or fix the work. A recovery task is itself
non-recoverable: if it fails for any reason — the same failure, a
different one, or a watchdog kill — the origin goes to `failed` with one
actionable action queue item and the operator resolves it explicitly (e.g.
`mars restart`). There is no retry budget, retry count, or tunable knob —
exactly one recovery attempt per origin failure, full stop.

Recovery tasks are **leaf nodes** in the task graph (ADR-0040): they
cannot have blockers, cannot be blocked by anything, and the
blocker-cascade does not recurse through them. The `task_blockers`
insertion path rejects any edge whose either endpoint is a recovery
task; the one legitimate origin→recovery edge is written by the
recovery-spawn path itself.

- Create edges at enqueue with `mars task add ... --blocked-by <id>`
  (repeatable; each id must already exist) or after the fact with
  `mars block <task-id> <blocker-id> [<blocker-id> ...]`.
- `mars unblock <id> <blocker-id> ...` removes specific edges (status
  unchanged). `mars unblock <id>` with no blocker ids is phantom-recovery:
  it clears all edges and flips the task to `failed` so it can be
  `mars purge`d or `mars restart`ed.
- A blocker that ends in `failed` leaves its dependents waiting in
  `blocked`; resolve the chain via the action queue item on the failed blocker
  (the failure does not cascade down the chain — behaviour unchanged).
- Coders that can't make progress should emit a `--blocked-by $TASK_ID`
  follow-up instead of bailing; the deviation-rules brief in the
  orchestrator notes spells this out.

## Orchestrator notes

- Coder runs get a deviation-rules brief: no bailing without an auto-fix
  commit, a `--blocked-by $TASK_ID` follow-up, or a `mars proposal add`.
- **Worker provider and models:** Codex is the default. `defaultProvider` in
  `.mars/daemon.json` selects Codex, Claude, or Gemini for every Worker;
  `MARS_WORKER_PROVIDER` is the one-daemon override. Providers translate the
  flagship/balanced/fast tiers to native model ids. Codex uses
  `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` through `codex exec` and
  reuses the local `codex login` session. `MARS_WORKER_MODEL` overrides only
  the Coder model.
- To inspect live runs, open `mars ui` (read-only Kanban + trace dashboard)
  or query the daemon HTTP API: read `PORT=$(cat .mars/http.port)` first —
  the daemon binds an OS-assigned ephemeral port (see Conventions).
- **Incident kill-switch:** `mars operator set recovery on|off` suppresses
  fix-task / Investigator spawns (persisted across daemon
  restarts). Toggle off during failure storms (e.g. quota cascades) to stop
  the self-heal cycle while you diagnose.

## Conventions

- Bun compiles the `mars` CLI into standalone single-file binaries (the
  binary embeds its own runtime; no Bun installation required to run it).
  The orchestrator runs on Node `>=22.13.0` — Bun is not involved there.
- Workflows run on the in-house `@mars/workflow` engine
  (`packages/workflow/`), NOT Mastra (removed). Author them per
  `orchestrator/docs/implement-pipeline.md`; the `mastra` skill no longer
  applies to this repo.
- Never commit `.env`, `.mars/`, or `node_modules`.
- Never `cd`. Bash CWD persists across tool calls, and `mars` resolves
  the repo from CWD upward — once shifted into `.mars/worktrees/<id>/`,
  every later `mars` call silently binds to that worktree's `.mars/` and
  hits the wrong DB. Use `git -C <path>`, tool `--cwd` flags, absolute
  paths, or `mars --repo <root> …`. If a one-off subshell is unavoidable,
  spell it `(cd <abs-path> && …)` so the parent shell never moves.
- The daemon's HTTP server binds an OS-assigned ephemeral port
  (`listen(0, '127.0.0.1', ...)` in
  `orchestrator/src/core/daemon/http-server.ts`) and publishes it to
  `.mars/http.port`. To reach the daemon API (e.g. `/failure-reasons`,
  `/events`), read `PORT=$(cat .mars/http.port)` first — never guess the
  port. A 200 from a guessed port is usually an unrelated server (the
  UI/Vite catch-all returns index.html for any path), so a
  guessed-port probe proves nothing.
- A 404 on a daemon route that exists in source usually means the running
  daemon predates that route — restart with `mars daemon restart` rather
  than scoping a code task. (Caveat: restart hard-stops in-flight tasks;
  they re-queue.)
- Before enqueueing a task off a `tsc`/build error, confirm the error
  actually reproduces in the correct directory (use
  `(cd <abs-path> && npx tsc --noEmit)`, not a bare `cd`) and run it
  twice — transient `node_modules`/install states have produced phantom
  TS2307 'cannot find module' errors that vanish on re-run. Only an error
  that reproduces in the isolated, correct context belongs in a task
  prompt.

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

## Bundled templates

The `.claude/` template tree that consumers receive via `mars init` /
`mars update` is maintained in `orchestrator/src/init/templates/` and
bundled at author time, not at consumer install time.

**Maintainer refresh.** When the framework's `.claude/` source tree
changes, run `npm run mars:bundle:refresh` (alias: `sync-claude-templates`)
from the `orchestrator/` directory. This copies the canonical `.claude/`
tree into the bundle path so the next release ships the updated templates.

**CI drift gate.** A CI job (`template-sync-check`) runs on every PR. It
re-runs `mars:bundle:refresh` and fails the PR if the result differs from
what is already committed — i.e. if the bundled templates have drifted
from the framework's `.claude/` source tree. Run the refresh command and
commit the result before pushing.

**No build-time side effect.** The `prebuild` and `pretest` hooks no
longer trigger a template sync. The bundle is refreshed only when a
maintainer explicitly runs `mars:bundle:refresh`. This supersedes the old
expectation that `npm run build` or `npm test` would keep the bundle
current.

**Consumer-side UX is unchanged.** `mars init` and `mars update` continue
to work exactly as before — they expand the bundled templates into the
target repo. Only the maintainer-side refresh mechanism changed.

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

**Closing ritual:** at natural stopping points, suggest the operator
run `mars arc reflect <originId>` in a separate terminal to surface
patterns from the session and land draft proposals.
