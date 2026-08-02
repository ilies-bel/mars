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

**Watch for alerts; don't wait to be asked.** Alerts (kinds `failed`
and `stale-queued`) arrive on their own schedule — a background task can
fail minutes after you enqueued it and moved on. Check at natural
checkpoints, not continuously: at session start, after `mars task add`,
before reporting a batch of work as done, and whenever the user asks what
is happening.

Poll with the filtered listing — never by tailing the event stream:

```
mars action-queue list open --kind failed,stale-queued
```

It prints one tab-separated line per alert (`id  priority  kind  title`)
and nothing at all when clear, so it is cheap enough to run often. The
`GET /events` endpoint is a cursor-paginated JSON trace query (the response
includes `events` and `nextCursor`), useful for after-the-fact inspection of
a task's trace. The daemon's SSE channel is `GET /view/stream`; it sends
payload-free, typed invalidation pings, so clients learn that a view changed
and re-fetch rather than receiving event contents. Do not pull either HTTP
surface into a session for routine alert-watching; use the filtered listing
above.

The action queue is served by the daemon. If the daemon is down the
command exits 1 with `action queue: daemon not running`, and against a
stale `.mars/http.port` it can take minutes to say so. That is "unknown",
not "no alerts" — report it as such rather than as a clean queue. Only
`action queue empty` (exit 0) means there is nothing pending.

When a new alert appears, surface it unprompted — id, kind, title — and
point at `/mars:alerts` for triage. Do not restart, purge, or remove a
worktree without the user's say-so.

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
`--merge auto|gated` (default `auto`; no other values are valid —
the CLI rejects `chore`, `feat`, etc.). Any of them stores a typed
spec; the implementor receives `<files>`, `<verify>`, `<done>`,
`<merge_mode>`, `<task_id>` sections so completion is a checklist. The
slicer always emits structured tasks; free-prose still works and
degrades to prompt-only. Other useful flags: `--priority 0..3 (0 = lowest, 3 = highest — NOT bug-tracker P-numbers)`,
`--tag coder|writer`, `--blocked-by <id>` (repeatable). Always
`mars task add --help` to confirm the current flag surface before
invoking — this CLAUDE.md note may lag the CLI. The inline `"<prompt>"`
form is for genuinely single-line prompts only; use `--prompt-file <path>`
or `-` (stdin) for multi-line prompts.

## Blockers

Blocker edges live in the `task_blockers` junction table (`task_id` waits
on `blocker_task_id`). A blocker stops gating its dependents once it
**settles** — reaches `done` *or* `dropped` (`SETTLED_BLOCKER_STATUSES` /
`UNSETTLED_BLOCKER_SQL` in `orchestrator/src/core/queue.ts` are the single
definition; every gating query shares them). When a task is enqueued with
`--blocked-by <id>`, if any named blocker has not settled the task lands
immediately in `status='blocked'` (never `'queued'`); if all named
blockers have settled, it lands in `'queued'`. A `blocked` task only flips
to `queued` once **every** one of its blockers has settled — and a
successful recovery counts as its origin reaching `done`, so a recovered
blocker unblocks the whole chain. The blocker-resolution outbox subscriber
(`drainBlockerResolution`) drives this on each `task.terminal`
`{ reason: 'done' | 'dropped' }`; a startup reconcile sweep
(`blockerDriftRepair`) normalises any legacy rows that slipped through,
and `orphanedBlockedScan` re-evaluates every `blocked` row at boot so a
crash — or a row stranded before this rule existed — never strands
dependents permanently.

`dropped` settles because it is terminal and can never become `done`:
dropping is an explicit "this work is not happening" decision, it raises
no action queue row to resolve, and `mars drop` (which deletes the row)
already releases dependents inline. `failed` does **not** settle — see
below.

When a task fails, the orchestrator spawns exactly **one** recovery task
per origin failure to finish or fix the work. A recovery task is itself
non-recoverable: if it fails for any reason — the same failure, a
different one, or a watchdog kill — the origin goes to `failed` with one
actionable action queue item and the operator resolves it explicitly
(`mars continue` to resume on the existing worktree — the default — or
`mars restart` to wipe it and start over). There is no retry budget,
retry count, or tunable knob —
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
  `mars continue`d, `mars purge`d or `mars restart`ed.
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
- **Pause / resume dispatch:** `dispatch` is a control lever like any other.
  `mars operator set dispatch off` suspends dispatch (in-flight tasks run to
  completion; no new work is dispatched); `mars operator set dispatch on`
  resumes. There is **no `mars daemon pause` / `mars daemon resume`** — the
  `daemon` group is `start|stop|restart|kill|status|reload` only.
  - The pause is **persisted** to `.mars/daemon.json` as a top-level
    `"paused": true`, so it survives a daemon auto-respawn (a restarted daemon
    comes up paused and logs `[pause] restored persisted paused state`).
  - Dispatch can also be paused **without an operator gesture**: the
    signature-storm circuit breaker (`reason: storm`) and a provider
    rate/spend rejection (`reason: quota`) both pause it. First cause wins —
    a second pause never overwrites the reason.
  - `mars operator set dispatch on` is the single way out of **any** of the
    three. It clears whichever cause holds the pause plus the durable
    signature-storm `tripped` flag, so a later restart does not re-pause the
    queue. Do not wait out the storm breaker's crash/hang fallback timer.
  - Both `mars daemon status` and `mars operator status` render the same
    `DispatchPauseState`, so they always agree on whether dispatch is running
    and why it is not.

## Conventions

- Bun compiles the `mars` CLI into standalone single-file binaries (the
  binary embeds its own runtime; no Bun installation required to run it).
  The orchestrator runs on Node `>=22.13.0` — Bun is not involved there.
- Workflows run on the in-house `@mars/workflow` engine
  (`packages/workflow/`), NOT Mastra (removed). Author them per
  `orchestrator/docs/implement-pipeline.md`; the `mastra` skill no longer
  applies to this repo.
- Never commit `.env`, `.mars/`, or `node_modules`.
- **Recovering a failed task: `continue` before `restart`.** `mars continue
  <id> [<id> ...]` is the **default** recovery verb. It resumes the task on
  its *existing worktree and branch*, reusing every commit the worker already
  landed. A code-phase failure auto-commits any dangling changes as a salvage
  checkpoint, then resumes the coder with a banner explaining that prior work
  is preserved. A pre-setup failure, a missing branch/worktree, or a legacy
  row with no recorded `failed_phase` silently degrades to a restart and
  reports `degradedToRestart: true`. It refuses (non-zero) only for a
  non-`failed` task, or one with an in-flight recovery.
  `mars restart <id>` is the **destructive** sibling: it wipes the worktree
  and branch and re-runs the full pipeline from `setup`, discarding the
  worker's commits. Reach for it only when the existing work is genuinely
  unwanted. Both accept many ids and stop on the first error.
  **A verify failure caused by a poisoned baseline is the textbook
  `continue` case.** When several tasks fail at once with an *identical*
  `verify:*` signature, suspect the shared baseline before the tasks: check
  whether `main` was broken at the moment they branched (typecheck/test it at
  that commit). If so, fix `main`, then `continue` them — never `restart` N
  good worktrees to work around one bad baseline commit.
- **Deleting tasks: `purge` vs `drop`.** `mars purge <id>` only accepts
  terminal tasks (`failed`/`done`/`dropped`) — it refuses anything it
  considers in-flight, and `queued` counts as in-flight. `mars drop <id>
  [--force]` deletes a task in **any** status. Both clean up properly:
  they remove the worktree, the branch, and the task's blocker edges,
  reporting e.g. `worktree=absent; branch=absent; edges=1in/0out`.
  **Never delete task rows with raw SQL.** Deleting a row out from under
  its dependents leaves the `task_blockers` edges dangling and strands
  every dependent in `blocked` forever; deleting an origin whose recovery
  task still points at it produces a
  `setup:origin-worktree-missing` cascade (this has already happened once
  at a scale of 170 tasks). Bulk deletes are slow (~1-3 s each) — run them
  backgrounded in batches, never as one foreground command.
- **Never `git stash`.** `refs/stash` lives in the common git dir, so every
  worktree in this repo shares one stack addressed by shifting positions
  (`stash@{0}`, `stash@{1}`) — and the orchestrator's own checkpoints used to
  live there, so a `pop` can hand you another task's uncommitted work. To park
  changes temporarily, restore individual paths with `git checkout <ref> --
  <paths>` (e.g. `git checkout $(git merge-base HEAD origin/main) -- <file>`),
  commit a wip commit on your own branch, or work in a scratch clone. The
  orchestrator checkpoints to per-task refs (`refs/mars/checkpoint/<task-id>`,
  see `orchestrator/src/core/lib/git/checkpoint.ts`), never to the stash.
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
  than scoping a code task. The same applies to a `mars ui` Bun-server 404
  (default `:7777`, proxied from Vite on `:5173`) for a route in
  `ui/server/index.ts`: restart `mars ui`. Vite hot-reloads the frontend,
  while an already-running API server does not, so the two halves can
  disagree. (Caveat: daemon restart hard-stops in-flight tasks; they
  re-queue.)
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

**An operational error is a loose end.** Whenever a `mars` command is
rejected, a verb turns out to be the wrong one, a flag does not exist, a
query returns something the docs did not predict, or a manual workaround
is needed to get unstuck — **file a task for it in the same breath as
fixing it**. Do not settle for repairing the immediate symptom and
explaining the lesson in chat: chat is discarded, the next session
re-learns it the hard way, and the workaround silently becomes tribal
knowledge. The task should capture the surprising behaviour, the correct
invocation, and where the guardrail belongs (a CLAUDE.md convention, a
clearer CLI error message, or a code fix). Update this file in the same
change when the lesson is a durable convention rather than a bug.

Each task prompt must stand alone. Include:

- file path(s) + symptom,
- suggested fix (with trade-offs if alternatives),
- verification command(s),
- a closing **"Save your work"** line — the orchestrator does not commit
  on the agent's behalf.

For a multi-line prompt, write it to a scratch file and pass that file to the
CLI, for example:

```
mars task add --prompt-file /path/to/prompt.md --intent "..." \\
  --files <path> --verify "<cmd>" --done "<criterion>"
```

Use `mars task add -` when the prompt is already in a pipeline. The inline
`mars task add "..."` form remains available for genuinely single-line
prompts. In every form, `git`/`rm` strings inside the prompt are passed
verbatim to the dispatched agent and do not trip the outer shell's hooks.
