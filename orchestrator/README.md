# mars

Orchestrator that runs Claude Code in parallel git worktrees on the in-house `@mars/workflow` engine. Installable globally; works against any git repo.

## How it works

Each task in the queue runs through a 4-step `@mars/workflow` pipeline (one imperative function; each step a `ctx.step`):

1. **setup** — `git worktree add` on a fresh `task/<id>` branch off `main`
2. **code** — `claude -p "<prompt>"` runs headless inside the worktree
3. **verify** — typecheck → tests → lint (must all pass)
4. **merge** — fast-forward into `main`. On conflict, the bundled **vcs-supervisor** ("Vega") agent prompt is dispatched via `claude -p` to reconcile intent and verify, then commit. If unresolvable, `git merge --abort` and the task is marked `failed`. Merges are serialized via a file lock; coding runs unlimited-parallel.

## Install

```bash
cd orchestrator
npm install
npm link            # exposes `mars` globally
```

## Usage

```bash
# inside any git repo
mars add "implement X in src/foo.ts"
mars list queued
mars run                    # dispatch all queued tasks in parallel
mars where                  # show resolved repo + state paths

# from anywhere — explicit target
mars --repo /path/to/repo add "fix bug Y"
mars --repo /path/to/repo run

# run the CLI from source
cd orchestrator && npm run dev   # tsx src/cli.ts
```

## Repo & state resolution

Target repo is resolved in this order:
1. `--repo <path>` flag
2. `MARS_REPO` env var
3. `git rev-parse --show-toplevel` from the current directory

State lives at `<target-repo>/.mars/`:

| File                  | Purpose                       |
| --------------------- | ----------------------------- |
| `queue.db`            | LibSQL task queue             |
| `queue.db` tables     | `@mars/workflow` run/step checkpoints (workflow_runs / workflow_step_runs) |
| `worktrees/<task-id>` | Per-task git worktree         |
| `.merge.lock`         | Serializes the merge step     |

Add `/.mars/` to the target repo's `.gitignore`.

## Layout (orchestrator source)

| Path                            | Purpose                                            |
| ------------------------------- | -------------------------------------------------- |
| `src/cli.ts`                    | CLI: `add`, `list`, `run`, `where`                 |
| `src/core/context.ts`         | Resolves target repo + state paths                 |
| `src/core/queue.ts`           | LibSQL-backed task queue                           |
| `src/core/lib/git.ts`         | All shell side-effects (git, claude, verify)       |
| `src/workflows/`                | `@mars/workflow` pipelines: implement, triage, plan, slice, init |
| `src/prompts/vcs-supervisor.md` | Bundled supervisor spec, inlined into `claude -p`  |

## Prerequisites

- `claude` CLI on PATH (Claude Code).
- Node `>=22.13.0`.

## Env

- `INTEGRATION_BRANCH` — target branch for merges (default `main`).
- `MARS_REPO` — target repo path (overrides cwd-based detection).
- `MARS_REFLECT_DISABLED=1` — skip per-task token/cost capture and
  short-circuit `mars reflect`. Scorers stay attached either way.

## Daemon

```
mars daemon <start|stop|restart|kill|status|reload|set-flag> [flags]
```

CLI write operations (e.g. `mars add`) auto-spawn the daemon when needed.
Use these subcommands to manage its lifecycle explicitly.

### Subcommands

| Subcommand | Description |
| ---------- | ----------- |
| `start` | Fork the daemon to the background. No-op if already running. Equivalent to the legacy `--detach` flag. |
| `stop [--force]` | Graceful shutdown: stop accepting new work, wait for in-flight tasks to finish, then exit. `--force` exits immediately and abandons in-flight tasks. No timeout — use `kill` if `stop` is hanging. |
| `restart` | Force-stop any running daemon, then start a fresh one in the background. Exits once the new daemon is up. |
| `kill` | Hard stop: mark every in-flight task failed and SIGKILL the daemon's process group (kills all child `claude -p` workers). Use when `stop` is hanging on stuck work. |
| `status` | Print pid, startedAt, inFlight, and queue counts. |
| `reload` | Re-read `.mars/daemon.json` and `MARS_MAX_*` env vars without restarting. |
| `set-flag <flag> <on\|off>` | Toggle an in-memory kill-switch. Currently only `recovery` is supported: `on` suppresses fix-task/Investigator spawns; `off` re-enables them. Not persisted across restarts. |

```bash
mars daemon start                      # fork to background; no-op if already running
mars daemon status                     # print pid, uptime, and in-flight counts
mars daemon stop                       # graceful: wait for in-flight tasks to finish
mars daemon restart                    # force-stop + fresh start in one step
mars daemon kill                       # hard stop: abort all in-flight tasks immediately
mars daemon reload                     # pick up new MARS_MAX_* values without restart
```

### Output

`mars daemon start` and `mars daemon restart` both print on stdout whether
the daemon was already running or freshly spawned:

```
[mars] daemon detached (pid 12345, log: /path/to/repo/.mars/watch.log)
```

`mars daemon status` output:

```
pid:        12345
startedAt:  2026-05-28T10:00:00.000Z
counts:     draft=0 queued=2 running=1 verifying=0 merging=0 vega-reconciling=0
inFlight:   1
  implement task/abc123
```

### Self-heal on startup

When the daemon starts (via `mars daemon start`, `restart`, or an
auto-spawn triggered by a write op), it silently repairs stale state left
over from a crash or unclean exit before binding its socket:

| Stale state | What happens |
| ----------- | ------------ |
| **Orphan socket** (`watch.sock` exists but connection refused) | Socket file deleted; fresh socket bound in its place. No output. |
| **Stale watch pid** (`watch.pid` points to a dead process, socket already gone) | Pid file deleted. No output. |
| **Stale-but-alive pid** (`watch.pid` points to a live process that is not responding on the socket) | Socket unlinked and the new daemon takes over. One line on stderr: |

```
warning: stale-but-running daemon (pid 12345) not responding on /path/to/repo/.mars/watch.sock; taking over socket
```

Client-side liveness checks (run before any `mars daemon` subcommand)
apply the same cleanup — orphan sockets and dead-pid files are removed
silently before the subcommand proceeds.

Note: the stale-worktree sweep runs as a background timer inside the
daemon (every 5 minutes by default; override with `MARS_STALE_SWEEP_MS`).
It is not a separate process and has no separate pid file — it starts and
stops with the daemon.

### Worker pool

The daemon dispatches work through per-kind semaphores so a reconcile
storm or a burst of `task add` calls can't spawn one worktree + `claude
-p` per row. Each cap is a positive integer; invalid values fall back to
the default. Tune at runtime with `mars daemon reload` (re-reads the
env vars below without restarting); a kill + restart also picks them up.

- `MARS_MAX_TRIAGE` (default `8`) — concurrent triage workflows.
- `MARS_MAX_IMPLEMENT` (default `12`) — concurrent implement workflows
  (worktree + `claude -p`). The hardware-bound knob; raise cautiously.
- `MARS_MAX_REFINE` (default `6`) — concurrent `mars idea refine`
  (planner) runs.
- `MARS_MAX_STRUCTURED_WRITE` (default `1`) — shared cap for
  `glossary-write` and `adr-add`. Both serialize on `.mars/.merge.lock`
  downstream, so a second slot would just sit waiting.

Excess work queues into in-memory pending sets and drains as slots free
— it is not dropped. Restarting the daemon re-reads `draft` / `queued`
rows from `.mars/queue.db` and re-pends them, so restarts are safe.

Dispatched `claude -p` workers run clean-room: their env is scrubbed of
every `CLAUDE*` session-context var inherited from the daemon's parent
shell, and they load only `project,local` setting sources (the worktree's
own `.claude/settings.json`) — never the host user's `~/.claude/`. MCP is
fully disabled and session files are not persisted to disk.

## Observing Claude runs in Studio

Both Claude dispatches (the `code` step and the `vcs-supervisor` invocation in
`merge`) capture the full Claude Code conversation in two places:

- **Live stream** — each parsed event from `claude -p --output-format stream-json --verbose`
  is forwarded to the workflow's `writer.write(...)`. In Studio, while the run
  is in flight, watch the step's run-stream view to see `claude-event` /
  `vcs-supervisor-event` items arrive in real time.
- **Persisted span metadata** — at step end small span-shaped fields are
  attached to the step span via
  `tracingContext.currentSpan.update({ metadata: { ... } })`. After a run
  completes, open Studio → Run history → click the step → **Metadata** tab.
  The `code` step exposes `claudeSessionId` and `usage`; the full
  conversation is persisted to `task_transcripts.conversation_json` in
  `.mars/queue.db` (LibSQL) instead, which is what `mars arc reflect` and
  external skills read. The `merge` step still exposes
  `supervisorConversation` and `supervisorConversationBytes` (only
  populated when a conflict triggered the supervisor).

Trim policy: assistant text and reasoning are kept in full. Tool calls with
input larger than 2 KB and tool results larger than 4 KB are replaced with
`{ truncated: true, originalBytes, head }` (first 2 KB of the JSON payload)
to keep persisted conversations small.

## Reflection

Mars captures cheap deterministic signals during every workflow run, then
lets you synthesize them into draft task suggestions on demand.

**Per-task signals (automatic).** After the `code` and `vcs-supervisor`
steps, token and cost totals are summed from the captured Claude
conversation and persisted to the `task_signals` table in `.mars/queue.db`:

```
sqlite3 .mars/queue.db "select * from task_signals where task_id = '<id>'"
```

Columns: `step_id`, `input_tokens`, `output_tokens`, `cache_create_tokens`,
`cache_read_tokens`, `message_count`. Cache-creation and cache-read tokens
are tracked separately from `input_tokens` because they carry different
weights in the token-volume signal — conflating them would skew any
weighted-token calculation in the reflection pass.


**Cross-task synthesis (manual).** `mars reflect` reads the signal corpus,
calls Claude Haiku once with the joined task records, and inserts the
returned suggestions into the `ideas` table as draft rows with
`source='reflection'`. Reflection ideas never auto-dispatch — `mars run`
only picks up rows from `tasks` with `status='queued'`.

```
mars reflect                                       # last 10 completed tasks
mars reflect --since 2026-05-01                    # ISO timestamp window
mars reflect --limit 25
mars idea list --source reflection --status draft  # review proposals
mars idea promote <idea-id>                        # shape & enqueue as a task
```

**Disable.** Set `MARS_REFLECT_DISABLED=1` to skip signal capture and
short-circuit `mars reflect`. The scorers stay attached because they're
deterministic and cheap; the disable flag only kills (a) `task_signals`
writes and (b) the synthesis CLI.

**Cost.** The reflector uses Haiku at roughly $0.005–$0.02 per call. It is
deliberately on-demand, not auto-run per task.

**Timeout.** `mars reflect` is unbounded — the synthesis runs to completion or
until the user hits Ctrl-C. There is no wall-clock timeout and no
`MARS_REFLECT_TIMEOUT` knob.

**Deep, arc-level post-mortem.** `mars arc reflect <originId>` runs a
transcript-aware analysis across every task in a Mars arc (the origin
task plus any recovery / fix tasks that share its `originId`). The
implement workflow persists the full trimmed `ClaudeEvent[]`
conversation (and the concatenated typecheck/test/lint output) into a
`task_transcripts` row in `.mars/queue.db` after each run. `arc reflect`
walks every transcript event-by-event and surfaces:

- **Dissonant tool calls** — successful tool calls that did not achieve
  the assistant's stated intent (e.g. an `Edit` whose new content
  contradicts the surrounding plan, a `Bash` `git commit` that printed
  "nothing to commit, working tree clean", a verify command that
  reported pass with `0 passed, 0 failed`).
- **Verify-claim mismatches** — assistant said "all tests pass" but the
  recorded verify output shows a typecheck/test failure.
- **Thrashing** — same file Read 5+ times across the arc, fixes that
  re-do the parent's failing strategy, work in task N that task N+1
  silently undoes.

```
mars arc reflect             # interactive picker over recent arcs
mars arc reflect <originId>  # explicit; a leaf task id also resolves
                             # to its arc via COALESCE(origin_id, id)
```

A one-task arc collapses to that single transcript, so passing a leaf
task id with no recovery siblings is the supported way to do a
single-session post-mortem.

Suggestions are filtered through `save|absorb|drop` verdicts and only
"save" verdicts land as draft ideas with `source='reflection'` (review
with `mars idea list --source reflection`). The full structured report
is persisted to `.mars/deep-reflections/arc-<id>-<iso>.json`
(gitignored).

Model used by `mars arc reflect` defaults to `opus`; override with
`MARS_DEEP_REFLECT_MODEL`. The timeout is 10 minutes — these analyses
can be large. Setting `MARS_REFLECT_DISABLED=1` disables transcript
capture and short-circuits `mars arc reflect` along with `mars reflect`.

## Failure handling

- Verify gate fails → task marked `failed`, worktree retained at `.mars/worktrees/<taskId>`.
- Merge conflicts vcs-supervisor cannot reconcile → `git merge --abort`, task `failed`, worktree retained.
- Clean merge (or supervised resolution) → worktree removed, task `done`.

### Recovery, recipes, and escalation

When a normal task fails, the orchestrator computes a **failure
signature** — a human-readable technical key of shape
`<failingStep>/<error-class>` (e.g. `verify:has-diff/no-commits-ahead`,
`merge:preflight/uncommitted-changes`). The mapping from raw error to
class lives in `errorClassRules` in
`src/core/lib/failure-signature.ts`.

The handler then takes one of three paths (see ADR
`docs/adr/0002-recipe-per-failure-signature.md` for the contract):

1. **Recipe registered** — a recovery task is enqueued from the recipe
   in `src/core/lib/fix-recipes.ts`. The original task becomes
   `blocked`. If the recovery succeeds, the original is re-queued via
   the normal blocker-resolution path.
2. **Recovery itself fails** — the orchestrator does NOT enqueue
   another recovery (recovery has retry budget 0). The recovery is
   marked `failed`, the original stays `blocked`, and an action queue item of
   `kind='recovery-failed'` is raised. The human resolves via
   `mars retry <recovery-id>`, `mars unblock <origin-id>`, or fixing
   the upstream cause.
3. **No recipe for the signature** — the handler does NOT fall back to
   a generic prompt. The original is parked in `blocked`, an
   **Investigator** task is queued (`author='agent:investigator'`)
   whose sole job is to propose a draft recipe in
   `fix-recipes.ts` (and a classifier rule in `failure-signature.ts`
   if the signature ends in `/unclassified`), and an action queue item of
   `kind='no-recipe'` is raised.

To browse outstanding escalations:

```bash
mars action-queue list --kind recovery-failed
mars action-queue list --kind no-recipe
```

## Action queue

Cross-cutting findings that don't belong to a single task — daemon
desyncs, self-heal investigations, anything raised by a dispatched
agent — land in the action queue at `.mars/state.db`.

CLI surface:

| Command                                  | Purpose                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `mars action-queue` / `mars action-queue list [state]` | List items by state (default `open`).                    |
| `mars action-queue show <id>`                   | Full detail for one item.                                |
| `mars action-queue raise --from <-\|path>`      | File a new item from a JSON document.                    |
| `mars action-queue watch`                       | Live ink TUI.                                            |

`mars action-queue raise --from -` is the **correct** entry point for
dispatched agents (self-heal investigations, anything running inside a
`task/<id>` worktree) to file action queue items. It replaces
the deprecated pattern of writing one-shot `.ts` scripts under
`orchestrator/scripts/raise-*.ts`, which pollute the codebase, tie
agents to the orchestrator's source tree, and have caused merge-target
dirty failures when an uncommitted script was left in the worktree.

The verb reads a JSON document from stdin (or from `--from <path>`),
validates it against the same shape `raiseActionQueueItem` expects, dedupes
server-side by `(kind, signature)` — re-piping the same payload bumps
`seen_count` instead of creating a duplicate row — and prints the
action queue id on stdout (one line, no decoration). Exit codes: `0` ok, `1`
library error, `2` parse/validation error.

```bash
echo '{
  "kind": "manual.smoketest",
  "category": "orchestrator",
  "priority": "low",
  "title": "smoke test of mars action-queue raise",
  "body": "...",
  "payload": {},
  "context": {},
  "raisedBy": "smoketest:agent",
  "signature": "manual.smoketest:1"
}' | mars action-queue raise --from -
```

Required fields: `kind`, `category`, `priority` (`urgent|high|normal|low`),
`title`, `body`, `payload`, `context`, `raisedBy`, `signature`. Optional:
`occurrence`. Pass a real `raisedBy` (e.g. `self-heal:<task-id>`) so the source of the
finding is traceable; the empty string defaults to `agent:cli`, but a
missing key is a schema error.

## `mars init` and monorepo recursion

`mars init` walks the target repo from its root and merges every manifest it
finds into a single supervisor set under `.mars/supervisors/`.

- Recurses by default; no flag needed.
- Depth cap: 6 directories below the repo root. Anything deeper is skipped
  with a stderr warning.
- Hardcoded skip list: `.git`, `node_modules`, `.mars`, `.worktrees`, `dist`,
  `build`, `.next`, `target`, `out`.
- Honors `.gitignore` at every level (root and nested).
- Skips git submodule paths (parsed from `.gitmodules`) and other git worktrees
  (`git worktree list --porcelain`).
- **Layout contract**: tech-bearing folders must be siblings, not nested.
  If a manifest is found inside a subtree where another manifest already
  claimed the tech (e.g. `frontend/package.json` and
  `frontend/admin/package.json` both exist), `mars init` exits non-zero
  and prints both offending paths. Restructure so each tech is a sibling.
- Empty repo (no manifests anywhere): `mars init` still emits a baseline
  supervisor and a `manifest.json` with an empty stack.

Flags:

- `--force` — overwrite an existing `.mars/supervisors/manifest.json`.
- `--dry-run` — print the detected stack and proposed supervisors without
  writing.
- `--verbose` — print each discovered manifest and the techs derived from
  it on stderr.
