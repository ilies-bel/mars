#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { MARS_VERSION } from './version'

// Silently swallow broken-pipe ('EPIPE') errors on stdout/stderr.
//
// When mars output is piped to a reader that closes early (e.g.
// `mars adr list | head -1` or `... | grep -qi merge`), Node's
// default unhandled-error behaviour prints a `write EPIPE` stack
// trace to stderr and exits non-zero, masking the real verdict.
//
// We absorb EPIPE on both standard streams without forcing any
// particular exit code: the rest of the program runs to its natural
// completion and its real success/failure status reaches the caller.
// Subsequent writes after the pipe closes will continue to emit
// 'error' events, which this same handler will silently consume.
const swallowEpipe = (err: NodeJS.ErrnoException): void => {
  if (err.code === 'EPIPE') return
  // Non-EPIPE write errors on the standard streams are rare. Re-emitting
  // them would itself crash the process via 'Unhandled error event',
  // which is exactly what this handler exists to avoid. Drop them.
}
process.stdout.on('error', swallowEpipe)
process.stderr.on('error', swallowEpipe)

interface ParsedArgs {
  repo?: string
  flags: Record<string, string>
  multiFlags: Record<string, string[]>
  positional: string[]
}

const FLAGS_WITH_VALUES = new Set([
  '--repo',
  '--functional',
  '--func',
  '--technical',
  '--tech',
  '--functional-file',
  '--technical-file',
  '--since',
  '--limit',
  '--out',
  '--author',
  '--note',
  '--root-cause',
  '--avoid',
  '--blocked-by',
  '--source',
  '--status',
  '--from',
  '--kind',
  '--port',
  '--host',
  '--priority',
  '--tag',
  '--files',
  '--verify',
  '--done',
  '--type',
  '--wrapper',
  '--session',
  '--model',
  '--effort',
  '--permission-mode',
  '--max-messages',
  '--name',
  '--path',
  '--config',
])

// Short aliases for value-bearing flags, normalised to their long form in
// parseArgs before the FLAGS_WITH_VALUES lookup. `-f` is `mars init`'s
// declarative-config flag (`mars init -f mars.init.toml`).
const SHORT_FLAG_ALIASES: Record<string, string> = {
  '-f': '--config',
}

const REPEATABLE_FLAGS = new Set(['--blocked-by', '--files', '--done', '--tag'])

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const multiFlags: Record<string, string[]> = {}
  let repo: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue

    const eq = a.indexOf('=')
    const rawKey = eq === -1 ? a : a.slice(0, eq)
    const key = SHORT_FLAG_ALIASES[rawKey] ?? rawKey
    const inlineValue = eq === -1 ? undefined : a.slice(eq + 1)

    if (key === '--repo') {
      repo = inlineValue ?? argv[++i]
      continue
    }
    if (FLAGS_WITH_VALUES.has(key)) {
      const value = inlineValue ?? argv[++i]
      if (value === undefined) throw new Error(`flag ${key} requires a value`)
      if (REPEATABLE_FLAGS.has(key)) {
        const list = multiFlags[key] ?? []
        list.push(value)
        multiFlags[key] = list
      } else {
        flags[key] = value
      }
      continue
    }
    positional.push(a)
  }
  return { repo, flags, multiFlags, positional }
}

const readMaybeFile = (raw: string): string => {
  if (raw.startsWith('@')) {
    const path = raw.slice(1)
    return readFileSync(path, 'utf8')
  }
  return raw
}

const resolvePlanText = (
  flags: Record<string, string>,
  inlineKeys: readonly string[],
  fileKey: string,
): string | undefined => {
  for (const key of inlineKeys) {
    const v = flags[key]
    if (v !== undefined) return readMaybeFile(v)
  }
  const filePath = flags[fileKey]
  if (filePath !== undefined) return readFileSync(filePath, 'utf8')
  return undefined
}

const usage = `mars — orchestrator for parallel Claude Code task workflows

Usage:
  mars [--repo <path>] <command> [args]

Commands:
  init [--force] [--dry-run] [--verbose] [-f|--config <path>]
                                detect tech stack and generate specialized supervisors
                                in .mars/supervisors/ (skeleton + workflow contract).
                                Recurses into subdirectories (depth cap 6) to merge
                                manifests from monorepo layouts; honors .gitignore
                                and skips .git, node_modules, .mars, .worktrees,
                                dist, build, .next, target, out, plus git submodules.
                                Nested tech-bearing manifests (e.g. frontend/ AND
                                frontend/admin/ both with package.json) are rejected
                                — pass -f/--config <path> to declare the stack in a
                                TOML file and skip auto-detection entirely.
                                --verbose lists each discovered manifest on stderr.
                                On success, prints 'mars ui --repo <root>' to launch
                                the read-only Kanban + trace dashboard.
  task add "<prompt>" [--author kind:name] [--blocked-by <id>] [--tag <tag>] [plan flags]
                                enqueue a runnable task directly (status='queued',
                                skips triage; can be picked up by agent runners).
                                --blocked-by <id> is repeatable; every id must
                                already exist. The task will not dispatch until
                                every listed blocker reaches 'done'. --tag is
                                repeatable; collected values form the tags list.
                                The first tag routes to a Worker ('coder' is
                                the default). Unknown tags fall back to Coder.
  proposal add "<goal>" [--author kind:name]
                                create a proposal/plan in .mars/state.db. Author
                                is detected from env/git when omitted: human if
                                running interactively, agent if MARS_AGENT_NAME
                                or CLAUDE_CODE/CLAUDECODE is set.
  proposal list [--source reflection|human|planner] [--status <status>]
                                list proposals; filter by source and/or status
  proposal show <id>            show a proposal from .mars/state.db
  proposal delete <id>          remove a proposal row from .mars/state.db
                                (cascades proposal_user_stories rows). No
                                worktree, no merge — pure local DB write.
  proposal set <id> <title|problem|solution|out-of-scope|notes|status> "<text>"
                                update a single field on a PRD-shaped proposal
  proposal add-user-story <id> "<text>"
                                append a user story to the proposal's PRD
  proposal remove-user-story <id> <index>
                                remove the 0-based user story; positions repack
  proposal promote <id>         mark a shaped draft proposal as PRD-ready. Flips
                                the proposal's status from 'draft' to 'prd-ready'.
                                The slicer creates one task per vertical slice
                                separately; this verb does NOT enqueue a task.
  proposal slice <id>           decompose a 'prd-ready' proposal into N
                                tracer-bullet vertical-slice tasks (one per
                                user-observable behaviour) and queue them with
                                blockers wired between dependent slices. Flips
                                the proposal's status to 'sliced'.
  proposal block <proposal-id> <blocker-id> [<blocker-id> ...]
                                ADR-0008 planning-graph edge: <proposal-id> waits
                                on each <blocker-id>. Both endpoints must
                                exist; self-blocking is rejected. Stored in
                                proposal_dependencies (.mars/state.db).
  proposal unblock <proposal-id> <blocker-id> [<blocker-id> ...]
                                remove the listed planning-graph edges only;
                                the proposal's status is left untouched.
  proposal blockers <proposal-id>
                                list the proposals <proposal-id> is blocked by.
  proposal block-task <task-id> <proposal-id> [<proposal-id> ...]
                                ADR-0015 cross-graph edge: <task-id> cannot
                                dispatch until each <proposal-id> is promoted.
                                Stored in task_proposal_blockers
                                (.mars/queue.db). Transferred onto a real
                                task_blockers edge atomically when the proposal
                                is sliced.
  proposal unblock-task <task-id> <proposal-id> [<proposal-id> ...]
                                remove the listed task->proposal edges only.
  proposal task-blockers <task-id>
                                list the proposals <task-id> is blocked by.
  add "<prompt>" [plan flags]   (deprecated) draft a task; lands in 'draft' state
                                so triage can promote to 'queued'. Prefer
                                'mars task add' or 'mars proposal add'.
  set-functional <id> <text|@file>
                                set the functional plan on a draft/queued task
  set-technical <id> <text|@file>
                                set the technical plan on a draft/queued task
  show <id>                     print full detail for an id; tries tasks
                                (.mars/queue.db), then proposals (.mars/state.db)
  list [status]                 list tasks (draft|queued|running|verifying|merging|vega-reconciling|done|failed|dropped)
  continue <id> [<id> ...]      resume failed task(s) on their existing
                                worktree+branch, jumping straight into the
                                failed phase (verify or merge). Refuses if a
                                task is not 'failed', has no recorded
                                failed_phase, failed in the 'code' phase, or
                                lost its worktree on disk — use 'mars restart'
                                instead. Stops on the first error.
  restart <id> [<id> ...]       wipe worktree+branch and re-queue failed/done
                                task(s) from setup (full pipeline re-run).
                                Stops on the first error.
  purge <id> [<id> ...] [--force] delete failed/done task(s) entirely
                                (worktree+branch+row). Refuses if the branch
                                has unique commits ahead of the integration
                                branch unless --force is passed. Stops on
                                the first error.
  drop <id> [--force]           delete any task regardless of status: clears
                                task_blockers edges (both directions), nulls
                                sibling fix_for_task_id pointers, removes the
                                worktree+branch+row. Use for queued recoveries
                                whose parent is being purged, or any row that
                                'mars purge' refuses. --force overrides the
                                in-flight guard (does not kill the running
                                claude subprocess).
  unblock <id>                  phantom-recovery: flip a 'blocked' or 'queued'
                                task to 'failed' AND clear every
                                task_blockers row for <id>. Use when a task
                                is stuck on a blocker that no longer exists,
                                or when a still-queued auto-recovery is now
                                obsolete (follow up with 'mars purge <id>'
                                to delete the row).
  unblock <id> <blocker-id> [<blocker-id> ...]
                                edge-removal: delete the listed (task,blocker)
                                edges only; status is left untouched. Errors
                                per-id when an edge is absent.
  block <task-id> <blocker-id> [<blocker-id> ...]
                                add blocker edges so <task-id> waits for each
                                <blocker-id> to reach 'done' before dispatch.
                                All ids must already exist; self-blocking is
                                rejected.
  sweep                         enumerate local task/<id> branches whose id
                                is absent from the queue and interactively
                                resolve each one. For each orphan branch,
                                shows the branch name and its unique commits
                                ahead of the integration branch (default
                                'main', override via INTEGRATION_BRANCH),
                                then prompts: [k]eep (no-op), [d]elete
                                (force-remove the branch), or [c]herry-pick-
                                then-delete (apply each unique commit onto
                                the integration branch in order, then remove
                                the source branch). A cherry-pick conflict
                                halts on that branch with a clear message;
                                remaining orphans are still processed.
                                Requires an interactive terminal (TTY).
  worktree clean [--dry-run] [--force-orphans]
                                classify every directory under .mars/worktrees/
                                (and legacy .worktrees/) against queue.db and
                                remove the safe ones: done+merged branches,
                                failed/dropped+zero-commit branches, and orphan
                                rows whose branch never advanced. Skips
                                in-flight tasks and desyncs (done+not-merged).
                                --force-orphans extends removal to orphan
                                worktrees that did contribute commits.
  worktree prune [--dry-run]    remove all done and dropped worktrees (regardless
                                of merge status) and all orphan directories (no
                                matching task row). Keeps failed worktrees and
                                any in-flight worktree (queued/running/verifying/
                                merging). The bigger hammer versus clean.
  daemon <start|stop|restart|kill|status|reload|set-flag> [flags]
                                run the orchestration daemon. 'start' forks to
                                background (also --detach). 'stop' stops
                                accepting new tasks then waits for in-flight to
                                finish (--force exits immediately and abandons
                                in-flight). 'restart' stops then starts fresh.
                                'kill' SIGKILLs the daemon's process group,
                                terminating every child claude -p worker, and
                                marks in-flight tasks failed. 'status' (also
                                --status) prints inFlight + queue counts.
                                'reload' re-reads .mars/daemon.json (falling
                                back to MARS_MAX_* env vars and built-in
                                defaults) without restarting. 'set-flag
                                recovery <on|off>' toggles the
                                MARS_RECOVERY_DISABLED kill-switch in-memory
                                (not persisted across restarts).
  triage [<task-id>]            run triage once on one draft, or all drafts in
                                parallel (Haiku assesses actionability)
  glossary set "<term>" "<definition>" [--avoid alias1,alias2]
                                add or update a term in <repo>/CONTEXT.md via a
                                daemon-routed structured write (fresh worktree
                                off integration; merged back via the merge lock).
  glossary remove "<term>"      remove a term via the same structured-write path
  glossary list                 list terms in CONTEXT.md (local read; no daemon)
  glossary show "<term>"        print one term's definition + aliases
  adr add "<title>" "<body>"    append an ADR under docs/adr/ via a daemon-routed
                                structured write (sequential numbering, slug from
                                title). Body may be @path to read from a file.
  adr list                      list ADRs in docs/adr/ (local read)
  adr show <NNNN|filename>      print one ADR (number prefix is zero-padded)
  reflect [--since <iso>] [--limit <n>]
                                synthesize draft proposals (source='reflection') from
                                recent completed tasks. Reads token + scorer
                                signals from .mars/queue.db. Default: last 10
                                completed tasks. Proposals are
                                inserted as drafts — never auto-run. Disable
                                signal capture entirely with the env var
                                MARS_REFLECT_DISABLED=1.
  arc list [--limit N] [--json] [--with-transcript-only]
                                list task arcs grouped by COALESCE(origin_id, id).
                                Each arc covers an origin task plus any recovery
                                tasks. --limit N (default 10, clamped to [1, 100]).
                                --json emits the raw ArcCandidate[] as a JSON array.
                                --with-transcript-only restricts to arcs that have
                                at least one stored transcript.
  arc reflect [<originId>]      deep, arc-level post-mortem. With no argument,
                                prints the arc list and prompts for an originId.
                                Accepts an originId or any task id in the arc
                                (resolved automatically; a one-task arc
                                collapses to that single transcript). Writes
                                report to
                                .mars/deep-reflections/arc-<id>-<iso>.json.
  action-queue                         alias for 'action-queue list open'
  action-queue list [state] [--kind <kind>] [--lean]
                                list action queue items. state one of:
                                open|acknowledged|resolved|dismissed|all
                                (default: open). --kind filters by item
                                kind, e.g. recovery-failed, no-recipe.
                                Draft proposals (status='draft') surface
                                alongside action queue rows for state=open|all
                                with kind='draft(<source>)'; dismissed
                                drafts surface for state=dismissed. Use
                                'mars proposal ...' for the draft lifecycle.
                                --kind suppresses draft rows. --lean
                                prints a compact summary (counts per
                                priority, then up to 3 oldest blockers
                                and 3 oldest drafts with section
                                totals) instead of one row per item;
                                intended for SessionStart hooks and
                                other terse summaries.
  action-queue show <id>               full detail for an action queue item (accepts a
                                full id or a unique 8-char prefix)
  action-queue ack <id>                mark an action queue item acknowledged
  action-queue resolve <id> [--note <text>] [--root-cause <text>]
                                mark an action queue item resolved
  action-queue dismiss <id> [--note <text>]
                                mark an action queue item dismissed
  action-queue raise --from <-|path>   file an action queue item from a JSON document
                                (stdin when path is '-'). Replaces the
                                deprecated pattern of writing one-shot
                                .ts scripts under orchestrator/scripts/.
  action-queue watch                   live terminal UI for the todo feed
                                (drafts + stale worktrees)
  action-queue reconcile               one-time pass: close every open action queue item
                                whose referenced task is already done or
                                dropped. Items about failed or live tasks
                                are left open. Idempotent — re-running is
                                a no-op. Prints how many items were closed.
  diagnose set <task-id> --from <-|path>
                                record a diagnose Chore's verdict against a
                                stuck task. Input is a JSON object with kind
                                = "root-cause-found" (evidence,
                                involvedFiles, fixDirection) or
                                "inconclusive" (whatChecked, whyUnscoped).
                                Overwrites any prior verdict for the same id.
  diagnose show <task-id> [--json]
                                read a recorded verdict. Prints structured
                                fields by default; --json emits the raw
                                StoredDiagnosis object. An unrecorded task
                                surfaces as kind="no-verdict".
  ui [--repo <path>] [--port <n>] [--host <h>]
                                launch the read-only Kanban viewer
                                (defaults: port 7777, host 127.0.0.1)
  uninstall [--yes|-y] [--wrapper <path>]
                                remove the installed mars wrapper and source
                                clone. Resolves the wrapper from the running
                                cli entry point; --wrapper overrides that
                                detection. Wrapper is deleted first; if
                                either path is already absent the command
                                still proceeds. Per-repo .mars/ and
                                .worktrees/ directories are never touched.
                                --yes / -y skips the confirmation prompt
                                (required from a non-TTY stdin).
  cut verify <drain|reset|recreate>
                                gate checks for the hard-cut to 4-letter id
                                tags (PRD 52ec700f). drain: exits 0 only when
                                no tasks are queued/blocked/running. reset:
                                exits 0 only when every id-bearing table has
                                zero rows. recreate: exits 0 only when no
                                forbidden ids appear, and prints a checklist
                                of the seven carry-forward proposal titles.
  observability prune [<days>]   delete telemetry rows from the trace_events
                                store older than <days> days. Default: 3.
                                Pass 0 to wipe all rows. Prints the number
                                of rows removed. Safe to run while the
                                daemon is running.
  worker list                   print all known Workers (hard-coded defaults
                                merged with any persisted registry)
  worker add <name> --model <model> [flags]
                                write a Worker declaration to the registry
                                file (.mars/worker-registry.json). Seeds
                                the file from hard-coded defaults on first
                                write. Flags: --effort (default: high),
                                --permission-mode (default: default),
                                --max-messages (default: 0 = unbounded),
                                --tag (repeatable, routing tags).
  statusline                    print a one-line Claude Code status segment.
                                Reads stdin for session JSON (tolerated but
                                optional). Exits 0 always.
  where                         print resolved repo + state directory
  help                          show this message
  --version, -v                 print mars version and exit

Plan flags for 'task add' / 'add':
  --functional <text|@file>     functional plan text (or @path to read a file)
  --func <text|@file>           alias for --functional
  --technical <text|@file>      technical plan text (or @path to read a file)
  --tech <text|@file>           alias for --technical
  --functional-file <path>      read functional plan from a file
  --technical-file <path>       read technical plan from a file

Author flag for 'task add' / 'proposal add' / 'add':
  --author <kind:name>          override detected author. kind is human|agent
                                (e.g. --author agent:vega, --author human:alice).
                                When omitted, detected from env: agent if any of
                                MARS_AGENT_NAME, CLAUDE_CODE, CLAUDECODE,
                                CLAUDE_AGENT, ANTHROPIC_AGENT is set; otherwise
                                human (name from git user.email).

Repo resolution (in priority order):
  1. --repo <path>
  2. \$MARS_REPO env var
  3. \`git rev-parse --show-toplevel\` from cwd

Other env:
  INTEGRATION_BRANCH       target branch for merges (default: main)
  MARS_REFLECT_DISABLED=1  skip per-task token/cost capture and short-circuit
                           'mars reflect'. Scorers stay attached either way.
`

const HELP_FLAGS = new Set(['--help', '-h', 'help'])

const COMMAND_HELP: Record<string, string> = {
  init: `mars init [--force] [--dry-run] [--verbose] [-f|--config <path>]

Detect tech stack and generate specialized supervisors in
.mars/supervisors/ (skeleton + workflow contract). Also activates the Mars
Claude Code plugin so mars:* skills, agents, and hooks are available in
Claude Code immediately — idempotent, so re-running is safe. If plugin
activation fails (exotic install layout, unwritable settings file), mars
prints a warning and continues; run \`mars plugin activate <dir>\` manually
to fix it.

Recurses into subdirectories (depth cap 6) to merge manifests from
monorepo layouts; honors .gitignore and skips .git, node_modules, .mars,
.worktrees, dist, build, .next, target, out, plus git submodules.

Pass -f/--config <path> to skip auto-detection entirely and read the stack
from a declarative TOML file instead — the escape hatch for layouts the
walker rejects (e.g. a root packaging package.json nesting over per-package
manifests). The file lists one [[stack]] table per tech-bearing folder:

  [[stack]]
  path = "gateway"      # repo-relative dir; "." means the repo root
  tech = "node-backend"

  [[stack]]
  path = "dashboard"
  tech = "react"

Known tech values: react, nextjs, vue, nuxt, svelte, angular, node-backend,
python-backend, go, rust, jvm-backend, flutter, ios, android, infra, web3, ml.

After a successful init, mars prints the exact command to launch the
read-only Kanban + trace dashboard:

  mars ui --repo <abs-repo-root>   (serves at http://127.0.0.1:7777)

If the UI package is not yet built, init prints instructions to build it.

Flags:
  --force            overwrite existing supervisors
  --dry-run          show detected stack and proposed supervisors only
  --verbose          list discovered manifests on stderr
  -f, --config <p>   read stack from a declarative TOML config (skips detection)`,
  add: `mars add "<prompt>" [plan flags] [--author kind:name]

(deprecated) Draft a task. Lands in 'draft' state; triage promotes it to
'queued' once actionable. Prefer 'mars task add' (skip refinement) or
'mars proposal add' (plan only).

Plan flags:
  --functional <text|@file>   functional plan text (or @path to read a file)
  --func <text|@file>         alias for --functional
  --technical <text|@file>    technical plan text (or @path to read a file)
  --tech <text|@file>         alias for --technical
  --functional-file <path>    read functional plan from a file
  --technical-file <path>     read technical plan from a file
  --author <kind:name>        override detected author (human|agent)`,
  task: `mars task <subcommand> ...

Subcommands:
  add "<prompt>" [plan flags] [--author kind:name] [--blocked-by <id> ...]
      Enqueue a runnable task directly (status='queued'; skips triage).
      Agent runners can pick it up immediately via 'mars run' / the
      orchestrator. Plan flags and --author behave like 'mars add'.
      --blocked-by <id> may be repeated; each <id> must already exist.
      The new task will not dispatch until every blocker reaches 'done'.`,
  proposal: `mars proposal <subcommand> ...

Subcommands:
  add "<goal>" [--author kind:name]
      Create a plan/proposal in .mars/state.db. Author is detected from env
      and git when omitted (agent if MARS_AGENT_NAME/CLAUDE_CODE is set,
      otherwise human with git user.email). Use --author to override,
      e.g. --author agent:vega.
  list [--source reflection|human|planner] [--status <status>]
      List proposals. Filter by source and/or status.
  show <id>
      Show a proposal from .mars/state.db. <id> must be the full proposal slug.
  set <id> <title|problem|solution|out-of-scope|notes|status> "<text>"
      Update a single field on an existing proposal. Replaces the field; does
      not append.
  add-user-story <id> "<text>"
      Append a user story to the proposal's PRD (positions auto-assigned).
  remove-user-story <id> <index>
      Remove the 0-based user story; remaining positions repack.
  promote <id>
      Mark a fully-shaped draft proposal as PRD-ready. Does not enqueue a task —
      slicing into runnable tasks happens separately.
  slice <id>
      Decompose a 'prd-ready' proposal into N tracer-bullet vertical-slice tasks
      and queue them with blockers wired between dependent slices. Flips the
      proposal's status to 'sliced'.
  reject <id>
      Mark a draft proposal as 'dismissed' so it stops surfacing in reflection
      follow-ups.
  ship-summary <id> [--json]
      Print the arc-completion summary for a proposal: title, overall arc state
      (in-progress / arc-done / arc-failed), and one row per derived task showing
      its id, short title, and either the merged commit sha + subject (for landed
      tasks) or the current status (for in-flight tasks). Dropped tasks render as
      'dismissed'. --json emits a structured object instead of human-readable output.`,
  'set-functional': `mars set-functional <id> <text|@file>

Set the functional plan on a draft/queued task. Use @path to read from a
file.`,
  'set-technical': `mars set-technical <id> <text|@file>

Set the technical plan on a draft/queued task. Use @path to read from a
file.`,
  show: `mars show <id>

Print full detail for an id. Looks up tasks first (.mars/queue.db),
then proposals (.mars/state.db).`,
  list: `mars list [status]

List tasks. Status one of: draft, queued, running, verifying, merging,
vega-reconciling, done, failed, dropped. Defaults to all when omitted.`,
  continue: `mars continue <id> [<id> ...]

Resume failed task(s) on their existing worktree+branch, jumping
straight into the failed phase (verify or merge). Reuses every commit
the worker already landed on the task branch.

Accepts one or more ids; processes them in order and stops on the first
error (the failing id is printed to stderr and exit is non-zero).

Flags: none in v1.

Refuses (non-zero exit) when:
  - the task is not in 'failed' status
  - the task has no recorded failed_phase (legacy row)
  - the task failed in the 'code' phase (no verifiable artefact)
  - the branch or worktree is missing on disk
In those cases reach for 'mars restart <id>' to start over from setup.`,
  restart: `mars restart <id> [<id> ...]

Re-queue failed/done task(s) from setup. Removes each existing worktree
and branch first, then runs the full pipeline (setup -> code -> verify
-> merge) on a fresh worktree.

Accepts one or more ids; processes them in order and stops on the first
error.`,
  purge: `mars purge <id> [<id> ...] [--force]

Delete failed/done task(s) entirely (worktree + branch + row). Refuses
in-flight tasks.

Without --force, refuses if the task branch has commits ahead of the
integration branch (default 'main', override via INTEGRATION_BRANCH) to
prevent accidental loss of unique work. The refusal message lists each
unique commit so you can decide whether to cherry-pick before purging.

Pass --force to skip the commit-ahead check and delete unconditionally,
even when the branch carries unique commits not yet on the integration
branch.

Accepts one or more ids; processes them in order and stops on the first
error.`,
  drop: `mars drop <id> [--force]

Universal deletion verb. Works regardless of status (draft, queued,
blocked, running, verifying, merging, failed, done):
  - Removes the worktree on disk (if present) and force-deletes the
    task branch.
  - Deletes every task_blockers row mentioning <id> on either side
    so dependent rows don't dangle.
  - Sets fix_for_task_id = NULL on any sibling row that pointed at
    <id>, so the parent can be dropped independently of an orphan
    auto-recovery (the inverse case is the original motivator).
  - Deletes the tasks row itself.

Refuses if the task is currently dispatched (status in
running/verifying/merging, or the daemon's in-flight map still holds
a worker-pool slot for it) unless --force is passed. --force does NOT
kill the running claude subprocess — the workflow will continue to its
natural end and its terminal transition will silently fail when it
tries to write to the deleted row. The output reports what was
killed so the caller is not surprised.

Typical use: an auto-spawned recovery task is queued behind a parent
that got duplicated or is otherwise obsolete; 'mars purge <parent>'
fails with a FK error because the recovery still references it via
fix_for_task_id. 'mars drop <recovery>' followed by 'mars purge
<parent>' (or 'mars drop <parent>') clears both.`,
  sweep: `mars sweep

Enumerate local task/<id> branches whose id has no row in the queue and
interactively resolve each one.

For each orphan branch the command prints the branch name and its unique
commits ahead of the integration branch (default 'main', override via
INTEGRATION_BRANCH), then prompts for one of three actions:

  [k]eep                  — no-op; branch and commits are left untouched.
  [d]elete                — force-remove the local branch (unique commits
                            are discarded).
  [c]herry-pick-then-delete
                          — apply each unique commit onto the integration
                            branch in original order, then force-remove the
                            source branch. A cherry-pick conflict halts on
                            that branch with a message naming the conflicting
                            commit; the branch is left intact for manual
                            resolution and remaining orphans are still
                            processed.

No branch is ever modified without an explicit per-branch choice.

Requires an interactive terminal. Prints 'no orphan task branches' when
there are none.`,
  worktree: `mars worktree clean [--dry-run] [--force-orphans]
mars worktree prune [--dry-run]

Walk .mars/worktrees/ (and legacy .worktrees/), classify each directory
by joining against the matching queue.db row, and remove the safe ones.

'clean' classifications:
  done + branch merged into main          → remove
  failed/dropped + zero-commit branch     → remove
  orphan (no queue row) + zero-commit     → remove
  orphan + branch has commits             → kept (use --force-orphans)
  done + branch not merged                → kept (desync — not for this verb)
  in-flight (queued/running/verifying/    → kept (never touch)
    merging/ready)
  draft / blocked                         → kept

'prune' classifications (the bigger hammer):
  done                                    → remove (regardless of merge status)
  dropped                                 → remove (regardless of commit status)
  orphan (no queue row)                   → remove (always)
  failed                                  → kept (may contain useful work)
  in-flight (queued/running/verifying/    → kept (never touch)
    merging)
  draft / blocked                         → kept

Flags (both subcommands):
  --dry-run         print what would happen, change nothing, exit 0.

Flags (clean only):
  --force-orphans   also remove orphan worktrees whose branches contributed
                    commits (work is dropped — use with care).

Errors during 'git worktree remove' are caught, logged with the directory
path, and counted; the verb still processes remaining worktrees and exits
0 unless every action failed.`,
  daemon: `mars daemon <start|stop|restart|kill|status|reload|set-flag> [flags]

Run the orchestration daemon. CLI write ops auto-spawn it when needed.

Subcommands:
  start              fork the daemon to the background. Equivalent to the
                     legacy --detach flag form. No-op if already running.
  stop  [--force]    graceful shutdown: stop accepting new tasks, then wait
                     for in-flight tasks to finish and exit. No timeout — use
                     'kill' if you need to abort stuck work. --force exits
                     immediately and abandons in-flight tasks (legacy).
  restart            force-stop any running daemon, then start a fresh one
                     in the background. Exits 0 when the new daemon is up.
  kill               hard stop: mark every in-flight task failed and SIGKILL
                     the daemon's process group (kills all child claude -p
                     workers). Use when 'stop' is hanging on stuck work.
  status             print pid, startedAt, inFlight, and queue counts.
                     Equivalent to the legacy --status flag form.
  reload             re-read .mars/daemon.json (falling back to MARS_MAX_*
                     env vars and built-in defaults) without restarting
  set-flag <flag> <on|off>
                     toggle an in-memory kill-switch on the running daemon.
                     Currently only 'recovery' is supported: 'on' sets
                     MARS_RECOVERY_DISABLED=1 (fix-task/Investigator spawns
                     are suppressed); 'off' unsets it. Not persisted —
                     a daemon restart re-reads the spawn env.`,
  triage: `mars triage [<task-id>]

Run triage once on one draft, or all drafts in parallel. Haiku assesses
actionability.`,
  block: `mars block <task-id> <blocker-id> [<blocker-id> ...]

Insert one or more blocker edges so <task-id> waits for the listed blocker
tasks to reach 'done'. Every id must already exist in the queue. Self-blocking
is rejected. The dependent task does not dispatch until every blocker is done.`,
  unblock: `mars unblock <id>
       mars unblock <id> <blocker-id> [<blocker-id> ...]

Two distinct forms:

  mars unblock <id>
      Phantom-recovery escape hatch. Flips a 'blocked' task to 'failed' AND
      deletes every row in task_blockers for <id>. Use when a task is stuck
      on a blocker that no longer exists or was lost. Status changes; all
      edges are wiped.

  mars unblock <id> <blocker-id> [<blocker-id> ...]
      Edge removal. Deletes the listed (task, blocker) edges only. Errors
      per-id with 'no blocker edge: <id> -> <blocker-id>' when an edge is
      absent. Does NOT touch the task's status; the task remains in
      whatever state it was in.`,
  glossary: `mars glossary <subcommand> ...

Edit the project glossary at <repo>/CONTEXT.md via deterministic, no-LLM
structured writes. Write subcommands route through the daemon: a fresh
worktree is spawned off the integration branch, CONTEXT.md is mutated,
committed, and merged back via the existing merge lock. The CLI returns
as soon as the daemon accepts the request — the merge lands in the
background.

Subcommands:
  set "<term>" "<definition>" [--avoid alias1,alias2]
      Add or update a glossary term. Aliases in --avoid become the
      "_Avoid_" line under the term.
  remove "<term>"
      Remove a term from the glossary.
  list
      List all terms currently in CONTEXT.md (local read; no daemon).
  show "<term>"
      Print a single term's definition and aliases.`,
  adr: `mars adr <subcommand> ...

Manage ADRs (Architecture Decision Records) under <repo>/docs/adr/. Add
goes through the daemon as a structured write (worktree → commit → merge);
list/show are local reads.

Subcommands:
  add "<title>" "<body>"
      Append a new ADR. Numbering is sequential (scan of docs/adr/);
      filename slug derived from the title. Body may be @path to read
      from a file.
  list
      List all ADRs in docs/adr/.
  show <NNNN|filename>
      Print one ADR's contents. Number prefix is matched after zero-padding.`,
  project: `mars project <subcommand> ...

Manage the project registry (~/.mars/projects.json). Each entry maps a
unique projectId to a repoRoot and a human-readable name.

Subcommands:
  add <path> [--name <label>]
      Register a project. <path> is resolved to an absolute repoRoot;
      errors if the directory does not exist or is already registered.
      Prints the new projectId on success.
  list
      Print a table of projectId | name | repoRoot for every registered
      project. Prints "(no projects registered)" when the list is empty.
  remove <projectId>
      Remove a project entry. Prints "removed <id>" on success or
      "no such project: <id>" when the id is unknown.`,
  arc: `mars arc <subcommand> ...

Subcommands:
  list [--limit N] [--json] [--with-transcript-only]
      List task arcs grouped by COALESCE(origin_id, id) so ad-hoc tasks
      without a proposal still appear as one-task arcs.

      Text output: header row, then one tab-separated row per arc:
        originId  tasks  done  failed  tokens  lastActivity

      Flags:
        --limit N              max arcs to return (default 10, clamped to [1, 100])
        --json                 emit a JSON array of ArcCandidate objects
        --with-transcript-only only include arcs with at least one stored transcript

  reflect [<originId-or-task-id>]
      Deep post-mortem on a Mars arc.

      When called with no arguments, prints the arc list (same output as
      'mars arc list') and prompts the operator to pick an originId. The
      picker is interactive: type the originId and press Enter.

      Positional argument:
        <originId-or-task-id>   Run arc-level reflection across every task in
                                the arc. Accepts an originId or any task id
                                that belongs to the arc; the origin is resolved
                                automatically via COALESCE(origin_id, id). A
                                one-task arc collapses to that single
                                transcript, so passing a leaf task id is
                                supported.
                                Output: .mars/deep-reflections/arc-<id>-<iso>.json

      Walks every transcript event-by-event to surface dissonant tool calls,
      verify-claim mismatches, and thrashing patterns. Transcripts are read
      directly from Claude Code's on-disk JSONL files under
      ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl; tasks with no
      recorded session ids (or with files the user has since cleaned) get
      a degraded report that notes the absence instead of crashing.

      Disabled by MARS_REFLECT_DISABLED=1. Model defaults to opus; override
      with MARS_DEEP_REFLECT_MODEL.`,
  reflect: `mars reflect [--since <iso>] [--limit <n>]

Synthesize draft task suggestions from recent completed tasks. Reads
token + scorer signals from .mars/queue.db. Default: last 10 completed
tasks. Suggestions are inserted as proposals — never auto-run. Disable
signal capture entirely with the env var MARS_REFLECT_DISABLED=1.

Flags:
  --since <iso>   only reflect on tasks completed after this ISO timestamp
  --limit <n>     max number of tasks to include (default: 10)`,
  'action-queue': `mars action-queue <subcommand> ...

Subcommands:
  (no args)                          alias for 'action-queue list open'
  list [state] [--lean]              list items by state
                                     (open|acknowledged|resolved|dismissed|all,
                                     default: open). --lean prints a
                                     compact summary (counts per
                                     priority, then up to 3 oldest
                                     blockers and 3 oldest drafts with
                                     section totals) instead of one row
                                     per item; designed for SessionStart
                                     hooks.
  show <id>                          full detail (accepts full id or unique
                                     8-char prefix)
  ack <id>                           mark item acknowledged
  resolve <id> [--note <text>] [--root-cause <text>]
                                     mark item resolved
  dismiss <id> [--note <text>]       mark item dismissed
  raise --from <-|path>              file a new action queue item from JSON.
                                     Use --from - to read JSON from stdin,
                                     or --from <path> to read it from a file.
                                     This is the CORRECT entry point for
                                     dispatched agents (self-heal
                                     investigations, anything running
                                     inside a worktree) — it
                                     replaces the deprecated pattern of
                                     writing one-shot .ts scripts under
                                     orchestrator/scripts/. The JSON
                                     document must include the fields:
                                       kind, category, priority, title,
                                       body, payload, context, raisedBy,
                                       signature
                                     plus an optional 'occurrence' object.
                                     Dedup by (kind, signature) is handled
                                     server-side: piping the same payload
                                     twice bumps seen_count instead of
                                     creating a duplicate row. Prints the
                                     action queue id on stdout, one line, no
                                     decoration. Exit codes: 0 ok, 1
                                     library error, 2 parse/validation
                                     error.
  watch                              live terminal UI for the todo feed
                                     (drafts + stale worktrees, grouped
                                     by Today / Yesterday / This Week /
                                     Older; ink TUI; j/k move, enter
                                     detail, b/escape back, q quit).
                                     The non-watch \`mars action-queue\` verbs
                                     keep managing the orchestrator
                                     action_queue_items table.`,
  uninstall: `mars uninstall [--yes|-y] [--wrapper <path>]

Remove the installed mars wrapper binary and its source clone.

Resolves both paths from the running wrapper rather than from environment
variables — the binary on PATH whose contents reference this cli entry
point is the binary that would be removed; the clone is derived from
that binary's exec line. Wrapper is deleted first; if either path is
already absent the command still proceeds. Per-repo .mars/ and
.worktrees/ directories are never touched.

Flags:
  --yes, -y          skip the interactive confirmation prompt (required
                     for use from a non-TTY stdin, e.g. scripts).
  --wrapper <path>   override wrapper auto-detection (useful when the
                     installed wrapper is not on PATH).

Answer "n" at the prompt to cancel without deleting anything.`,
  where: `mars where

Print resolved repo + state directory.`,
  ui: `mars ui [--repo <path>] [--port <n>] [--host <h>]
mars ui stop  [--repo <path>]
mars ui status [--repo <path>]

Launch the read-only Kanban viewer. Resolves the bundled
ui/bin/mars-ui.mjs launcher (which spawns the SSE server, serves the
built dashboard when ui/dist/ exists, and forwards exit code).

Subcommands:
  stop    Send SIGTERM to a running mars ui process (SIGKILL after 2s).
          Removes .mars/ui.pid.json. Prints 'no mars ui running' and
          exits 0 if nothing is running.
  status  Print pid/port/url of a running mars ui, or 'not running'.

Flags:
  --repo <path>   target repo (defaults to the resolver: --repo > MARS_REPO > git toplevel)
  --port <n>      bind port (default: 7777)
  --host <h>      bind host (default: 127.0.0.1)`,
  cut: `mars cut verify <drain|reset|recreate>

Gate checks for the hard-cut to 4-letter id tags (PRD 52ec700f).
Run each command at the corresponding phase of the runbook.

Phases:
  drain
      Exits 0 only when no tasks are in queued, blocked, or running status.
      Lists any remaining in-flight tasks so the operator can wait or purge.

  reset
      Exits 0 only when every id-bearing table (tasks, proposals, action_queue_items,
      etc.) has zero rows in the DB. Run after deleting .mars/mars.db and
      re-initialising with 'mars init'.

  recreate
      Exits 0 only when none of the superseded/dropped ids (04830c8e,
      07201a16, 26471262) appear as a hex suffix of any current id.
      Also prints a checklist of the seven carry-forward proposal titles,
      marking each as ✓ (re-entered) or ✗ (still missing).`,
  observability: `mars observability <subcommand> ...

Subcommands:
  prune [<days>]
      Delete telemetry rows from the trace_events store older than <days>
      days. Default: 3. Pass 0 to wipe all rows regardless of age.

      Prints the number of rows removed. Safe to run while the Mars daemon
      is running — no need to stop the daemon or delete the store file.

      Examples:
        mars observability prune         # delete rows older than 3 days
        mars observability prune 7       # delete rows older than 7 days
        mars observability prune 0       # wipe all telemetry rows`,
  worker: `mars worker <subcommand> ...

Subcommands:
  list
      Print all known Workers — hard-coded defaults merged with any
      entries in the persisted registry (.mars/worker-registry.json).
      When no registry file exists, only the five built-in Workers
      (Coder, Planner, Slicer, Triager, Fixer) are shown.

  add <name> --model <model> [flags]
      Write a Worker declaration to the registry file. Seeds the file
      from hard-coded defaults on the first write. If the name matches
      an existing worker (built-in or registry), it is overwritten.

      Required:
        <name>            Worker name (case-sensitive)
        --model <model>   Claude model identifier

      Optional:
        --effort <level>          one of low|medium|high|xhigh|max (default: high)
        --permission-mode <mode>  one of default|bypassPermissions|... (default: default)
        --max-messages <n>        non-negative integer; 0 = unbounded (default: 0)
        --tag <tag>               routing tag; repeatable. Tasks whose tag list
                                  intersects this set are routed to this Worker.
                                  Any string is valid; use domain-specific tags
                                  (e.g. 'scaffold', 'docs') that do not collide
                                  with built-in tags (coder, planner, slicer,
                                  triager, fixer) unless overriding is intended.`,
  help: `mars help [command]

Show top-level help, or detailed help for a single command. Equivalent
to 'mars <command> --help'.`,
}

const printCommandHelp = (cmd: string): boolean => {
  const text = COMMAND_HELP[cmd]
  if (!text) return false
  console.log(text)
  return true
}

const main = async (): Promise<void> => {
  const rawArgv = process.argv.slice(2)

  // --version / -v short-circuits BEFORE any subcommand parsing,
  // context resolution, or other side effects. The constant is
  // injected at build time from package.json.
  if (rawArgv.includes('--version') || rawArgv.includes('-v')) {
    console.log(MARS_VERSION)
    return
  }

  const { repo, flags, multiFlags, positional } = parseArgs(rawArgv)
  const cmd = positional[0]
  const rest = positional.slice(1)

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    // 'mars help <cmd>' or 'mars --help <cmd>' prints per-command help.
    const target = rest[0]
    if (target && printCommandHelp(target)) return
    console.log(usage)
    return
  }

  if (rest.some((a) => HELP_FLAGS.has(a))) {
    if (printCommandHelp(cmd)) return
    console.log(usage)
    return
  }

  if (cmd === 'ui') {
    const subCmd = rest[0]
    if (subCmd === 'stop') {
      const { stopUi } = await import('./cli/ui')
      stopUi(repo)
      return
    }
    if (subCmd === 'status') {
      const { statusUi } = await import('./cli/ui')
      statusUi(repo)
      return
    }
    const { launchUi } = await import('./cli/ui')
    launchUi({
      repo,
      port: flags['--port'],
      host: flags['--host'],
      dev: rest.includes('--dev'),
    })
    return
  }

  const { resolveContext } = await import('./core/context')
  const ctx = resolveContext(repo)

  if (cmd === 'where') {
    console.log(`repo:           ${ctx.repoRoot}`)
    console.log(`stateDir:       ${ctx.stateDir}`)
    console.log(`queueDb:        ${ctx.queueDbPath}`)
    console.log(`supervisorsDir: ${ctx.supervisorsDir}`)
    return
  }

  if (cmd === 'worker') {
    const sub = rest[0]

    if (sub === 'list') {
      const { listMergedWorkers } = await import(
        './core/workers/persisted-registry'
      )
      const workers = listMergedWorkers(ctx.stateDir)
      const header =
        'NAME'.padEnd(20) +
        'MODEL'.padEnd(36) +
        'EFFORT'.padEnd(10) +
        'PERMISSION'
      console.log(header)
      for (const w of workers) {
        const perm =
          w.permissionMode === 'bypassPermissions' ? 'bypass' : w.permissionMode
        console.log(
          w.name.padEnd(20) + w.model.padEnd(36) + w.effort.padEnd(10) + perm,
        )
      }
      return
    }

    if (sub === 'add') {
      const name = rest[1]
      const model = flags['--model']
      if (!name || !model) {
        console.error(
          'usage: mars worker add <name> --model <model> [--effort high|medium|...] [--permission-mode default|bypassPermissions] [--tag <tag> ...]',
        )
        process.exit(1)
      }

      const effortRaw = flags['--effort'] ?? 'high'
      const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
      if (!VALID_EFFORTS.has(effortRaw)) {
        console.error(
          `effort must be one of low, medium, high, xhigh, max; got '${effortRaw}'`,
        )
        process.exit(1)
      }

      const permRaw = flags['--permission-mode'] ?? 'default'
      const VALID_PERMS = new Set([
        'acceptEdits',
        'auto',
        'bypassPermissions',
        'default',
        'dontAsk',
        'plan',
      ])
      if (!VALID_PERMS.has(permRaw)) {
        console.error(
          `permission-mode must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan; got '${permRaw}'`,
        )
        process.exit(1)
      }

      const tags = multiFlags['--tag']

      const { addWorkerToRegistry } = await import(
        './core/workers/persisted-registry'
      )
      addWorkerToRegistry(ctx.stateDir, {
        name,
        model,
        effort: effortRaw as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
        permissionMode: permRaw as
          | 'acceptEdits'
          | 'auto'
          | 'bypassPermissions'
          | 'default'
          | 'dontAsk'
          | 'plan',
        bare: false,
        disallowedTools: [],
        outputFormat: 'stream-json',
        runtime: 'headless',
        ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
      })
      console.log(`added worker ${name}`)
      return
    }

    console.error('usage: mars worker <list|add>')
    process.exit(2)
  }

  if (cmd === 'init') {
    const boolFlags = new Set(rest.filter((a) => a.startsWith('--')))
    const force = boolFlags.has('--force')
    const dryRun = boolFlags.has('--dry-run')
    const verbose = boolFlags.has('--verbose')
    // `-f <path>` / `--config <path>`: declarative TOML config that names each
    // tech-bearing folder + its technology, bypassing auto-detection.
    const configPath = flags['--config']
    const { sendRequest } = await import('./core/daemon/client')
    let result
    try {
      result = (await sendRequest({
        op: 'init',
        opts: { force, dryRun, verbose, ...(configPath ? { configPath } : {}) },
      })) as Awaited<
        ReturnType<typeof import('./workflows/init-workflow').runInit>
      >
    } catch (err: unknown) {
      const e = err as Error & { code?: string }
      if (e.code?.startsWith('init-config:')) {
        console.error(`error: ${e.message}`)
        console.error(`  config: ${e.code.slice('init-config:'.length)}`)
        process.exit(1)
      }
      if (e.code?.startsWith('nested-tech:')) {
        const [outer, inner] = e.code.slice('nested-tech:'.length).split('::')
        console.error(`error: ${e.message}`)
        console.error(`  outer: ${outer}`)
        console.error(`  inner: ${inner}`)
        process.exit(1)
      }
      if (e.code?.startsWith('walk-access:')) {
        console.error(`error: ${e.message}`)
        console.error(`  path:  ${e.code.slice('walk-access:'.length)}`)
        process.exit(1)
      }
      throw err
    }

    if (result.status === 'dry-run') {
      console.log('dry run: no files written')
      return
    }
    if (
      result.status === 'aborted-existing' ||
      result.status === 'aborted-conflict'
    ) {
      console.error(result.message)
      process.exit(1)
    }

    console.log('wrote:')
    for (const w of result.written ?? []) console.log(`  ${w}`)
    const { resolveLauncher, printUiDiscoveryHint } = await import('./cli/ui')
    printUiDiscoveryHint(ctx.repoRoot, resolveLauncher())
    return
  }

  if (cmd === 'install') {
    // Consumer install entrypoint (slice 1/5).
    //
    // Lays every file listed in the framework's manifest.json down in the
    // consumer repo (cwd → ctx.repoRoot), then writes mars.lock at the
    // consumer root. Owned files overwrite unconditionally (ADR-0004);
    // hybrid files write only if absent (ADR-0007 refuse-on-existence is
    // implemented in slice 2).
    const { fileURLToPath } = await import('node:url')
    const { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } =
      await import('node:fs')
    const { dirname: dirnameOf, join: pathJoin, resolve: pathResolve } =
      await import('node:path')
    const { runInstall } = await import('./commands/install.js')
    const installModule = await import('./commands/install.js')
    type Manifest = import('./commands/install.js').Manifest
    type InstallDeps = import('./commands/install.js').InstallDeps
    void installModule

    // cli.ts lives at <frameworkRoot>/orchestrator/src/cli.ts (source) or
    // a sibling location in a compiled binary. Resolve the framework root
    // by walking up three directories from the entry file.
    const cliEntryPath = fileURLToPath(import.meta.url)
    const frameworkRoot = dirnameOf(dirnameOf(dirnameOf(cliEntryPath)))
    const manifestPath = pathResolve(frameworkRoot, 'manifest.json')

    if (!existsSync(manifestPath)) {
      console.error(`mars install: manifest not found at ${manifestPath}`)
      process.exit(1)
    }

    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`mars install: failed to parse ${manifestPath}: ${msg}`)
      process.exit(1)
    }

    const consumerRoot = ctx.repoRoot

    const deps: InstallDeps = {
      readBytes: (srcPath: string): Buffer => readFileSync(srcPath),
      writeFile: (dstPath: string, content: Buffer, mode?: number): void => {
        mkdirSync(dirnameOf(dstPath), { recursive: true })
        writeFileSync(dstPath, content)
        if (mode !== undefined) chmodSync(dstPath, mode)
      },
      exists: (p: string): boolean => existsSync(p),
      log: (msg: string): void => console.log(msg),
    }

    void pathJoin // suppress unused-import lint; kept for parity with init block

    try {
      const result = await runInstall(
        manifest,
        frameworkRoot,
        consumerRoot,
        MARS_VERSION,
        deps,
      )
      if (result.outcome === 'success') {
        console.log(
          `mars install: ${result.outcome} (${result.lock.files.length} files)`,
        )
        return
      }
      if (result.outcome === 'refused-already-installed') {
        console.error(
          'mars install: refused — this repo is already installed ' +
            '(mars.lock already exists). Run `mars update` to update an ' +
            'existing install.',
        )
        process.exit(1)
      }
      // refused-hybrid-collision
      console.error(
        'mars install: refused — one or more destination files already ' +
          'exist in this repo (ADR-0007 — hybrid files refuse on existence).',
      )
      console.error('')
      console.error('Colliding paths:')
      for (const p of result.collidingPaths) {
        console.error(`  ${p}`)
      }
      console.error('')
      console.error(
        'Back up and remove each of the files listed above, then re-run ' +
          '`mars install`.',
      )
      process.exit(1)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`mars install: ${msg}`)
      process.exit(1)
    }
    return
  }

  const enqueueViaDaemon = async (
    prompt: string,
    skipTriage: boolean,
    blockerIds?: readonly string[],
    priority?: number,
    tags?: string[],
    spec?: {
      files: readonly string[]
      verifyCmd: string | null
      doneCriteria: readonly string[]
      taskType: 'auto' | 'checkpoint'
      readFirst?: readonly string[]
      prescriptiveAction?: string | null | undefined
    },
  ): Promise<void> => {
    const { detectNoCommitMarker } = await import('./core/lib/no-commit-marker')
    const marker = detectNoCommitMarker(prompt)
    if (marker !== null) {
      console.error(
        `[mars] refusing to enqueue: prompt declares it produces no commit (matched: ${marker.slice(0, 80)}).`,
      )
      console.error(
        `[mars] the orchestrator's verify step requires at least one commit ahead of the integration branch;`,
      )
      console.error(
        `[mars] running this through Mars would loop forever. Run the operation manually instead.`,
      )
      process.exit(1)
    }
    const functional = resolvePlanText(
      flags,
      ['--functional', '--func'],
      '--functional-file',
    )
    const technical = resolvePlanText(
      flags,
      ['--technical', '--tech'],
      '--technical-file',
    )
    const plan =
      functional !== undefined || technical !== undefined
        ? { functional: functional ?? '', technical: technical ?? '' }
        : undefined
    const { resolveAuthor, formatAuthor } = await import('./core/author')
    const author = resolveAuthor(flags['--author'])
    const { sendRequest } = await import('./core/daemon/client')
    const task = (await sendRequest(
      {
        op: 'add',
        prompt,
        plan,
        skipTriage,
        author,
        ...(blockerIds && blockerIds.length > 0 ? { blockerIds } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(spec !== undefined ? { spec } : {}),
      },
      {
        onSpawnNotice: (pid, log) =>
          console.log(`[mars] started daemon (pid ${pid}, log: ${log})`),
      },
    )) as { id: string; status: string }
    const verb = task.status === 'queued' ? 'queued' : 'drafted'
    const suffix =
      blockerIds && blockerIds.length > 0
        ? ` (blocked by: ${blockerIds.join(', ')}; author: ${formatAuthor(author)})`
        : ` (author: ${formatAuthor(author)})`
    console.log(`${verb} ${task.id}${suffix}`)
  }

  if (cmd === 'add') {
    console.error(
      `[mars] 'mars add' is deprecated; use 'mars task add' (skip refinement) or 'mars proposal add' (plan with author).`,
    )
    const prompt = rest.join(' ')
    if (!prompt) {
      console.error('prompt required')
      process.exit(1)
    }
    await enqueueViaDaemon(prompt, false)
    return
  }

  if (cmd === 'task') {
    const sub = rest[0]
    if (sub === 'add') {
      const prompt = rest.slice(1).join(' ')
      if (!prompt) {
        console.error(
          'usage: mars task add "<prompt>" [--author kind:name] [--blocked-by <id> ...] [--priority 0..3] [--tag coder] [--files <path> ...] [--verify "<cmd>"] [--done "<criterion>" ...] [--type auto|checkpoint] [plan flags]',
        )
        process.exit(1)
      }
      const blockerIds = multiFlags['--blocked-by'] ?? []
      const priorityRaw = flags['--priority']
      let priority: number | undefined
      if (priorityRaw !== undefined) {
        const n = Number(priorityRaw)
        if (!Number.isInteger(n) || n < 0 || n > 3) {
          console.error(`priority must be an integer in 0..3; got '${priorityRaw}'`)
          process.exit(1)
        }
        priority = n
      }
      const tags: string[] | undefined =
        multiFlags['--tag'] && multiFlags['--tag'].length > 0
          ? multiFlags['--tag']
          : undefined
      // Structured-task spec (gsd-style). Any of --files/--verify/--done/--type
      // promotes the row from free-prose to structured. If none are passed, the
      // row keeps the legacy shape (spec column NULL) and the agent sees only
      // `prompt` — preserving day-zero behaviour for ad-hoc `mars task add`.
      const filesList = multiFlags['--files'] ?? []
      const doneList = multiFlags['--done'] ?? []
      const verifyRaw = flags['--verify']
      const typeRaw = flags['--type']
      let spec:
        | {
            files: readonly string[]
            verifyCmd: string | null
            doneCriteria: readonly string[]
            taskType: 'auto' | 'checkpoint'
          }
        | undefined
      const anySpec =
        filesList.length > 0 ||
        doneList.length > 0 ||
        verifyRaw !== undefined ||
        typeRaw !== undefined
      if (anySpec) {
        let taskType: 'auto' | 'checkpoint' = 'auto'
        if (typeRaw !== undefined) {
          if (typeRaw !== 'auto' && typeRaw !== 'checkpoint') {
            console.error(
              `type must be one of auto, checkpoint; got '${typeRaw}'`,
            )
            process.exit(1)
          }
          taskType = typeRaw
        }
        spec = {
          files: filesList,
          verifyCmd: verifyRaw ?? null,
          doneCriteria: doneList,
          taskType,
        }
      }
      await enqueueViaDaemon(prompt, true, blockerIds, priority, tags, spec)
      return
    }
    if (sub === 'show') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars task show <id>')
        process.exit(1)
      }
      const { formatAuthor } = await import('./core/author')
      const { getTask, listBlockers, listSiblings } = await import(
        './core/queue'
      )
      const task = await getTask(id)
      if (!task) {
        console.error(`no task matching ${id}`)
        process.exit(1)
      }
      console.log(`kind:       task`)
      console.log(`id:         ${task.id}`)
      console.log(`Status:     ${task.status}`)
      console.log(`tags:       ${(task.tags ?? ['coder']).join(', ')}`)
      console.log(`author:     ${formatAuthor(task.author)}`)
      console.log(`branch:     ${task.branch ?? '-'}`)
      console.log(`worktree:   ${task.worktreePath ?? '-'}`)
      console.log(`createdAt:  ${task.createdAt}`)
      console.log(`updatedAt:  ${task.updatedAt}`)
      console.log(`prompt:`)
      console.log(task.prompt)
      console.log(`functional:`)
      console.log(task.plan?.functional ?? '(empty)')
      console.log(`technical:`)
      console.log(task.plan?.technical ?? '(empty)')
      if (task.spec) {
        if (task.spec.files.length > 0) {
          console.log(`files:`)
          for (const f of task.spec.files) console.log(`  - ${f}`)
        }
        const readFirst = task.spec.readFirst ?? []
        if (readFirst.length > 0) {
          console.log(`readFirst:`)
          readFirst.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
        }
        const prescriptiveAction = task.spec.prescriptiveAction ?? null
        if (prescriptiveAction) {
          console.log(`prescriptiveAction:`)
          console.log(prescriptiveAction)
        }
        if (task.spec.verifyCmd) {
          console.log(`verifyCmd: ${task.spec.verifyCmd}`)
        }
        if (task.spec.doneCriteria.length > 0) {
          console.log(`doneCriteria:`)
          for (const c of task.spec.doneCriteria) console.log(`  - [ ] ${c}`)
        }
      }
      if (task.error) {
        console.log(`error:`)
        console.log(task.error)
      }
      if (task.dropReason) {
        console.log(`dropReason: ${task.dropReason}`)
      }
      if (task.failureReason) {
        console.log(`failureReason: ${task.failureReason}`)
      }
      if (task.retryCount > 0) {
        console.log(`retryCount: ${task.retryCount}`)
      }
      if (task.fixForTaskId) {
        console.log(`fixForTask: ${task.fixForTaskId}`)
      }
      if (task.failureSignature) {
        console.log(`failureSig: ${task.failureSignature}`)
        const { causeForSignature } = await import(
          './core/lib/failure-signature'
        )
        const cause = causeForSignature(task.failureSignature, task.id)
        if (cause) {
          console.log(`cause:      ${cause}`)
        }
      }
      const blockerTaskIds = await listBlockers(task.id)
      if (blockerTaskIds.length > 0) {
        console.log(`blockedBy:  ${blockerTaskIds.join(', ')}`)
      }
      if (task.originId && task.originId !== task.id) {
        const { getProposal } = await import('./core/proposals')
        const originIdea = await getProposal(task.originId).catch(() => null)
        if (originIdea) {
          const firstLine = originIdea.title.split('\n')[0]?.trim() ?? ''
          const titleSuffix = firstLine.length > 0 ? ` ${firstLine}` : ''
          console.log(`origin:     proposal ${originIdea.id}${titleSuffix}`)
        } else {
          console.log(`origin:     task ${task.originId}`)
        }
        const siblings = await listSiblings(task.originId, task.id)
        if (siblings.length > 0) {
          console.log(`siblings:   ${siblings.join(', ')}`)
        }
      }
      return
    }
    if (sub === 'priority') {
      const id = rest[1]
      const valueRaw = rest[2]
      if (!id || valueRaw === undefined) {
        console.error('usage: mars task priority <id> <0..3>')
        process.exit(1)
      }
      const value = Number(valueRaw)
      if (!Number.isInteger(value) || value < 0 || value > 3) {
        console.error(`priority must be an integer in 0..3; got '${valueRaw}'`)
        process.exit(1)
      }
      const { sendRequest } = await import('./core/daemon/client')
      try {
        const task = (await sendRequest({
          op: 'task.priority',
          id,
          priority: value,
        })) as { id: string; priority: number }
        console.log(`set priority of ${task.id} to ${task.priority}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    console.error('usage: mars task <add|show|priority> ...')
    process.exit(1)
  }

  if (cmd === 'proposal') {
    const sub = rest[0]
    if (sub === 'add') {
      const goal = rest.slice(1).join(' ')
      if (!goal) {
        console.error('usage: mars proposal add "<goal>" [--author kind:name]')
        process.exit(1)
      }
      const { resolveAuthor, formatAuthor } = await import('./core/author')
      const author = resolveAuthor(flags['--author'])
      const { createProposal } = await import('./core/proposals')
      try {
        const idea = await createProposal(goal, { author })
        console.log(`${idea.id} (author: ${formatAuthor(author)})`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'new') {
      const goal = rest.slice(1).join(' ')
      if (!goal) {
        console.error('usage: mars proposal new "<goal>"')
        process.exit(1)
      }
      const { createProposal } = await import('./core/proposals')
      try {
        const idea = await createProposal(goal)
        console.log(idea.id)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'show') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars proposal show <id>')
        process.exit(1)
      }
      const { getProposal, resolveProposalId } = await import(
        './core/proposals'
      )
      const { formatAuthor } = await import('./core/author')
      const resolved = await resolveProposalId(id)
      if (resolved.kind === 'ambiguous') {
        console.error(
          `ambiguous prefix '${id}' matches ${resolved.count} proposals`,
        )
        process.exit(1)
      }
      const idea =
        resolved.kind === 'unique' ? await getProposal(resolved.id) : null
      if (!idea) {
        console.error(`proposal ${id} not found`)
        process.exit(1)
      }
      console.log(`id:         ${idea.id}`)
      console.log(`status:     ${idea.status}`)
      console.log(`source:     ${idea.source}`)
      console.log(`author:     ${formatAuthor(idea.author)}`)
      console.log(`createdAt:  ${new Date(idea.createdAt).toISOString()}`)
      console.log(`updatedAt:  ${new Date(idea.updatedAt).toISOString()}`)
      console.log(`title:`)
      console.log(idea.title)
      if (idea.problem.trim().length > 0) {
        console.log(`problem:`)
        console.log(idea.problem)
      }
      if (idea.solution.trim().length > 0) {
        console.log(`solution:`)
        console.log(idea.solution)
      }
      if (idea.userStories.length > 0) {
        console.log(`user stories:`)
        idea.userStories.forEach((s, i) => console.log(`  [${i}] ${s}`))
      }
      if (idea.outOfScope.trim().length > 0) {
        console.log(`out of scope:`)
        console.log(idea.outOfScope)
      }
      if (idea.notes.trim().length > 0) {
        console.log(`notes:`)
        console.log(idea.notes)
      }
      const { listTasksForProposal } = await import('./core/queue')
      const proposalTasks = await listTasksForProposal(idea.id)
      if (proposalTasks.length > 0) {
        console.log(
          `tasks:      ${proposalTasks.map((t) => `${t.id} (${t.status})`).join(', ')}`,
        )
      }
      return
    }
    if (sub === 'set') {
      const id = rest[1]
      const field = rest[2]
      const value = rest.slice(3).join(' ')
      if (!id || !field || value.length === 0) {
        console.error(
          'usage: mars proposal set <id> <title|problem|solution|out-of-scope|notes|status> "<text>"',
        )
        process.exit(1)
      }
      if (
        field !== 'title' &&
        field !== 'problem' &&
        field !== 'solution' &&
        field !== 'out-of-scope' &&
        field !== 'notes' &&
        field !== 'status'
      ) {
        console.error(
          `unknown field '${field}'; expected one of title|problem|solution|out-of-scope|notes|status`,
        )
        process.exit(1)
      }
      const { setProposalField } = await import('./core/proposals')
      try {
        await setProposalField(id, field, value)
        console.log(`updated ${id}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'add-user-story') {
      const id = rest[1]
      const story = rest.slice(2).join(' ')
      if (!id || story.length === 0) {
        console.error('usage: mars proposal add-user-story <id> "<text>"')
        process.exit(1)
      }
      const { addProposalUserStory } = await import('./core/proposals')
      try {
        const idea = await addProposalUserStory(id, story)
        console.log(`added user story [${idea.userStories.length - 1}] to ${id}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'remove-user-story') {
      const id = rest[1]
      const idxRaw = rest[2]
      if (!id || idxRaw === undefined) {
        console.error('usage: mars proposal remove-user-story <id> <index>')
        process.exit(1)
      }
      const idx = Number(idxRaw)
      if (!Number.isInteger(idx) || idx < 0) {
        console.error(`index must be a non-negative integer; got '${idxRaw}'`)
        process.exit(1)
      }
      const { removeProposalUserStory } = await import('./core/proposals')
      try {
        await removeProposalUserStory(id, idx)
        console.log(`removed user story [${idx}] from ${id}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'promote') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars proposal promote <id>')
        process.exit(1)
      }
      const { sendRequest } = await import('./core/daemon/client')
      try {
        const r = (await sendRequest(
          { op: 'proposal.promote', proposalId: id },
          {
            onSpawnNotice: (pid, log) =>
              console.log(`[mars] started daemon (pid ${pid}, log: ${log})`),
          },
        )) as { proposalId: string; status: string }
        console.log(`proposal ${r.proposalId} marked ${r.status}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'slice') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars proposal slice <id>')
        process.exit(1)
      }
      const { sendRequest } = await import('./core/daemon/client')
      try {
        const r = (await sendRequest(
          { op: 'proposal.slice', proposalId: id },
          {
            onSpawnNotice: (pid, log) =>
              console.log(`[mars] started daemon (pid ${pid}, log: ${log})`),
          },
        )) as { proposalId: string; status: string; taskIds: string[] }
        console.log(
          `proposal ${r.proposalId} ${r.status} into ${r.taskIds.length} task(s):`,
        )
        for (const t of r.taskIds) console.log(`  ${t}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'reject') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars proposal reject <id>')
        process.exit(1)
      }
      const { rejectProposal } = await import('./core/proposals')
      try {
        const idea = await rejectProposal(id)
        console.log(`rejected ${idea.id}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'delete') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars proposal delete <id>')
        process.exit(1)
      }
      const { deleteProposal } = await import('./core/proposals')
      try {
        const deletedId = await deleteProposal(id)
        console.log(`deleted ${deletedId}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'list') {
      const sourceFlag = flags['--source']
      const statusFlag = flags['--status']
      const allowedSource = new Set(['reflection', 'human', 'planner'])
      if (sourceFlag !== undefined && !allowedSource.has(sourceFlag)) {
        console.error(
          `--source must be one of: reflection|human|planner; got '${sourceFlag}'`,
        )
        process.exit(1)
      }
      const { listProposals } = await import('./core/proposals')
      const filter: { source?: 'reflection' | 'human' | 'planner'; status?: string } = {}
      if (sourceFlag) filter.source = sourceFlag as 'reflection' | 'human' | 'planner'
      if (statusFlag) filter.status = statusFlag
      const ideas = await listProposals(filter)
      if (ideas.length === 0) {
        console.log('no proposals')
        return
      }
      for (const i of ideas) {
        const title = i.title.trim() || '(no title)'
        console.log(
          `${i.id.slice(0, 8)}\t${i.status}\tsource=${i.source}\t${title}`,
        )
      }
      return
    }
    if (sub === 'block') {
      // ADR-0008 planning-graph edge: <idea-id> waits on each <blocker-id>.
      // Mirrors the top-level `mars block` task->task verb shape.
      const id = rest[1]
      const blockerArgs = rest.slice(2)
      if (!id || blockerArgs.length === 0) {
        console.error(
          'usage: mars proposal block <idea-id> <blocker-id> [<blocker-id> ...]',
        )
        process.exit(1)
      }
      if (blockerArgs.some((b) => b === id)) {
        console.error(`proposal ${id} cannot block itself`)
        process.exit(1)
      }
      const { addProposalDependencies } = await import('./core/proposals')
      try {
        await addProposalDependencies(id, blockerArgs)
        console.log(`blocked ${id} by: ${blockerArgs.join(', ')}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'unblock') {
      // Edge-removal for ADR-0008 planning-graph edges. Each (idea, blocker)
      // pair given is removed; the idea's status is unchanged.
      const id = rest[1]
      const blockerArgs = rest.slice(2)
      if (!id || blockerArgs.length === 0) {
        console.error(
          'usage: mars proposal unblock <idea-id> <blocker-id> [<blocker-id> ...]',
        )
        process.exit(1)
      }
      const { removeProposalDependency } = await import('./core/proposals')
      try {
        const removed: string[] = []
        for (const b of blockerArgs) {
          const r = await removeProposalDependency(id, b)
          if (r.removed) removed.push(b)
        }
        console.log(
          removed.length > 0
            ? `unblocked ${id} from: ${removed.join(', ')}`
            : `no matching edges removed for ${id}`,
        )
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'blockers') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars proposal blockers <idea-id>')
        process.exit(1)
      }
      const { listProposalDependencies } = await import('./core/proposals')
      try {
        const blockers = await listProposalDependencies(id)
        if (blockers.length === 0) {
          console.log(`no blockers on ${id}`)
          return
        }
        for (const b of blockers) console.log(b)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'block-task') {
      // ADR-0015 cross-graph edge: <task-id> waits on each <idea-id>. The
      // proposal endpoint is validated to exist (resolved via prefix);
      // task->idea edges live in queue.db's task_proposal_blockers.
      const taskId = rest[1]
      const ideaArgs = rest.slice(2)
      if (!taskId || ideaArgs.length === 0) {
        console.error(
          'usage: mars proposal block-task <task-id> <idea-id> [<idea-id> ...]',
        )
        process.exit(1)
      }
      const { resolveProposalId } = await import('./core/proposals')
      const { addProposalBlockers } = await import('./core/queue')
      try {
        const resolvedIds: string[] = []
        for (const raw of ideaArgs) {
          const resolved = await resolveProposalId(raw)
          if (resolved.kind === 'ambiguous') {
            console.error(
              `ambiguous prefix '${raw}' matches ${resolved.count} proposals`,
            )
            process.exit(1)
          }
          if (resolved.kind === 'none') {
            console.error(`proposal ${raw} not found`)
            process.exit(1)
          }
          resolvedIds.push(resolved.id)
        }
        await addProposalBlockers(taskId, resolvedIds)
        console.log(`blocked ${taskId} by proposal(s): ${resolvedIds.join(', ')}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'unblock-task') {
      const taskId = rest[1]
      const ideaArgs = rest.slice(2)
      if (!taskId || ideaArgs.length === 0) {
        console.error(
          'usage: mars proposal unblock-task <task-id> <idea-id> [<idea-id> ...]',
        )
        process.exit(1)
      }
      const { resolveProposalId } = await import('./core/proposals')
      const { removeProposalBlocker } = await import('./core/queue')
      try {
        const removed: string[] = []
        for (const raw of ideaArgs) {
          const resolved = await resolveProposalId(raw)
          const idToRemove = resolved.kind === 'unique' ? resolved.id : raw
          const r = await removeProposalBlocker(taskId, idToRemove)
          if (r.removed) removed.push(idToRemove)
        }
        console.log(
          removed.length > 0
            ? `unblocked ${taskId} from proposal(s): ${removed.join(', ')}`
            : `no matching proposal edges removed for ${taskId}`,
        )
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'task-blockers') {
      const taskId = rest[1]
      if (!taskId) {
        console.error('usage: mars proposal task-blockers <task-id>')
        process.exit(1)
      }
      const { listProposalBlockers } = await import('./core/queue')
      try {
        const blockers = await listProposalBlockers(taskId)
        if (blockers.length === 0) {
          console.log(`no proposal blockers on ${taskId}`)
          return
        }
        for (const b of blockers) console.log(b)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'ship-summary') {
      const id = rest[1]
      const emitJson = rest.includes('--json')
      if (!id) {
        console.error('usage: mars proposal ship-summary <id> [--json]')
        process.exit(1)
      }
      const { resolveProposalId, getProposal } = await import('./core/proposals')
      const resolved = await resolveProposalId(id)
      if (resolved.kind === 'ambiguous') {
        console.error(
          `ambiguous prefix '${id}' matches ${resolved.count} proposals`,
        )
        process.exit(1)
      }
      const proposal =
        resolved.kind === 'unique' ? await getProposal(resolved.id) : null
      if (!proposal) {
        console.error(`proposal ${id} not found`)
        process.exit(1)
      }

      const { getDefaultTaskStore } = await import('./core/lib/task-store')
      const taskStore = await getDefaultTaskStore()
      const arc = await taskStore.arcStatus(proposal.id, { cwd: ctx.repoRoot })

      const { getTask } = await import('./core/queue')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      type TaskRow = {
        id: string
        shortTitle: string
        status: string
        sha: string | null
        commitSubject: string | null
      }

      const taskRows: TaskRow[] = await Promise.all(
        arc.tasks.map(async (t): Promise<TaskRow> => {
          const full = await getTask(t.id)
          const shortTitle = (full?.prompt ?? t.id).split('\n')[0].trim()

          let sha: string | null = null
          let commitSubject: string | null = null

          if (t.status === 'done') {
            try {
              const { stdout } = await execFileAsync(
                'git',
                [
                  'log',
                  'main',
                  `--grep=${t.id}`,
                  '--fixed-strings',
                  '--format=%H\t%s',
                  '-1',
                ],
                { cwd: ctx.repoRoot },
              )
              const line = stdout.trim()
              if (line) {
                const tab = line.indexOf('\t')
                sha = tab >= 0 ? line.slice(0, tab) : line
                commitSubject = tab >= 0 ? line.slice(tab + 1) : ''
              }
            } catch {
              // best-effort: no commit found for this task id
            }
          }

          return { id: t.id, shortTitle, status: t.status, sha, commitSubject }
        }),
      )

      if (emitJson) {
        console.log(
          JSON.stringify(
            {
              proposalId: proposal.id,
              title: proposal.title.split('\n')[0].trim(),
              arcState: arc.status,
              tasks: taskRows.map((r) => ({
                id: r.id,
                shortTitle: r.shortTitle,
                status: r.status,
                sha: r.sha,
                commitSubject: r.commitSubject,
              })),
              landedCommits: arc.landedCommits,
            },
            null,
            2,
          ),
        )
        return
      }

      console.log(`proposal: ${proposal.id}`)
      console.log(`title:    ${proposal.title.split('\n')[0].trim()}`)
      console.log(`arc:      ${arc.status}`)
      if (taskRows.length > 0) {
        console.log()
        for (const row of taskRows) {
          const display =
            row.status === 'dropped'
              ? 'dismissed'
              : row.status === 'done' && row.sha !== null
                ? `${row.sha.slice(0, 7)} ${row.commitSubject ?? ''}`
                : row.status
          console.log(`  ${row.id}  ${row.shortTitle}  ${display}`)
        }
      }
      return
    }
    console.error(
      'usage: mars proposal <add|new|list|show|set|add-user-story|remove-user-story|promote|slice|reject|delete|block|unblock|blockers|block-task|unblock-task|task-blockers|ship-summary> ...',
    )
    process.exit(1)
  }

  if (cmd === 'set-functional' || cmd === 'set-technical') {
    const id = rest[0]
    const value = rest.slice(1).join(' ')
    if (!id || !value) {
      console.error(`usage: mars ${cmd} <id> <text|@file>`)
      process.exit(1)
    }
    const { getTask } = await import('./core/queue')
    const task = await getTask(id)
    if (!task) {
      console.error(`task ${id} not found`)
      process.exit(1)
    }
    if (task.status !== 'queued' && task.status !== 'draft') {
      console.error(
        `task ${id} is ${task.status}; plan can only be modified while draft or queued`,
      )
      process.exit(1)
    }
    const text = readMaybeFile(value)
    const current = task.plan ?? { functional: '', technical: '' }
    const next =
      cmd === 'set-functional'
        ? { ...current, functional: text }
        : { ...current, technical: text }
    const { sendRequest } = await import('./core/daemon/client')
    await sendRequest({ op: 'update', id, patch: { plan: next } })
    console.log(`updated ${id}`)
    return
  }

  if (cmd === 'show') {
    const id = rest[0]
    if (!id) {
      console.error('usage: mars show <id>')
      process.exit(1)
    }
    const { formatAuthor } = await import('./core/author')
    const { getTask } = await import('./core/queue')
    const task = await getTask(id)
    if (task) {
      console.log(`kind:       task`)
      console.log(`id:         ${task.id}`)
      console.log(`Status:     ${task.status}`)
      console.log(`tags:       ${(task.tags ?? ['coder']).join(', ')}`)
      console.log(`author:     ${formatAuthor(task.author)}`)
      console.log(`branch:     ${task.branch ?? '-'}`)
      console.log(`worktree:   ${task.worktreePath ?? '-'}`)
      console.log(`createdAt:  ${task.createdAt}`)
      console.log(`updatedAt:  ${task.updatedAt}`)
      console.log(`prompt:`)
      console.log(task.prompt)
      console.log(`functional:`)
      console.log(task.plan?.functional ?? '(empty)')
      console.log(`technical:`)
      console.log(task.plan?.technical ?? '(empty)')
      if (task.spec) {
        if (task.spec.files.length > 0) {
          console.log(`files:`)
          for (const f of task.spec.files) console.log(`  - ${f}`)
        }
        const readFirst = task.spec.readFirst ?? []
        if (readFirst.length > 0) {
          console.log(`readFirst:`)
          readFirst.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
        }
        const prescriptiveAction = task.spec.prescriptiveAction ?? null
        if (prescriptiveAction) {
          console.log(`prescriptiveAction:`)
          console.log(prescriptiveAction)
        }
        if (task.spec.verifyCmd) {
          console.log(`verifyCmd: ${task.spec.verifyCmd}`)
        }
        if (task.spec.doneCriteria.length > 0) {
          console.log(`doneCriteria:`)
          for (const c of task.spec.doneCriteria) console.log(`  - [ ] ${c}`)
        }
      }
      if (task.error) {
        console.log(`error:`)
        console.log(task.error)
      }
      if (task.dropReason) {
        console.log(`dropReason: ${task.dropReason}`)
      }
      if (task.failureReason) {
        console.log(`failureReason: ${task.failureReason}`)
      }
      if (task.retryCount > 0) {
        console.log(`retryCount: ${task.retryCount}`)
      }
      if (task.fixForTaskId) {
        console.log(`fixForTask: ${task.fixForTaskId}`)
      }
      if (task.failureSignature) {
        console.log(`failureSig: ${task.failureSignature}`)
        const { causeForSignature } = await import(
          './core/lib/failure-signature'
        )
        const cause = causeForSignature(task.failureSignature, task.id)
        if (cause) {
          console.log(`cause:      ${cause}`)
        }
      }
      const { listBlockers, listSiblings } = await import('./core/queue')
      const blockerTaskIds = await listBlockers(task.id)
      if (blockerTaskIds.length > 0) {
        console.log(`blockedBy:  ${blockerTaskIds.join(', ')}`)
      }
      if (task.originId && task.originId !== task.id) {
        const { getProposal } = await import('./core/proposals')
        const originIdea = await getProposal(task.originId).catch(() => null)
        if (originIdea) {
          const firstLine = originIdea.title.split('\n')[0]?.trim() ?? ''
          const titleSuffix = firstLine.length > 0 ? ` ${firstLine}` : ''
          console.log(`origin:     proposal ${originIdea.id}${titleSuffix}`)
        } else {
          console.log(`origin:     task ${task.originId}`)
        }
        const siblings = await listSiblings(task.originId, task.id)
        if (siblings.length > 0) {
          console.log(`siblings:   ${siblings.join(', ')}`)
        }
      }
      return
    }
    const { getProposal, resolveProposalId } = await import(
      './core/proposals'
    )
    const ideaResolved = await resolveProposalId(id)
    if (ideaResolved.kind === 'ambiguous') {
      console.error(
        `ambiguous prefix '${id}' matches ${ideaResolved.count} proposals`,
      )
      process.exit(1)
    }
    const idea =
      ideaResolved.kind === 'unique'
        ? await getProposal(ideaResolved.id)
        : null
    if (idea) {
      console.log(`kind:       proposal`)
      console.log(`id:         ${idea.id}`)
      console.log(`status:     ${idea.status}`)
      console.log(`source:     ${idea.source}`)
      console.log(`author:     ${formatAuthor(idea.author)}`)
      console.log(`createdAt:  ${new Date(idea.createdAt).toISOString()}`)
      console.log(`updatedAt:  ${new Date(idea.updatedAt).toISOString()}`)
      console.log(`title:`)
      console.log(idea.title)
      if (idea.problem.trim().length > 0) {
        console.log(`problem:`)
        console.log(idea.problem)
      }
      if (idea.solution.trim().length > 0) {
        console.log(`solution:`)
        console.log(idea.solution)
      }
      if (idea.userStories.length > 0) {
        console.log(`user stories:`)
        idea.userStories.forEach((s, i) => console.log(`  [${i}] ${s}`))
      }
      if (idea.outOfScope.trim().length > 0) {
        console.log(`out of scope:`)
        console.log(idea.outOfScope)
      }
      if (idea.notes.trim().length > 0) {
        console.log(`notes:`)
        console.log(idea.notes)
      }
      const { listTasksForProposal } = await import('./core/queue')
      const ideaTasks = await listTasksForProposal(idea.id)
      if (ideaTasks.length > 0) {
        console.log(
          `tasks:      ${ideaTasks.map((t) => `${t.id} (${t.status})`).join(', ')}`,
        )
      }
      return
    }
    console.error(`no task or proposal matching ${id}`)
    process.exit(1)
  }

  if (cmd === 'retry') {
    console.error(
      `unknown command: retry. Use 'mars continue <id> [<id> ...]' to resume on the existing worktree, or 'mars restart <id> [<id> ...]' to wipe and re-run.`,
    )
    process.exit(1)
  }

  if (cmd === 'continue' || cmd === 'restart') {
    const ids = rest.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      console.error(`usage: mars ${cmd} <id> [<id> ...]`)
      process.exit(1)
    }
    const { sendRequest } = await import('./core/daemon/client')
    for (const id of ids) {
      let res: unknown
      try {
        res = await sendRequest({ op: cmd, id })
      } catch (err) {
        console.error(`${id}: ${(err as Error).message}`)
        process.exit(1)
      }
      let verb: string
      if (
        cmd === 'continue' &&
        res !== null &&
        typeof res === 'object' &&
        (res as { degradedToRestart?: boolean }).degradedToRestart === true
      ) {
        const fallbackNote = (res as { note?: string }).note
        verb = fallbackNote
          ? `queued ${id} for restart from setup — ${fallbackNote}`
          : `queued ${id} for restart from setup (failure was pre-setup; continue and restart are equivalent here)`
      } else {
        verb =
          cmd === 'continue'
            ? `queued ${id} to continue from the failed phase`
            : `queued ${id} for restart from setup`
      }
      console.log(verb)
    }
    return
  }

  if (cmd === 'purge') {
    const flags = new Set(rest.filter((a) => a.startsWith('--')))
    const ids = rest.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      console.error(`usage: mars purge <id> [<id> ...] [--force]`)
      process.exit(1)
    }
    const force = flags.has('--force')
    const { sendRequest } = await import('./core/daemon/client')
    for (const id of ids) {
      try {
        await sendRequest({ op: 'purge', id, force })
      } catch (err) {
        console.error(`${id}: ${(err as Error).message}`)
        process.exit(1)
      }
      console.log(`purged ${id}`)
    }
    return
  }

  if (cmd === 'unblock') {
    const id = rest[0]
    const blockerArgs = rest.slice(1)
    if (!id) {
      console.error(
        `usage: mars unblock <id>                       (phantom-recovery: clears all task_blockers, flips 'blocked' or 'queued' -> 'failed' so the row can then be 'mars purge'd)\n       mars unblock <id> <blocker-id> [<blocker-id> ...]  (edge-removal: removes specific edges, status unchanged)`,
      )
      process.exit(1)
    }
    const { sendRequest } = await import('./core/daemon/client')
    if (blockerArgs.length === 0) {
      const data = (await sendRequest({ op: 'unblock', id })) as {
        taskId: string
        outcome: 'unblocked' | 'noop'
        previousStatus: string
      }
      if (data.outcome === 'unblocked') {
        console.log(
          `unblocked ${data.taskId} (was ${data.previousStatus}; now failed). Use 'mars restart ${data.taskId}' to re-queue.`,
        )
      } else {
        console.log(
          `task ${data.taskId} is ${data.previousStatus}; nothing to unblock`,
        )
      }
      return
    }
    const data = (await sendRequest({
      op: 'remove-blockers',
      id,
      blockerIds: blockerArgs,
    })) as { taskId: string; removed: string[] }
    console.log(`unblocked ${data.taskId} from: ${data.removed.join(', ')}`)
    return
  }

  if (cmd === 'recover') {
    const id = rest[0]
    const { sendRequest } = await import('./core/daemon/client')
    const data = (await sendRequest({ op: 'recover', id })) as {
      outcomes: Array<{
        taskId: string
        outcome: 'queued' | 'noop' | 'failed' | 'not-blocked'
        retryCount: number
        failureReason?: string
      }>
    }
    if (id) {
      const o = data.outcomes[0]
      if (!o) {
        console.log('no result')
        return
      }
      if (o.outcome === 'queued') {
        console.log(`recovered ${o.taskId}: queued for dispatch`)
      } else if (o.outcome === 'failed') {
        console.log(`${o.taskId}: failed at unblock (${o.failureReason ?? 'unknown'})`)
      } else if (o.outcome === 'not-blocked') {
        console.log(`${o.taskId}: not blocked — nothing to recover`)
      } else {
        console.log(`${o.taskId}: still has unmet blockers`)
      }
    } else {
      const queued = data.outcomes.filter((o) => o.outcome === 'queued')
      const failed = data.outcomes.filter((o) => o.outcome === 'failed')
      const noop = data.outcomes.filter(
        (o) => o.outcome === 'noop' || o.outcome === 'not-blocked',
      )
      console.log(
        `recovered ${queued.length} task(s)${queued.length > 0 ? `: ${queued.map((o) => o.taskId).join(', ')}` : ''}`,
      )
      if (failed.length > 0) {
        console.log(
          `failed at unblock: ${failed.map((o) => `${o.taskId} (${o.failureReason ?? 'unknown'})`).join(', ')}`,
        )
      }
      if (noop.length > 0) {
        console.log(`still blocked: ${noop.map((o) => o.taskId).join(', ')}`)
      }
    }
    return
  }

  if (cmd === 'drop') {
    const flags = new Set(rest.filter((a) => a.startsWith('--')))
    const positionals = rest.filter((a) => !a.startsWith('--'))
    const id = positionals[0]
    if (!id) {
      console.error(
        `usage: mars drop <id> [--force]\n\n` +
          `Delete any task entirely (worktree+branch+row) regardless of\n` +
          `status. Clears every task_blockers row mentioning <id> on either\n` +
          `side, and nulls out any sibling row's fix_for_task_id that\n` +
          `pointed at <id> so the row can be deleted cleanly.\n\n` +
          `Refuses if the task is currently dispatched (running, verifying,\n` +
          `merging, or held by a live worker-pool slot) unless --force is\n` +
          `passed. --force does NOT kill the underlying claude subprocess;\n` +
          `the workflow will continue to its natural end, but the row, the\n` +
          `worktree, and the branch are removed immediately.`,
      )
      process.exit(1)
    }
    const force = flags.has('--force')
    const { sendRequest } = await import('./core/daemon/client')
    const data = (await sendRequest({ op: 'drop', id, force })) as {
      taskId: string
      previousStatus: string
      edgesRemoved: { incoming: number; outgoing: number }
      fixForRefsCleared: string[]
      worktreeRemoved: boolean
      branchDeleted: boolean
    }
    const parts = [
      `dropped ${data.taskId} (was ${data.previousStatus})`,
      `worktree=${data.worktreeRemoved ? 'removed' : 'absent'}`,
      `branch=${data.branchDeleted ? 'deleted' : 'absent'}`,
      `edges=${data.edgesRemoved.incoming}in/${data.edgesRemoved.outgoing}out`,
    ]
    if (data.fixForRefsCleared.length > 0) {
      parts.push(`fixForRefs cleared on: ${data.fixForRefsCleared.join(', ')}`)
    }
    console.log(parts.join('; '))
    return
  }

  if (cmd === 'block') {
    const id = rest[0]
    const blockerArgs = rest.slice(1)
    if (!id || blockerArgs.length === 0) {
      console.error(
        `usage: mars block <task-id> <blocker-id> [<blocker-id> ...]`,
      )
      process.exit(1)
    }
    if (blockerArgs.some((b) => b === id)) {
      console.error(`task ${id} cannot block itself`)
      process.exit(1)
    }
    const { sendRequest } = await import('./core/daemon/client')
    const data = (await sendRequest({
      op: 'block',
      id,
      blockerIds: blockerArgs,
    })) as { taskId: string; blockerIds: string[] }
    console.log(`blocked ${data.taskId} by: ${data.blockerIds.join(', ')}`)
    return
  }

  const { listTasks } = await import('./core/queue')

  if (cmd === 'list') {
    const tasks = await listTasks(rest[0] as never)
    for (const t of tasks) {
      const prio = t.priority > 0 ? `\tP${t.priority}` : ''
      console.log(`${t.id}\t${t.status}${prio}\t${t.prompt.slice(0, 60)}`)
    }
    return
  }

  if (cmd === 'watch') {
    console.error(
      'mars watch has been renamed to mars daemon — run `mars daemon --help` for usage.',
    )
    process.exit(2)
  }

  if (cmd === 'daemon') {
    // Normalize legacy flag-form aliases so '--detach' and '--stop'
    // dispatch to the canonical subcommand names. Note: '--status' cannot be
    // aliased here because it is in FLAGS_WITH_VALUES (used by
    // `proposal list --status <value>`) and is consumed by the top-level
    // parser before it reaches this point.
    const rawSub = rest[0]
    const sub =
      rawSub === '--detach'
        ? 'start'
        : rawSub === '--stop'
          ? 'stop'
          : rawSub
    const subFlags = new Set(rest.slice(1).filter((a) => a.startsWith('--')))

    if (sub === 'stop') {
      const force = subFlags.has('--force')
      const { sendRequest } = await import('./core/daemon/client')
      try {
        if (force) {
          await sendRequest({ op: 'shutdown', force: true }, { autoSpawn: false })
          console.log('daemon stopping (force; in-flight tasks abandoned)')
          return
        }
        const data = (await sendRequest(
          { op: 'shutdown', drain: true },
          { autoSpawn: false },
        )) as { inFlight: number; draining: boolean }
        if (data.inFlight === 0) {
          console.log('daemon stopping')
        } else {
          console.log(
            `daemon draining: stopped accepting new work; waiting on ${data.inFlight} in-flight task(s). Run \`mars daemon kill\` to abort.`,
          )
        }
      } catch (err) {
        const msg = (err as Error).message
        if (/not running|auto-spawn disabled/i.test(msg)) {
          console.error('daemon not running')
          process.exit(1)
        }
        throw err
      }
      return
    }

    if (sub === 'kill') {
      const { sendRequest } = await import('./core/daemon/client')
      try {
        const data = (await sendRequest({ op: 'kill' }, { autoSpawn: false })) as {
          killed: ReadonlyArray<{ taskId: string; kind: string }>
        }
        if (data.killed.length === 0) {
          console.log('daemon killed (no in-flight tasks)')
        } else {
          console.log(`daemon killed; aborted ${data.killed.length} in-flight task(s):`)
          for (const t of data.killed) console.log(`  ${t.kind} ${t.taskId}`)
        }
      } catch (err) {
        const msg = (err as Error).message
        // Connection reset is the expected outcome — the daemon kills its
        // process group immediately after responding, which the kernel may
        // tear down before the response flushes on slower hosts.
        if (/ECONNRESET|EPIPE|socket hang up/i.test(msg)) {
          console.log('daemon killed')
          return
        }
        if (/not running|auto-spawn disabled/i.test(msg)) {
          console.error('daemon not running')
          process.exit(1)
        }
        throw err
      }
      return
    }

    if (sub === 'reload') {
      const { sendRequest } = await import('./core/daemon/client')
      try {
        const data = (await sendRequest(
          { op: 'reload-config' },
          { autoSpawn: false },
        )) as {
          caps: {
            implement: number
            triage: number
            refine: number
            'structured-write': number
          }
        }
        console.log(
          `concurrency reloaded: implement=${data.caps.implement} triage=${data.caps.triage} refine=${data.caps.refine} structured-write=${data.caps['structured-write']}`,
        )
      } catch (err) {
        const msg = (err as Error).message
        if (/not running|auto-spawn disabled/i.test(msg)) {
          console.error(
            "daemon not running; use 'mars daemon start' to start it",
          )
          process.exit(1)
        }
        throw err
      }
      return
    }

    if (sub === 'set-flag') {
      const positional = rest.slice(1).filter((a) => !a.startsWith('--'))
      const flag = positional[0]
      const value = positional[1]
      if (!flag || !value) {
        console.error('usage: mars daemon set-flag <flag> <on|off>')
        process.exit(2)
      }
      if (value !== 'on' && value !== 'off') {
        console.error(`mars daemon set-flag: value must be 'on' or 'off'; got '${value}'`)
        process.exit(2)
      }
      const { sendRequest } = await import('./core/daemon/client')
      try {
        const data = (await sendRequest(
          { op: 'set-flag', flag, value },
          { autoSpawn: false },
        )) as { flag: string; value: string }
        console.log(`flag ${data.flag}=${data.value}`)
      } catch (err) {
        const msg = (err as Error).message
        if (/not running|auto-spawn disabled/i.test(msg)) {
          console.error(
            "daemon not running; use 'mars daemon start' to start it",
          )
          process.exit(1)
        }
        throw err
      }
      return
    }

    if (sub === 'status') {
      const { isDaemonAlive } = await import('./core/daemon/paths')
      const liveness = await isDaemonAlive()
      if (!liveness.alive) {
        console.error(`daemon not running (${liveness.reason})`)
        process.exit(1)
      }
      const { sendRequest } = await import('./core/daemon/client')
      const data = (await sendRequest({ op: 'status' }, { autoSpawn: false })) as {
        pid: number
        startedAt: string
        inFlight: ReadonlyArray<{ taskId: string; kind: string }>
        counts: Record<string, number>
      }
      console.log(`pid:        ${data.pid}`)
      console.log(`startedAt:  ${data.startedAt}`)
      console.log(
        `counts:     draft=${data.counts.draft} queued=${data.counts.queued} running=${data.counts.running} verifying=${data.counts.verifying} merging=${data.counts.merging} vega-reconciling=${data.counts['vega-reconciling']}`,
      )
      console.log(`inFlight:   ${data.inFlight.length}`)
      for (const f of data.inFlight) console.log(`  ${f.kind} ${f.taskId}`)
      return
    }

    if (sub === 'start') {
      const foreground = subFlags.has('--foreground')
      if (foreground) {
        // Foreground mode: used internally by the detach path when it spawns
        // a child process to actually run the daemon. Not documented publicly.
        const { startDaemon } = await import('./core/daemon/server')
        await startDaemon({ log: (line) => console.log(line) })
        // Block until SIGINT/SIGTERM (the daemon handles shutdown).
        await new Promise(() => {})
        return
      }

      // Detach mode (default). Fork the daemon to the background.
      const { spawn } = await import('node:child_process')
      const { daemonPaths, resolveLaunchCommand, isDaemonAlive } =
        await import('./core/daemon/paths')
      const liveness = await isDaemonAlive()
      if (liveness.alive) {
        const { logFile } = daemonPaths()
        console.log(`[mars] daemon detached (pid ${liveness.pid}, log: ${logFile})`)
        return
      }
      // Not alive (stale files already removed by isDaemonAlive); spawn fresh.
      const { command, baseArgs } = resolveLaunchCommand()
      const child = spawn(
        command,
        [...baseArgs, '--repo', ctx.repoRoot, 'daemon', 'start', '--foreground'],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, MARS_REPO: ctx.repoRoot },
        },
      )
      child.unref()
      const { logFile } = daemonPaths()
      console.log(`[mars] daemon detached (pid ${child.pid}, log: ${logFile})`)
      return
    }

    if (sub === 'restart') {
      const { daemonPaths, isDaemonAlive, resolveLaunchCommand } =
        await import('./core/daemon/paths')
      const { spawn } = await import('node:child_process')

      // Step 1: force-stop any running daemon.
      const liveness = await isDaemonAlive()
      if (liveness.alive) {
        const { sendRequest } = await import('./core/daemon/client')
        try {
          await sendRequest({ op: 'shutdown', force: true }, { autoSpawn: false })
        } catch (err) {
          const msg = (err as Error).message
          if (!/not running|auto-spawn disabled/i.test(msg)) throw err
        }
        // Wait for the daemon to exit (up to 5 s).
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
          const check = await isDaemonAlive()
          if (!check.alive) break
        }
      }

      // Step 2: start a fresh daemon in the background.
      const { command, baseArgs } = resolveLaunchCommand()
      const child = spawn(
        command,
        [...baseArgs, '--repo', ctx.repoRoot, 'daemon', 'start', '--foreground'],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, MARS_REPO: ctx.repoRoot },
        },
      )
      child.unref()
      const { logFile } = daemonPaths()
      console.log(`[mars] daemon detached (pid ${child.pid}, log: ${logFile})`)
      return
    }

    console.error('usage: mars daemon <start|stop|restart|kill|status|reload|set-flag> [flags]')
    process.exit(2)
  }

  if (cmd === 'kpi') {
    const sub = rest[0]
    if (sub === 'snapshot') {
      const { takeKpiSnapshot } = await import('./core/lib/kpi-snapshots.js')
      const { getDefaultTaskStore } = await import('./core/lib/task-store.js')
      const surface = await getDefaultTaskStore()
      const snapshot = await takeKpiSnapshot({
        surface,
        now: new Date().toISOString(),
      })
      console.log(JSON.stringify(snapshot, null, 2))
      return
    }
    if (sub === 'show') {
      const { readKpiWindowComparison } = await import('./core/lib/kpi-snapshots.js')
      const result = await readKpiWindowComparison({ now: new Date().toISOString() })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.error('usage: mars kpi <snapshot|show>')
    process.exit(1)
  }

  if (cmd === 'sweep') {
    if (!process.stdin.isTTY) {
      console.error(
        'mars sweep: stdin is not a terminal; an interactive TTY is required to prompt for each orphan branch',
      )
      process.exit(1)
    }

    const integrationBranch =
      process.env.INTEGRATION_BRANCH ?? 'main'

    const {
      runSweepVerb,
      listLocalTaskBranches,
      listUniqueCommitsAhead,
      applyCommitsCherryPick,
    } = await import('./core/lib/sweep')
    const { getTask } = await import('./core/queue')
    const { execFile: cpExecFile } = await import('node:child_process')
    const { promisify: cpPromisify } = await import('node:util')
    const cpExec = cpPromisify(cpExecFile)

    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    const askAction = (branch: string): Promise<'keep' | 'delete' | 'cherry-pick'> =>
      new Promise((resolve) => {
        const onClose = (): void => resolve('keep')
        rl.once('close', onClose)
        rl.question(
          `  Action for ${branch} — [k]eep  [d]elete  [c]herry-pick-then-delete > `,
          (answer) => {
            rl.removeListener('close', onClose)
            const a = answer.trim().toLowerCase()
            if (a === 'd' || a === 'delete') return resolve('delete')
            if (a === 'c' || a === 'cherry-pick' || a === 'cherry-pick-then-delete') {
              return resolve('cherry-pick')
            }
            resolve('keep')
          },
        )
      })

    await runSweepVerb({
      integrationBranch,
      log: (line) => console.log(line),
      deps: {
        listTaskBranches: () => listLocalTaskBranches(ctx.repoRoot),
        getTask: (id) => getTask(id),
        listUniqueCommits: (branch, integration) =>
          listUniqueCommitsAhead(branch, integration, ctx.repoRoot),
        prompt: (orphan) => askAction(orphan.branch),
        deleteBranch: async (branch) => {
          await cpExec('git', ['branch', '-D', branch], { cwd: ctx.repoRoot })
        },
        cherryPickCommits: (commits) =>
          applyCommitsCherryPick(commits, integrationBranch, ctx.repoRoot),
      },
    })

    rl.close()
    return
  }

  if (cmd === 'worktree') {
    const sub = rest[0]
    if (sub !== 'clean' && sub !== 'prune') {
      console.error('usage: mars worktree clean [--dry-run] [--force-orphans]')
      console.error('       mars worktree prune [--dry-run]')
      process.exit(1)
    }
    const wtFlags = new Set(rest.slice(1).filter((a) => a.startsWith('--')))
    const dryRun = wtFlags.has('--dry-run')

    if (sub === 'prune') {
      const { runWorktreePrune } = await import('./core/lib/worktree-prune')
      const summary = await runWorktreePrune({
        dryRun,
        log: (line) => console.log(line),
      })
      if (
        summary.errors > 0 &&
        summary.removed === 0 &&
        summary.keptInFlight === 0 &&
        summary.keptFailed === 0 &&
        summary.keptOther === 0
      ) {
        process.exit(1)
      }
      return
    }

    const forceOrphans = wtFlags.has('--force-orphans')
    const { runWorktreeClean } = await import('./core/lib/worktree-clean')

    const summary = await runWorktreeClean({
      dryRun,
      forceOrphans,
      log: (line) => console.log(line),
    })
    if (
      summary.errors > 0 &&
      summary.removed === 0 &&
      summary.keptInFlight === 0 &&
      summary.keptDesync === 0 &&
      summary.keptOrphan === 0 &&
      summary.keptOther === 0
    ) {
      process.exit(1)
    }
    return
  }

  if (cmd === 'glossary') {
    const sub = rest[0]
    const { resolve: resolvePath } = await import('node:path')
    const contextPath = resolvePath(ctx.repoRoot, 'CONTEXT.md')

    if (sub === 'set') {
      const term = rest[1]
      const definition = rest[2]
      if (!term || !definition) {
        console.error(
          'usage: mars glossary set "<term>" "<definition>" [--avoid alias1,alias2]',
        )
        process.exit(1)
      }
      const aliasFlag = flags['--avoid']
      const aliases = aliasFlag
        ? aliasFlag
            .split(',')
            .map((a) => a.trim())
            .filter((a) => a.length > 0)
        : []
      const { sendRequest } = await import('./core/daemon/client')
      await sendRequest(
        {
          op: 'glossary-write',
          kind: 'set',
          term,
          definition,
          aliases,
        },
        {
          onSpawnNotice: (pid, logFile) => {
            console.error(`spawned mars daemon (pid ${pid}, log ${logFile})`)
          },
        },
      )
      console.log(`glossary set dispatched: "${term}"`)
      return
    }

    if (sub === 'remove') {
      const term = rest[1]
      if (!term) {
        console.error('usage: mars glossary remove "<term>"')
        process.exit(1)
      }
      const { sendRequest } = await import('./core/daemon/client')
      await sendRequest(
        { op: 'glossary-write', kind: 'remove', term },
        {
          onSpawnNotice: (pid, logFile) => {
            console.error(`spawned mars daemon (pid ${pid}, log ${logFile})`)
          },
        },
      )
      console.log(`glossary remove dispatched: "${term}"`)
      return
    }

    if (sub === 'list') {
      const { readGlossaryFile } = await import('./core/lib/glossary')
      const doc = await readGlossaryFile(contextPath)
      if (doc.terms.length === 0) {
        console.log('(no glossary terms; CONTEXT.md is empty or missing)')
        return
      }
      for (const t of doc.terms) {
        const aliases = t.aliases.length > 0 ? `  (avoid: ${t.aliases.join(', ')})` : ''
        console.log(`${t.term}${aliases}`)
      }
      return
    }

    if (sub === 'show') {
      const term = rest[1]
      if (!term) {
        console.error('usage: mars glossary show "<term>"')
        process.exit(1)
      }
      const { readGlossaryFile } = await import('./core/lib/glossary')
      const doc = await readGlossaryFile(contextPath)
      const lower = term.toLowerCase()
      const found = doc.terms.find((t) => t.term.toLowerCase() === lower)
      if (!found) {
        console.error(`term "${term}" not found in CONTEXT.md`)
        process.exit(1)
      }
      console.log(`term:        ${found.term}`)
      console.log(`definition:  ${found.definition}`)
      if (found.aliases.length > 0) {
        console.log(`avoid:       ${found.aliases.join(', ')}`)
      }
      return
    }

    console.error('usage: mars glossary <set|remove|list|show> ...')
    process.exit(1)
  }

  if (cmd === 'adr') {
    const sub = rest[0]
    const { resolve: resolvePath } = await import('node:path')
    const adrDir = resolvePath(ctx.repoRoot, 'docs/adr')

    if (sub === 'add') {
      const title = rest[1]
      const bodyArg = rest.slice(2).join(' ')
      if (!title || !bodyArg) {
        console.error(
          'usage: mars adr add "<title>" "<body>" (body may be @path to read a file)',
        )
        process.exit(1)
      }
      const body = readMaybeFile(bodyArg)
      const { sendRequest } = await import('./core/daemon/client')
      await sendRequest(
        { op: 'adr-add', title, body },
        {
          onSpawnNotice: (pid, logFile) => {
            console.error(`spawned mars daemon (pid ${pid}, log ${logFile})`)
          },
        },
      )
      console.log(`adr add dispatched: "${title}"`)
      return
    }

    if (sub === 'list') {
      const { readdir, readFile } = await import('node:fs/promises')
      let entries: string[]
      try {
        entries = await readdir(adrDir)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.log('(no ADRs; docs/adr/ does not exist yet)')
          return
        }
        throw err
      }
      const adrs = entries
        .filter((n) => /^\d{4}-[a-z0-9-]+\.md$/.test(n))
        .sort()
      if (adrs.length === 0) {
        console.log('(no ADRs in docs/adr/)')
        return
      }
      for (const name of adrs) {
        const text = await readFile(resolvePath(adrDir, name), 'utf8')
        const firstLine = text.split('\n', 1)[0] ?? ''
        const title = firstLine.replace(/^#\s*/, '').trim()
        console.log(`${name}\t${title}`)
      }
      return
    }

    if (sub === 'show') {
      const arg = rest[1]
      if (!arg) {
        console.error('usage: mars adr show <NNNN|filename>')
        process.exit(1)
      }
      const { readdir, readFile } = await import('node:fs/promises')
      let entries: string[]
      try {
        entries = await readdir(adrDir)
      } catch {
        console.error(`no ADR matching "${arg}" (docs/adr/ does not exist)`)
        process.exit(1)
      }
      const padded = /^\d+$/.test(arg) ? arg.padStart(4, '0') : null
      const match = entries.find((name) => {
        if (name === arg) return true
        if (padded && name.startsWith(`${padded}-`)) return true
        return false
      })
      if (!match) {
        console.error(`no ADR matching "${arg}" in docs/adr/`)
        process.exit(1)
      }
      const text = await readFile(resolvePath(adrDir, match), 'utf8')
      process.stdout.write(text)
      return
    }

    console.error('usage: mars adr <add|list|show> ...')
    process.exit(1)
  }

  if (cmd === 'project') {
    const sub = rest[0]

    if (sub === 'add') {
      const pathArg = rest[1] ?? flags['--path']
      if (!pathArg) {
        console.error('usage: mars project add <path> [--name <label>]')
        process.exit(1)
      }
      const { projectAdd } = await import('./cli/project.js')
      await projectAdd({ path: pathArg, name: flags['--name'] })
      return
    }

    if (sub === 'list') {
      const { projectList } = await import('./cli/project.js')
      projectList()
      return
    }

    if (sub === 'remove') {
      const projectId = rest[1]
      if (!projectId) {
        console.error('usage: mars project remove <projectId>')
        process.exit(1)
      }
      const { projectRemove } = await import('./cli/project.js')
      projectRemove(projectId)
      return
    }

    console.error('usage: mars project <add|list|remove> ...')
    process.exit(1)
  }

  if (cmd === 'reflect') {
    if (process.env.MARS_REFLECT_DISABLED === '1') {
      console.log('reflection disabled via MARS_REFLECT_DISABLED=1')
      return
    }
    const limit = flags['--limit'] ? Number(flags['--limit']) : 10
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error('--limit must be a positive integer')
      process.exit(1)
    }
    const sinceIso = flags['--since']
    const { loadRecentTaskCorpus } = await import('./core/lib/reflect-query')
    const { runReflector, persistSuggestions } = await import('./core/lib/reflector')
    const corpus = await loadRecentTaskCorpus({ sinceIso, limit })
    if (corpus.entries.length === 0) {
      console.log('no completed tasks in window — nothing to reflect on')
      return
    }
    const cs = corpus.costSummary
    console.log(
      `reflecting over ${corpus.entries.length} task(s) — ${cs.totalWeightedTokens.toFixed(0)} weighted tokens (${cs.successCount} done / ${cs.failureCount} failed)…`,
    )
    const result = await runReflector(corpus)
    if (result.tokenAnalysis) {
      const ta = result.tokenAnalysis
      console.log('\nToken analysis')
      if (ta.headline) console.log(`  ${ta.headline}`)
      if (ta.cacheHealth) {
        console.log(
          `  cache: ratio=${ta.cacheHealth.ratio.toFixed(2)} (${ta.cacheHealth.verdict}) — ${ta.cacheHealth.evidence}`,
        )
      }
      if (ta.successVsFailureTokens) {
        const s = ta.successVsFailureTokens
        console.log(
          `  success vs failure tokens: ${s.successTokens} vs ${s.failureTokens} weighted tokens — ${s.verdict}`,
        )
      }
      for (const t of ta.tokenHeavyTasks) {
        console.log(
          `  token-heavy task ${t.taskId}: ${t.weightedTokens} weighted tokens (${t.multipleOfMedian.toFixed(1)}× median) — ${t.rootCause}`,
        )
      }
      for (const s of ta.tokenHeavySteps) {
        console.log(
          `  token-heavy step ${s.stepId}: ${s.totalWeightedTokens} weighted tokens (${s.verdict}) — ${s.evidence}`,
        )
      }
      if (ta.notes) console.log(`  notes: ${ta.notes}`)
    }
    if (result.suggestions.length === 0) {
      console.log('\nno suggestions produced')
      if (result.exitCode !== 0) {
        console.error(`reflector exit code ${result.exitCode}`)
        process.exit(1)
      }
      return
    }
    const { insertReflectionTask } = await import('./core/queue')
    const sourceTaskId = await insertReflectionTask(corpus.entries.length)
    await persistSuggestions(result.suggestions, sourceTaskId)
    console.log('\nSuggestions')
    for (const s of result.suggestions) {
      console.log(`- ${s.title}`)
      if (s.rationale) console.log(`    ${s.rationale}`)
    }
    console.log(
      `\n${result.suggestions.length} suggestion(s) saved as draft proposals (source='reflection'). Review with 'mars proposal list --source reflection' and promote with 'mars proposal promote <id>'.`,
    )
    return
  }

  if (cmd === 'arc') {
    const sub = rest[0]

    if (sub === 'reflect') {
      if (process.env.MARS_REFLECT_DISABLED === '1') {
        console.log('reflection disabled via MARS_REFLECT_DISABLED=1')
        return
      }

      // positional originId: first element of rest after 'reflect' that isn't a flag
      const inputId = rest.slice(1).find((r) => !r.startsWith('--')) ?? null

      // Determine arc origin: from positional arg or interactive picker
      let chosenOriginInput: string
      if (inputId) {
        chosenOriginInput = inputId
      } else {
        // Interactive picker: print the arc list then prompt for selection
        const { listDeepReflectArcCandidates } = await import('./core/lib/deep-reflect-query')
        const candidates = await listDeepReflectArcCandidates({ limit: 10, withTranscriptOnly: false })

        console.log('originId\ttasks\tdone\tfailed\ttokens\tlastActivity')
        for (const arc of candidates) {
          const done = arc.statusMix.done ?? 0
          const failed = arc.statusMix.failed ?? 0
          const tokens = arc.totalTokens.toLocaleString('en-US')
          console.log(
            `${arc.originId}\t${arc.taskCount}\t${done}\t${failed}\t${tokens}\t${arc.lastActivity}`,
          )
        }

        const { createInterface } = await import('node:readline')
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const answer = await new Promise<string>((resolve) => {
          let answered = false
          rl.question('Enter originId: ', (a) => {
            answered = true
            rl.close()
            resolve(a.trim())
          })
          rl.once('close', () => {
            if (!answered) resolve('')
          })
        })

        if (!answer) {
          console.error('no arc selected; re-run with: mars arc reflect <originId>')
          process.exit(1)
        }
        chosenOriginInput = answer
      }

      const {
        loadDeepReflectArc,
        resolveOriginIdForTaskOrSelf,
      } = await import('./core/lib/deep-reflect-query')
      const { runDeepReflectorArc } = await import('./core/lib/deep-reflector')
      const { applyVerdicts } = await import('./core/lib/reflector')
      const { insertReflectionTask } = await import('./core/queue')

      const originId = await resolveOriginIdForTaskOrSelf(chosenOriginInput)
      const arc = await loadDeepReflectArc(originId)
      if (!arc) {
        console.error(`no arc found for ${originId}`)
        process.exit(1)
      }

      const statusMixStr = Object.entries(arc.statusMix)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      console.log(
        `arc ${originId}: ${arc.taskCount} task(s) [${statusMixStr}], ${arc.totals.eventCount} event(s), ${arc.totals.totalWeightedTokens.toFixed(0)} weighted tokens total`,
      )
      for (const t of arc.tasks) {
        const weightedTokens = Math.round(
          t.totals.inputTokens +
            t.totals.outputTokens +
            t.totals.cacheCreateTokens +
            t.totals.cacheReadTokens * 0.1,
        )
        console.log(`  task ${t.taskId} [${t.status}]: weighted-tokens=${weightedTokens}`)
        for (const note of t.transcriptNotes) {
          console.log(`  note (${t.taskId}): ${note}`)
        }
      }

      const result = await runDeepReflectorArc(arc)
      const report = result.report

      const sourceTaskId = await insertReflectionTask(1)
      const verdictResult = await applyVerdicts(report.suggestions, sourceTaskId)

      const { mkdir, writeFile } = await import('node:fs/promises')
      const { resolve: resolvePath } = await import('node:path')
      const { getStateDir } = await import('./core/context')
      const outDir = resolvePath(getStateDir(), 'deep-reflections')
      await mkdir(outDir, { recursive: true })
      const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outPath = resolvePath(outDir, `arc-${originId}-${isoStamp}.json`)
      const fullDoc = {
        originId,
        recordedAt: new Date().toISOString(),
        report,
        sourceTaskId,
        verdictResult: {
          saved: verdictResult.saved,
          absorbed: verdictResult.absorbed,
          dropped: verdictResult.dropped,
        },
        rawOutput: result.rawOutput,
      }
      await writeFile(outPath, JSON.stringify(fullDoc, null, 2), 'utf8')

      console.log('')
      if (report.summary) console.log(`Summary: ${report.summary}`)
      console.log(
        `Tool calls: ${report.toolCallStats.total} total — ${
          Object.entries(report.toolCallStats.byName)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ') || 'none'
        }`,
      )
      const mismatchCount =
        (report.verifyMismatches?.length ?? 0) > 0
          ? report.verifyMismatches!.length
          : report.verifyMismatch
            ? 1
            : 0
      console.log(
        `Dissonant calls: ${report.dissonantCalls.length}${
          mismatchCount > 0 ? ` | verify mismatches: ${mismatchCount}` : ''
        }`,
      )
      if (report.dissonantCalls.length > 0) {
        console.log('Top dissonant calls:')
        for (const d of report.dissonantCalls.slice(0, 3)) {
          const taskRef = d.taskId ? ` [${d.taskId}]` : ''
          console.log(
            `  [${d.severity}] event ${d.eventIndex}${taskRef} ${d.tool}: ${d.statedIntent} → ${d.actualOutcome}`,
          )
        }
      }
      if (report.rootCause) console.log(`Root cause: ${report.rootCause}`)
      console.log(
        `Suggestions: ${verdictResult.saved} saved, ${verdictResult.absorbed} absorbed, ${verdictResult.dropped} dropped`,
      )
      console.log(`Full report: ${outPath}`)
      if (result.exitCode !== 0) {
        console.error(`deep-reflector exit code ${result.exitCode}`)
      }
      return
    }

    if (sub !== 'list') {
      console.error('usage: mars arc <list|reflect> ...')
      process.exit(1)
    }
    const { listDeepReflectArcCandidates } = await import(
      './core/lib/deep-reflect-query'
    )
    const emitJson = rest.includes('--json')
    const withTranscriptOnly = rest.includes('--with-transcript-only')

    let limit = 10
    const limitRaw = flags['--limit']
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw)
      if (!Number.isInteger(parsed) || Number.isNaN(parsed)) {
        console.error(`--limit must be an integer; got '${limitRaw}'`)
        process.exit(1)
      }
      limit = Math.min(100, Math.max(1, parsed))
    }

    const candidates = await listDeepReflectArcCandidates({
      limit,
      withTranscriptOnly,
    })

    if (emitJson) {
      console.log(JSON.stringify(candidates, null, 2))
      return
    }

    // Text output: header + rows
    console.log('originId\ttasks\tdone\tfailed\ttokens\tlastActivity')
    for (const arc of candidates) {
      const done = arc.statusMix.done ?? 0
      const failed = arc.statusMix.failed ?? 0
      const tokens = arc.totalTokens.toLocaleString('en-US')
      console.log(
        `${arc.originId}\t${arc.taskCount}\t${done}\t${failed}\t${tokens}\t${arc.lastActivity}`,
      )
    }
    return
  }

  if (cmd === 'action-queue') {
    const lean = rest.includes('--lean')
    const subRest = lean ? rest.filter((a) => a !== '--lean') : rest
    const sub = subRest[0]
    const actionQueue = await import('./core/lib/action-queue')
    const dismissals = await import('./core/lib/action-queue-dismissals')
    type ActionQueueItem = import('./core/lib/action-queue').ActionQueueItem
    type ActionQueueRow = import('./core/daemon/view/action-queue').ActionQueueRow

    const LEAN_PREVIEW = 3

    // Map a persisted ActionQueueKind to the dismissal entity kind.
    const actionQueueKindToEntityKind = (
      kind: string,
    ): 'task' | 'worktree' | 'proposal' => {
      if (kind === 'stale-worktree') return 'worktree'
      if (kind === 'draft-proposal') return 'proposal'
      return 'task'
    }

    // Extract the identifying entity id from a persisted action queue row.
    const extractEntityId = (item: ActionQueueItem): string => {
      if (item.kind === 'stale-worktree') {
        if (typeof item.context.taskId === 'string') return item.context.taskId
      }
      if (item.kind === 'draft-proposal') {
        if (typeof item.payload.proposalId === 'string')
          return item.payload.proposalId
      }
      if (typeof item.payload.taskId === 'string') return item.payload.taskId
      if (typeof item.payload.originTaskId === 'string')
        return item.payload.originTaskId
      return item.signature ?? item.id
    }

    const printList = (rows: ActionQueueRow[]): void => {
      if (rows.length === 0) {
        console.log('action queue empty')
        return
      }
      for (const row of rows) {
        const flag = row.dismissed ? 'dismissed' : 'open'
        console.log(
          `${row.id}\t${flag}\t${row.priority}\t${row.kind}\t${row.title}`,
        )
      }
    }

    const printLean = (rows: ActionQueueRow[]): void => {
      if (rows.length === 0) {
        console.log('action queue empty')
        return
      }
      const counts: Record<string, number> = {}
      for (const row of rows) {
        counts[row.kind] = (counts[row.kind] ?? 0) + 1
      }
      const parts = Object.entries(counts).map(([k, n]) => `${k}:${n}`)
      console.log(`action queue ${rows.length} (${parts.join(', ')})`)
      for (const row of rows.slice(0, LEAN_PREVIEW)) {
        console.log(`  ${row.id}  ${row.title}`)
      }
      const overflow = rows.length - LEAN_PREVIEW
      if (overflow > 0) console.log(`  ... +${overflow} more`)
    }

    const printShow = (item: ActionQueueItem, dismissed: boolean): void => {
      const entityId = extractEntityId(item)
      const priority = item.priority === 'urgent' ? 'high' : item.priority
      console.log(`id:        ${item.id}`)
      console.log(`kind:      ${item.kind}`)
      console.log(`entity:    ${entityId}`)
      console.log(`priority:  ${priority}`)
      console.log(`dismissed: ${dismissed}`)
      console.log(`at:        ${item.lastSeenAt ?? item.raisedAt}`)
      console.log('')
      console.log(item.body)
    }

    if (sub === 'watch') {
      const { runActionQueueWatch } = await import('./cli/action-queue-watch')
      runActionQueueWatch()
      return
    }

    if (sub === 'raise') {
      const from = flags['--from']
      if (!from) {
        console.error('usage: mars action-queue raise --from <-|path>')
        process.exit(2)
      }
      let raw: string
      try {
        if (from === '-') {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
          }
          raw = Buffer.concat(chunks).toString('utf8')
        } else {
          raw = readFileSync(from, 'utf8')
        }
      } catch (err) {
        console.error(`failed to read input: ${(err as Error).message}`)
        process.exit(2)
      }
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch (err) {
        console.error(`invalid JSON: ${(err as Error).message}`)
        process.exit(2)
      }
      const { actionQueueRaiseSchema } = await import('./cli/action-queue-raise-schema')
      const parseResult = actionQueueRaiseSchema.safeParse(json)
      if (!parseResult.success) {
        console.error('action-queue raise: schema validation failed')
        for (const issue of parseResult.error.issues) {
          const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
          console.error(`  ${path}: ${issue.message}`)
        }
        process.exit(2)
      }
      const data = parseResult.data
      const payload = {
        ...data,
        raisedBy: data.raisedBy === '' ? 'agent:cli' : data.raisedBy,
      }
      try {
        const id = await actionQueue.raiseActionQueueItem(payload)
        console.log(id)
      } catch (err) {
        console.error(`action-queue raise: ${(err as Error).message}`)
        process.exit(1)
      }
      return
    }

    if (sub === undefined || sub === 'list') {
      const filterRaw = sub === 'list' ? subRest[1] : 'open'
      const filter = filterRaw ?? 'open'
      const allowed = new Set(['open', 'dismissed', 'all'])
      if (!allowed.has(filter)) {
        console.error('usage: mars action-queue list [open|dismissed|all] [--lean]')
        process.exit(1)
      }
      const viewFilter = filter as import('./core/daemon/view/action-queue').DerivedActionQueueFilter
      const { buildActionQueueView } = await import('./core/daemon/view/action-queue')
      const { listTasks: qListTasks, initQueue, getClient: getQueueClient } = await import('./core/queue')
      const { listErrorKinds: listErrKinds } = await import('./core/lib/error-kinds')
      const { getRepoRoot } = await import('./core/context')

      await initQueue()

      const stateStore = {
        listOpenActionQueueItems: async () => {
          const items = await actionQueue.listActionQueueItems('open')
          return items.map((item) => ({
            id: item.id,
            kind: item.kind as string,
            priority: item.priority as string,
            title: item.title,
            body: item.body,
            payload: item.payload,
            context: item.context,
            raisedAt: item.raisedAt,
            lastSeenAt: item.lastSeenAt,
          }))
        },
        listActionQueueDismissals: async () => {
          const dismissalList = await dismissals.listDismissals()
          const map = new Map<string, string | null>()
          for (const d of dismissalList) {
            map.set(`${d.entityKind}:${d.entityId}`, d.note)
          }
          return map
        },
      }

      const taskStore = {
        listTasks: async () => {
          const tasks = await qListTasks()
          const c = getQueueClient()
          const blockedByMap = new Map<string, string[]>()
          const proposalMap = new Map<string, string | null>()
          try {
            const blockersResult = await c.execute(
              `SELECT task_id, blocker_task_id FROM task_blockers`,
            )
            for (const row of blockersResult.rows) {
              const r = row as unknown as { task_id: string; blocker_task_id: string }
              const arr = blockedByMap.get(r.task_id) ?? []
              arr.push(r.blocker_task_id)
              blockedByMap.set(r.task_id, arr)
            }
          } catch {
            // task_blockers may not exist on a fresh repo — empty map
          }
          try {
            const proposalResult = await c.execute(
              `SELECT id, parent_proposal_id FROM tasks WHERE parent_proposal_id IS NOT NULL`,
            )
            for (const row of proposalResult.rows) {
              const r = row as unknown as { id: string; parent_proposal_id: string | null }
              proposalMap.set(r.id, r.parent_proposal_id)
            }
          } catch {
            // Tolerate missing column on legacy repos
          }
          return tasks.map((t) => ({
            id: t.id,
            status: t.status,
            prompt: t.prompt,
            blockedBy: blockedByMap.get(t.id) ?? [],
            parentProposalId: proposalMap.get(t.id) ?? null,
            failureSignature: t.failureSignature,
            branch: t.branch,
            updatedAt: t.updatedAt,
          }))
        },
      }

      const errorKinds = listErrKinds()
      const errorKindRegistry = new Map(errorKinds.map((ek) => [ek.kind, ek]))

      const rows = await buildActionQueueView({
        stateStore,
        taskStore,
        errorKindRegistry,
        repoRoot: getRepoRoot(),
        filter: viewFilter,
      })
      if (lean) {
        printLean(rows)
      } else {
        printList(rows)
      }
      return
    }

    if (sub === 'show') {
      const id = subRest[1]
      if (!id) {
        console.error('usage: mars action-queue show <id>')
        process.exit(1)
      }
      const item = await actionQueue.getActionQueueItem(id)
      if (!item) {
        console.error(`no action queue item matching ${id}`)
        process.exit(1)
      }
      const showEntityKind = actionQueueKindToEntityKind(item.kind)
      const showEntityId = extractEntityId(item)
      const showDismissed = await dismissals.isEntityDismissed(showEntityKind, showEntityId)
      printShow(item, showDismissed)
      return
    }

    if (sub === 'ack' || sub === 'resolve') {
      const id = subRest[1]
      if (!id) {
        console.error(`usage: mars action-queue ${sub} <id>`)
        process.exit(1)
      }
      const item = await actionQueue.getActionQueueItem(id)
      if (!item) {
        console.error(`no action queue item matching ${id}`)
        process.exit(1)
      }
      const entityKind = actionQueueKindToEntityKind(item.kind)
      const entityId = extractEntityId(item)
      const note = sub === 'ack' ? 'ack' : 'resolved'
      await dismissals.dismissEntity(entityKind, entityId, { note })
      console.log(`${sub} ${item.id}`)
      return
    }

    if (sub === 'dismiss' || sub === 'undismiss') {
      const id = subRest[1]
      if (!id) {
        console.error(`usage: mars action-queue ${sub} <id>`)
        process.exit(1)
      }
      const item = await actionQueue.getActionQueueItem(id)
      if (!item) {
        console.error(`no action queue item matching ${id}`)
        process.exit(1)
      }
      const entityKind = actionQueueKindToEntityKind(item.kind)
      const entityId = extractEntityId(item)
      if (sub === 'dismiss') {
        const { resolveAuthor, formatAuthor } = await import('./core/author')
        const by = formatAuthor(resolveAuthor(flags['--author']))
        const note = flags['--note']
        await dismissals.dismissEntity(entityKind, entityId, {
          by,
          ...(note !== undefined ? { note } : {}),
        })
        console.log(`dismiss ${item.id}`)
      } else {
        const removed = await dismissals.undismissEntity(entityKind, entityId)
        console.log(
          removed
            ? `undismiss ${item.id}`
            : `${item.id} was not dismissed`,
        )
      }
      return
    }

    console.error(
      'usage: mars action-queue [list [open|dismissed|all] [--lean] | show <id> | ack <id> | resolve <id> | dismiss <id> [--note <text>] | undismiss <id> | raise --from <-|path> | watch]',
    )
    process.exit(1)
  }

  if (cmd === 'diagnose') {
    const sub = rest[0]
    const { setDiagnosis, getDiagnosis, DIAGNOSIS_KINDS } = await import(
      './core/lib/diagnose'
    )

    if (sub === 'set') {
      const taskId = rest[1]
      if (!taskId) {
        console.error(
          'usage: mars diagnose set <task-id> --from <-|path>',
        )
        process.exit(2)
      }
      const from = flags['--from']
      if (!from) {
        console.error(
          'usage: mars diagnose set <task-id> --from <-|path>',
        )
        process.exit(2)
      }
      let raw: string
      try {
        if (from === '-') {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
          }
          raw = Buffer.concat(chunks).toString('utf8')
        } else {
          raw = readFileSync(from, 'utf8')
        }
      } catch (err) {
        console.error(`failed to read input: ${(err as Error).message}`)
        process.exit(2)
      }
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch (err) {
        console.error(`invalid JSON: ${(err as Error).message}`)
        process.exit(2)
      }
      if (typeof json !== 'object' || json === null) {
        console.error(
          `diagnose set: input must be a JSON object with a 'kind' field (${DIAGNOSIS_KINDS.join(', ')})`,
        )
        process.exit(2)
      }
      try {
        await setDiagnosis(taskId, json as Parameters<typeof setDiagnosis>[1])
        console.log(`diagnosis recorded for ${taskId}`)
      } catch (err) {
        console.error(`diagnose set: ${(err as Error).message}`)
        process.exit(1)
      }
      return
    }

    if (sub === 'show') {
      const taskId = rest[1]
      if (!taskId) {
        console.error('usage: mars diagnose show <task-id> [--json]')
        process.exit(2)
      }
      const verdict = await getDiagnosis(taskId)
      if (rest.includes('--json')) {
        console.log(JSON.stringify(verdict, null, 2))
        return
      }
      console.log(`task: ${verdict.taskId}`)
      console.log(`kind: ${verdict.kind}`)
      if (verdict.kind === 'root-cause-found') {
        console.log(`recorded-at: ${verdict.recordedAt}`)
        console.log(`evidence:`)
        console.log(`  ${verdict.evidence}`)
        console.log(`involved-files:`)
        for (const f of verdict.involvedFiles) console.log(`  ${f}`)
        console.log(`fix-direction:`)
        console.log(`  ${verdict.fixDirection}`)
      } else if (verdict.kind === 'inconclusive') {
        console.log(`recorded-at: ${verdict.recordedAt}`)
        console.log(`what-checked:`)
        console.log(`  ${verdict.whatChecked}`)
        console.log(`why-unscoped:`)
        console.log(`  ${verdict.whyUnscoped}`)
      } else {
        console.log('(no verdict recorded for this task)')
      }
      return
    }

    console.error(
      'usage: mars diagnose <set <task-id> --from <-|path> | show <task-id> [--json]>',
    )
    process.exit(1)
  }

  if (cmd === 'triage') {
    const id = rest[0]
    const { runTriage } = await import('./workflows/triage-workflow')
    if (id) {
      const result = await runTriage(id)
      console.log(`[${result.taskId}] actionable=${result.actionable}`)
      if (result.reason) console.log(`  reason: ${result.reason}`)
      return
    }
    const drafts = await listTasks('draft')
    if (drafts.length === 0) {
      console.log('no draft tasks')
      return
    }
    const runs = drafts.map(async (t) => {
      try {
        const result = await runTriage(t.id)
        return { taskId: t.id, ok: true as const, result }
      } catch (err) {
        return { taskId: t.id, ok: false as const, error: (err as Error).message }
      }
    })
    const settled = await Promise.allSettled(runs)
    for (const s of settled) {
      if (s.status !== 'fulfilled') {
        console.error('triage rejected:', s.reason)
        continue
      }
      const v = s.value
      if (v.ok) {
        console.log(`[${v.taskId}] actionable=${v.result.actionable}`)
      } else {
        console.log(`[${v.taskId}] error: ${v.error}`)
      }
    }
    return
  }

  if (cmd === 'uninstall') {
    // Resolution order for the wrapper binary:
    //   1. --wrapper <path>     explicit override (useful for unusual installs)
    //   2. findWrapperFor(...)  walks PATH and matches by running cli entry
    // The clone directory is derived from the wrapper's exec line via
    // resolveUninstallPaths — strictly more reliable than "three dirs above
    // cli.ts", which breaks when the runtime is invoked from a worktree or
    // a relocated build.
    const { fileURLToPath } = await import('node:url')
    const { existsSync } = await import('node:fs')
    const { rm } = await import('node:fs/promises')
    const { createInterface } = await import('node:readline')
    const { homedir } = await import('node:os')
    const { join: pathJoin } = await import('node:path')
    const { findWrapperFor, resolveUninstallPaths, runUninstall } = await import(
      './commands/uninstall.js'
    )
    const { deactivatePlugin, realDeps: pluginDeps } = await import(
      './commands/claude-plugin.js'
    )
    const userSettingsPath = pathJoin(homedir(), '.claude', 'settings.json')

    const yes = rest.includes('--yes') || rest.includes('-y')
    const isTty = Boolean(process.stdin.isTTY)

    const cliEntryPath = fileURLToPath(import.meta.url)
    const wrapperPath = flags['--wrapper'] ?? findWrapperFor(cliEntryPath)
    if (!wrapperPath) {
      console.error(
        'mars uninstall: could not locate a wrapper binary on PATH that points at this installation.',
      )
      console.error(
        'Run "which mars" to inspect your PATH, pass --wrapper <path>, or reinstall via install-dev.sh.',
      )
      process.exit(1)
    }

    if (!yes && !isTty) {
      console.error(
        'mars uninstall: stdin is not a terminal; pass --yes (or -y) to proceed non-interactively',
      )
      process.exit(1)
    }

    const { binPath, srcDir } = resolveUninstallPaths(wrapperPath)

    // Always print the resolved paths before acting so the user (or a
    // non-interactive caller) can see exactly what would be removed.
    console.log(`wrapper: ${binPath}`)
    console.log(`source:  ${srcDir}`)

    const rl =
      !yes && isTty
        ? createInterface({ input: process.stdin, output: process.stdout })
        : null

    const confirm = (): Promise<boolean> => {
      if (yes) return Promise.resolve(true)
      if (!rl) return Promise.resolve(false)
      return new Promise((resolveAnswer) => {
        rl.question(
          `Remove wrapper '${binPath}' and source clone '${srcDir}'? [y/N] `,
          (answer) => {
            resolveAnswer(answer.trim().toLowerCase() === 'y')
          },
        )
      })
    }

    try {
      const result = await runUninstall(binPath, srcDir, {
        exists: existsSync,
        removeFile: (p) => rm(p, { force: true }),
        removeDir: (p) => rm(p, { recursive: true, force: true }),
        confirm,
        log: (msg) => console.log(msg),
        deactivateClaudePlugin: () => deactivatePlugin(userSettingsPath, pluginDeps),
      })

      if (result.outcome === 'cancelled') {
        console.log('uninstall cancelled')
      }
    } finally {
      rl?.close()
    }
    return
  }

  // -------------------------------------------------------------------------
  // plugin activate <path>
  // plugin deactivate
  //
  // Register or deregister the Mars Claude Code plugin in the user-level
  // ~/.claude/settings.json.  Called by install-dev.sh after creating the
  // wrapper and by `mars uninstall` before removing the clone directory.
  // -------------------------------------------------------------------------
  if (cmd === 'plugin') {
    const subCmd = rest[0]
    const { homedir } = await import('node:os')
    const { join: pathJoin } = await import('node:path')
    const { activatePlugin, deactivatePlugin, realDeps } = await import(
      './commands/claude-plugin.js'
    )
    const userSettingsPath = pathJoin(homedir(), '.claude', 'settings.json')

    if (subCmd === 'activate') {
      const pluginDir = rest[1]
      if (!pluginDir) {
        console.error('usage: mars plugin activate <plugin-dir>')
        process.exit(1)
      }
      activatePlugin(pluginDir, userSettingsPath, realDeps)
      console.log(`mars: Claude Code plugin activated at ${pluginDir}`)
      return
    }

    if (subCmd === 'deactivate') {
      deactivatePlugin(userSettingsPath, realDeps)
      console.log('mars: Claude Code plugin deactivated')
      return
    }

    console.error(`mars plugin: unknown subcommand '${subCmd ?? ''}'`)
    console.error('usage: mars plugin activate <path> | mars plugin deactivate')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // observability prune [<days>]
  // -------------------------------------------------------------------------
  if (cmd === 'observability') {
    const sub = rest[0]
    if (sub === 'prune') {
      const ageArg = rest[1]
      let maxAgeDays = 3
      if (ageArg !== undefined) {
        const parsed = Number(ageArg)
        if (!Number.isFinite(parsed) || parsed < 0) {
          console.error(
            `usage: mars observability prune [<days>]\n\n<days> must be a non-negative number (0 = wipe all); got '${ageArg}'`,
          )
          process.exit(1)
        }
        maxAgeDays = parsed
      }
      const { pruneObservability } = await import(
        './core/lib/observability-prune'
      )
      const deleted = await pruneObservability(ctx.stateDbPath, maxAgeDays)
      console.log(`pruned ${deleted} telemetry row${deleted === 1 ? '' : 's'}`)
      return
    }
    console.error(`usage: mars observability prune [<days>]`)
    process.exit(2)
  }

  // -------------------------------------------------------------------------
  // cut verify <phase>
  //
  // Gate checks for the hard-cut to 4-letter id tags (PRD 52ec700f).
  // Three phases: drain, reset, recreate.
  // -------------------------------------------------------------------------
  if (cmd === 'cut') {
    const subCmd = rest[0]
    if (subCmd !== 'verify') {
      console.error(
        `usage: mars cut verify <drain|reset|recreate>`,
      )
      process.exit(1)
    }
    const phase = rest[1]
    const { isCutPhase, runCutVerify } = await import('./cli/cut-verify.js')
    if (!isCutPhase(phase)) {
      console.error(
        `mars cut verify: unknown phase '${phase ?? ''}'\nusage: mars cut verify <drain|reset|recreate>`,
      )
      process.exit(1)
    }
    await runCutVerify(phase, repo)
    return
  }

  if (cmd === 'statusline') {
    const { statuslineCommand } = await import('./cli/statusline.js')
    await statuslineCommand(repo)
    return
  }

  console.error(`unknown command: ${cmd}`)
  console.log(usage)
  process.exit(1)
}

try {
  await main()
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`error: ${message}`)
  process.exit(1)
}
process.exit(0)
