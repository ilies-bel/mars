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

**Direct edits on `main` race the merge step.** Every merge is a
rebase→verify→ff loop: the landing task branch is rebased onto
`main` and verified in its own worktree, then fast-forwarded in under
`.merge.lock`. `main` itself stays a live checkout the whole time — it
is never reset out from under you — and an in-flight merge simply
rebases over any commit you land on `main` while it is running, the
same as it would over any other task's landing.

That means everything on `main` must be a commit; uncommitted edits are
not a stable unit the merge can rebase over. What happens to them
depends on the operator auto-commit lever:

- **Lever on (default):** the merge step auto-commits your tracked
  modifications on `main` as `wip(operator): auto-committed to unblock
  merge of <task>`, then continues. You get a Notice that this happened
  (with how to disable the lever) — not a failure. A cheap typecheck
  probe runs afterward and raises an Alert if the auto-commit broke the
  baseline; the merge itself proceeds either way.
- **Lever off:** the merge step declines to touch your uncommitted
  edits at all — you get an Alert and the queue parks behind the
  dirty-main guard until you commit or clean up by hand.

Either way, **commit early** while editing `main` directly: a real
commit is durable, legible, and rebases cleanly; uncommitted edits are
just something to clean up later. Never `git stash` — `refs/stash` is
shared by every worktree in this repo.

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

**Querying the database directly — timestamp and column-name pitfalls.**
Timestamp encodings and lifecycle-column names are mixed across tables.
Use the correct expression for each table or you get a hard error or a
silently wrong result:

- `tasks.created_at` / `tasks.updated_at` — **`timestamptz`**.
  Format: `to_char(created_at, 'MM-DD HH24:MI')`.
  Example: `SELECT id, to_char(created_at,'MM-DD HH24:MI') FROM tasks LIMIT 5;`

- `chat_threads.created_at` / `chat_threads.updated_at` — **`bigint` epoch-milliseconds**.
  Format: `to_char(to_timestamp(created_at / 1000.0), 'MM-DD HH24:MI')`.
  Example: `SELECT id, to_char(to_timestamp(created_at/1000.0),'MM-DD HH24:MI') FROM chat_threads LIMIT 5;`

- `action_queue_items` — creation timestamp is **`raised_at`** (not `created_at`),
  lifecycle column is **`status`** (not `state`), both `bigint` epoch-milliseconds.
  Format: `to_char(to_timestamp(raised_at / 1000.0), 'MM-DD HH24:MI')`.
  Example: `SELECT id, kind, status, to_char(to_timestamp(raised_at/1000.0),'MM-DD HH24:MI') AS raised FROM action_queue_items LIMIT 5;`

- `task_blockers.state` — legitimately named `state` (a distinct domain concept:
  blocker confirmation state). Do not confuse it with the lifecycle `status` columns.

The full encoding registry lives in
`orchestrator/src/core/lib/pg-schema.ts` (the leading doc comment) and
`orchestrator/src/core/lib/timestamp-encodings.ts`.

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
- `mars task check <id> <n>` — mark a done-criterion as complete, where
  `<n>` is the 1-based index into the `--done` criteria, in declaration
  order (not the criterion text).
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
stopped on after exhausting retries (kind `failed`), and draft proposals
waiting to be shaped (kind `draft-proposal`) — appears as an action queue
message. Pick one via `mars action-queue list` or `/mars:action-queue`; the action queue
dispatches to the right resolver (`/mars:unblock`, `/mars:grill`, or
terminal restart/purge). To see pending work, run `/mars:chat` or `/mars:action-queue`.

**Action queue architecture (ADR-0094, building on ADR-0048).** The queue has two distinct row
kinds:

- **Condition kinds** (`failed`, `stale-queued`, `gate-broken`,
  `baseline-broken`, `daemon-died`, `daemon-code-drift`,
  `subscriber-stalled`, `signature-storm`, `stale-worktree`,
  `phantom-task`, `worktree-ahead`, `orphaned-origin`, `steward-repeat`)
  are **derived on read** from live system state — no stored row, no
  raiser, no sweep. A condition that does not hold is unrepresentable;
  stale alerts cannot accumulate.
- **Operator-decision kinds** (`draft-proposal`, `plan-approval`,
  `awaiting-human`, `gate-enrichment`, `scorer-suggested`,
  `reflect-recommended`) carry operator-authored content. Each is
  stored as a row and closed atomically in the same transaction as the
  mutation that resolves it — no sweep, no reconcile.

The rule is: **a row exists only when it carries content that cannot be
recomputed from live state.**

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

On stdout it prints one tab-separated line per alert (`id  priority  kind
title`) and nothing at all when clear — stdout is purely machine-readable,
so a poller can diff its lines safely. The human-readable confirmation
(`action queue empty`) goes to stderr, not stdout, precisely so it can never
be mistaken for a row; this is cheap enough to run often. The
`GET /events` endpoint is a cursor-paginated JSON trace query (the response
includes `events` and `nextCursor`), useful for after-the-fact inspection of
a task's trace. The daemon's SSE channel is `GET /view/stream`; it sends
payload-free, typed invalidation pings, so clients learn that a view changed
and re-fetch rather than receiving event contents. Do not pull either HTTP
surface into a session for routine alert-watching; use the filtered listing
above.

The action queue is served by the daemon. If the daemon is down the
command exits 1 with `action queue: daemon not running` on stderr, and
against a stale `.mars/http.port` it can take minutes to say so. That is
"unknown", not "no alerts" — report it as such rather than as a clean
queue. Only exit 0 with empty stdout (echoed as `action queue empty` on
stderr) means there is nothing pending.

When a new alert appears, surface it unprompted — id, kind, title — and
point at `/mars:alerts` for triage. Do not restart, purge, or remove a
worktree without the user's say-so.

## Glossary and ADRs

- `CONTEXT.md` — domain glossary. Edit only via `mars glossary
  set/remove`; read via `mars glossary list/show`.
- `docs/knowledge/decisions/NNNN-<slug>.md` — ADRs. Add via `mars adr add`; read via
  `mars adr list/show`. ADR only when hard-to-reverse, surprising, and
  embodying a real trade-off.

Never edit `CONTEXT.md` or `docs/knowledge/decisions/**` directly. Reads are fine.

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

**`--verify` must use relative paths.** The verify step runs inside the
task's git worktree, not the main checkout. An absolute path like
`(cd /abs/path/to/repo/orchestrator && npm test)` escapes worktree
isolation: it runs against `main`'s tree, not the task branch, producing
false-green verifies or verifies that can never pass (the fix lives in the
worktree, not in main). `mars task add` rejects such specs at enqueue time.
Use a path relative to the worktree root instead:

```
--verify 'cd orchestrator && npm test'          # ✓ relative
--verify '(cd /abs/path/to/repo && npm test)'  # ✗ rejected — absolute repo path
```

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
  `.mars/daemon.json` selects Codex, Claude, or Gemini for every **un-pinned**
  (built-in) Worker; operator-added workers that explicitly set a `provider`
  in the registry keep their pin and are unaffected by `defaultProvider`.
  `MARS_WORKER_PROVIDER` is the one-daemon override (same scope: un-pinned
  workers only). Providers translate the flagship/balanced/fast tiers to
  native model ids. Codex uses `gpt-5.6-sol` / `gpt-5.6-terra` /
  `gpt-5.6-luna` through `codex exec` and reuses the local `codex login`
  session. `MARS_WORKER_MODEL` overrides only the Coder model.
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
  `daemon` group is `start|stop|restart|kill|status|reload|reset-breaker`
  only.
  - The pause is **persisted** to `.mars/daemon.json` as a top-level
    `"paused": true`, so it survives a daemon auto-respawn (a restarted daemon
    comes up paused and logs `[pause] restored persisted paused state`).
  - Dispatch can also be paused **without an operator gesture**: the
    signature-storm circuit breaker (`reason: storm`) and a provider
    rate/spend rejection (`reason: quota`) both pause it. First cause wins —
    a second pause never overwrites the reason.
  - `mars operator set dispatch on` is the general way out of **any** of the
    three pause causes: it resumes dispatch unconditionally (operator, storm,
    or quota) and also clears the durable signature-storm `tripped` flag as a
    side effect, so a later restart does not re-pause the queue. Do not wait
    out the storm breaker's crash/hang fallback timer.
  - `mars daemon reset-breaker` is the purpose-built way to clear a **tripped
    storm breaker specifically** — it is what `mars daemon status` itself
    recommends when tripped (`run 'mars daemon reset-breaker' to clear`). It
    always clears the durable `tripped`/streak state, but only resumes
    dispatch if the current pause reason is `storm`; a pause held for
    `operator` or `quota` is left completely untouched, so that pause still
    needs `mars operator set dispatch on` (or resolving the quota condition)
    to lift. Prefer `reset-breaker` when you only want to clear the breaker
    without touching an unrelated pause; reach for `set dispatch on` when you
    want dispatch running again regardless of cause.
  - Both `mars daemon status` and `mars operator status` render the same
    `DispatchPauseState`, so they always agree on whether dispatch is running
    and why it is not.

## Conventions

- **Prose-body inputs: always use `@<path>` or `-` for multi-line or
  shell-special content.** The CLI processes text after the shell has already
  evaluated it — backticks and `$(...)` in an inline `"..."` argument are
  expanded (or silently deleted) before the process starts, corrupting the
  stored text with no signal. The correct forms are:
  - `@<path>` — reads the file verbatim (one trailing newline stripped)
  - `-` — reads stdin verbatim (one trailing newline stripped)
  - `"<inline>"` — safe only for genuinely short, shell-neutral values
  These three shapes are accepted by: `mars task add`, `mars task note`,
  `mars proposal add`, `mars glossary set` (definition argument), and
  `mars adr add`. Do not use bare inline quotes for any body that may
  contain backticks, `$(...)`, newlines, or other shell metacharacters.

- Bun compiles the `mars` CLI into standalone single-file binaries (the
  binary embeds its own runtime; no Bun installation required to run it).
  The orchestrator runs on Node `>=22.13.0` — Bun is not involved there.
- Workflows run on the in-house `@mars/workflow` engine
  (`packages/workflow/`), NOT Mastra (removed). Author them per
  `orchestrator/docs/implement-pipeline.md`; the `mastra` skill no longer
  applies to this repo.
- Never commit `.env`, `.mars/`, or `node_modules`.
- **Read git state through `rtk proxy git …`, never bare `git`.** The RTK
  shell hook compresses command output lossily and has been observed
  *replaying a different commit* for `git log -1 <sha>`, and returning a
  `rev-parse main` that disagreed with `git log main` in the same breath. It
  also rewrites `grep` output into a `[file] <n> (1):` form with the real
  paths replaced by numbers. Any decision made from those reads — which
  commit to merge, reset, or fast-forward to — can be silently wrong. Use
  `rtk proxy` for every git read whose answer you are about to act on
  (`rev-parse`, `log`, `status --porcelain`, `rev-list --count`,
  `merge-base`), and treat a bare-`git` answer that "stops making sense" as
  the hook lying rather than as a strange repo state.
- **Recovering a failed task: `continue` before `restart`.** `mars continue
  <id> [<id> ...]` is the **default** recovery verb. It resumes the task on
  its *existing worktree and branch*, reusing every commit the worker already
  landed. A code-phase failure auto-commits any dangling changes as a salvage
  checkpoint, then resumes the coder with a banner explaining that prior work
  is preserved. A verify-phase failure rewinds to the coder on that same
  worktree and supplies the recorded verify output, so the worker can repair
  its diff without losing its commits. A pre-setup failure, a missing branch/worktree, or a legacy
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
  **A recovery-exhausted arc with commits ahead is a carry-forward, not a
  restart.** `mars continue` refuses non-zero on a task whose failure reason
  carries the `recovery_exhausted:` prefix (its single recovery attempt is
  already spent — re-queuing would be immediately re-terminated). That
  refusal names whether the branch holds salvageable commits and picks the
  matching escape verb: `mars remerge` for real (human/coder-authored)
  commits, `mars task add --supersede <id>` for a branch that holds only an
  auto-generated salvage checkpoint (inherits the branch onto a fresh task so
  a coder can finish it), or `mars restart` only when nothing is ahead. Read
  the message before reaching for `mars restart`/`mars drop` — both discard
  whatever the message just named. A recovery-exhausted arc has already had
  a coder *and* a full recovery attempt spent on it, so it is exactly the
  kind of branch most likely to be carrying substantial, easily-discarded
  partial work.
  **A rescue-operator brief's arc listing is a snapshot, not live state —
  re-read every id before acting.** The `[rescue-operator]` prompt inlines
  its "Arc members (id | status | ...)" table as captured when the arc
  dead-ended, and it can be minutes to hours stale by dispatch. Observed on
  arc `ae17340a`: the brief listed the origin `mars-9dd152c7` as `queued`
  when it had already been `dropped`, and the failed task's worktree had
  been removed with no tombstone. Choosing between `restart`, `continue`
  and `supersede` from that table alone picks the wrong verb — and two of
  those three verbs destroy commits. Before acting, confirm with
  `mars --repo <root> show <id>` (status, branch, worktree) and
  `git rev-list --count main..<branch>` (is anything actually ahead?). In
  particular a **missing worktree silently degrades `continue` into a
  destructive `restart`**, so "continue is the safe default" stops being
  true exactly when the branch has work worth keeping.
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
  changes temporarily, **commit a wip commit on your own branch first**, then
  restore individual paths with `git checkout <ref> -- <paths>` (e.g.
  `git checkout $(git merge-base HEAD origin/main) -- <file>`) — that command
  overwrites both the worktree AND the index with no warning and no reflog
  entry, so running it before committing silently destroys any
  staged-but-uncommitted edits to those paths (this ate a staged refinement
  during the recovery of `fix-f68469da`). Committing first makes the
  restoring `git checkout HEAD -- <paths>` recover your real work instead of
  nothing. Alternatively work in a scratch clone. The orchestrator checkpoints
  to per-task refs (`refs/mars/checkpoint/<task-id>`, see
  `orchestrator/src/core/lib/git/checkpoint.ts`), never to the stash.
  **Before reaching for the checkout dance at all, check whether you need
  it.** If the path in question is not in your branch's diff
  (`git diff --name-only $(git merge-base HEAD origin/main) HEAD`), any
  failure in it is pre-existing by construction — say so and skip the
  restore entirely; the checkout is for the genuine case where your branch
  *does* touch that path.
- Never `cd`. Bash CWD persists across tool calls, and `mars` resolves
  the repo from CWD upward — once shifted into `.mars/worktrees/<id>/`,
  every later `mars` call silently binds to that worktree's `.mars/` and
  hits the wrong DB. Use `git -C <path>`, tool `--cwd` flags, absolute
  paths, or `mars --repo <root> …`. If a one-off subshell is unavoidable,
  spell it `(cd <abs-path> && …)` so the parent shell never moves.
- **A worktree can be removed out from under a running agent — trust
  `git -C <path>` only after confirming the path is still a worktree
  root.** The merge step's cleanup can fast-forward a task's branch and
  `git worktree remove` its directory while an agent is still working
  inside it (observed on `fix-041a02fd`/`mars-56b4584f`: the recovery
  agent kept running for ~15 minutes against a deleted worktree with no
  signal). Once the directory is gone, `git -C <worktree-path> …`
  silently resolves UPWARD to the shared main checkout instead of
  erroring — `git -C <worktree> status` printed `On branch main …
  working tree clean`, reading as "your work vanished" rather than
  "this path is gone", and a `git add -A && git commit` at that point
  would land directly on `main`. Before trusting any `git -C <path>`
  answer you are about to act on, confirm the path is still a live
  worktree root:
  `git -C <path> rev-parse --show-toplevel` must equal `<path>`
  (realpath-compare if either side may be symlinked, e.g. macOS
  `/tmp` → `/private/tmp`) — a mismatch or error means the worktree is
  gone. A removed worktree also leaves a tombstone one level up, e.g.
  `.mars/worktrees/<task-id>.removed.json` (written by `removeWorktree`
  in `orchestrator/src/core/lib/git/worktree.ts` before the directory is
  deleted), naming why it was removed (`merged`, `diagnose`, …) and, for
  a merge, the commit the work landed as — `ls .mars/worktrees/` for it
  before assuming an empty directory means lost work.
- The daemon's HTTP server binds an OS-assigned ephemeral port
  (`listen(0, '127.0.0.1', ...)` in
  `orchestrator/src/core/daemon/http-server.ts`) and publishes it to
  `.mars/http.port`. To reach the daemon API (e.g. `/failure-reasons`,
  `/events`), read `PORT=$(cat .mars/http.port)` first — never guess the
  port. A 200 from a guessed port is usually an unrelated server (the
  UI/Vite catch-all returns index.html for any path), so a
  guessed-port probe proves nothing.
- **Inspect daemon/UI HTTP payloads with node's `fetch`, not `curl`.** `curl`
  output is truncated by the shell hook and gets a `(N bytes total)` footer
  appended, which lands inside the JSON and yields a bogus `SyntaxError: Bad
  control character in string literal` — indistinguishable from a genuinely
  corrupt response. Use
  `node -e "fetch('http://127.0.0.1:'+require('fs').readFileSync('.mars/http.port','utf8').trim()+'/view/<route>').then(r=>r.json()).then(d=>console.log(JSON.stringify(d).slice(0,2000)))"`.
  `curl -o /dev/null -w '%{http_code}'` is still fine for a bare status probe,
  since it emits no body.
- **Never read vitest results off stdout for anything larger than a single
  test file.** RTK truncates captured output at ~1 MB, and the summary line
  with the real pass/fail counts is what gets cut. Use
  `npx vitest run --reporter=json --outputFile=<scratch>/results.json` and
  parse the file (`numTotalTests`, `numFailedTests`,
  `testResults[].assertionResults[]`) instead. Do not parse the RTK tee logs
  under `~/Library/Application Support/rtk/tee/` to reconstruct failures —
  field adjacency between `status` and `name` is not guaranteed and
  attribution silently comes out wrong. Treat a backgrounded vitest run that
  returns exit 0 with an empty or truncated log as UNKNOWN, not a pass —
  re-run in the foreground with `--outputFile`.
- A 404 on a daemon route that exists in source usually means the running
  daemon predates that route — restart with `mars daemon restart` rather
  than scoping a code task. The same applies to a `mars ui` Bun-server 404
  (default `:7777`, proxied from Vite on `:7173`) for a route in
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

## Querying the database directly

The embedded PostgreSQL database uses **mixed timestamp encodings** across
tables. Always use the right expression for the table you are querying:

| Table | Timestamp column(s) | Type | SQL display expression |
|---|---|---|---|
| `tasks` | `created_at`, `updated_at` | `timestamptz` | `to_char(created_at, 'MM-DD HH24:MI')` |
| `chat_threads` | `created_at`, `updated_at` | `bigint` epoch-ms | `to_char(to_timestamp(created_at / 1000.0), 'MM-DD HH24:MI')` |
| `action_queue_items` | `raised_at` | `bigint` epoch-ms | `to_char(to_timestamp(raised_at / 1000.0), 'MM-DD HH24:MI')` |

Note: `action_queue_items` has **no** `created_at` column — use `raised_at`.

**Column naming conventions:**

- `action_queue_items` uses **`status`** (not `state`) for its lifecycle
  column: `'open'` or `'resolved'`. This matches the `tasks.status` naming.
- `task_blockers.state` and `verify_gates.state` are different domain concepts
  (confirmation state and gate state respectively) — these are NOT renamed.
- `action_queue_history.from_state` / `to_state` record history transitions —
  these are also NOT renamed.

Common queries:

```sql
-- List open action queue items
SELECT id, kind, priority, title,
       to_char(to_timestamp(raised_at / 1000.0), 'MM-DD HH24:MI') AS raised
  FROM action_queue_items WHERE status = 'open' ORDER BY raised_at DESC;

-- List recent tasks
SELECT id, status, created_at FROM tasks ORDER BY created_at DESC LIMIT 10;

-- List chat threads
SELECT id, to_char(to_timestamp(created_at / 1000.0), 'MM-DD HH24:MI') AS created
  FROM chat_threads ORDER BY created_at DESC LIMIT 10;
```

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
