#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolveContext } from './mastra/context'
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
  '--variants',
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
])

const REPEATABLE_FLAGS = new Set(['--blocked-by', '--files', '--done'])

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const multiFlags: Record<string, string[]> = {}
  let repo: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue

    const eq = a.indexOf('=')
    const key = eq === -1 ? a : a.slice(0, eq)
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
  init [--force] [--no-fetch] [--dry-run] [--refresh] [--verbose]
                                detect tech stack and generate specialized supervisors
                                in .mars/supervisors/ (skeleton + workflow contract).
                                Recurses into subdirectories (depth cap 6) to merge
                                manifests from monorepo layouts; honors .gitignore
                                and skips .git, node_modules, .mars, .worktrees,
                                dist, build, .next, target, out, plus git submodules.
                                Nested tech-bearing manifests (e.g. frontend/ AND
                                frontend/admin/ both with package.json) are rejected.
                                Pulls specialist knowledge from
                                ayush-that/sub-agents.directory over HTTPS, cached
                                under .mars/cache/sub-agents/ (7-day TTL).
                                --verbose lists each discovered manifest on stderr.
  task add "<prompt>" [--author kind:name] [--blocked-by <id>] [--tag coder|writer] [plan flags]
                                enqueue a runnable task directly (status='queued',
                                skips triage; can be picked up by agent runners).
                                --blocked-by <id> is repeatable; every id must
                                already exist. The task will not dispatch until
                                every listed blocker reaches 'done'. --tag picks
                                the Worker that implements the task: 'coder'
                                (default) edits the worktree; 'writer' lands
                                glossary/ADR changes via the structured-write
                                daemon (no in-worktree edits).
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
  list [status]                 list tasks (draft|queued|running|verifying|merging|done|failed|dropped)
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
  purge <id> [<id> ...]         delete failed/done task(s) entirely
                                (worktree+branch+row). Stops on the first error.
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
  worktree clean [--dry-run] [--force] [--force-orphans]
                                classify every directory under .mars/worktrees/
                                (and legacy .worktrees/) against queue.db and
                                remove the safe ones: done+merged branches,
                                failed/dropped+zero-commit branches, and orphan
                                rows whose branch never advanced. Skips
                                in-flight tasks and desyncs (done+not-merged).
                                Refuses if the daemon is running unless
                                --force is also passed; --force-orphans extends
                                removal to orphan worktrees that did contribute
                                commits.
  daemon <start|stop|kill|status|reload|set-flag> [flags]
                                run the orchestration daemon. 'start' runs it in
                                the foreground; 'start --detach' forks to
                                background (also what CLI write ops auto-spawn).
                                'stop' stops accepting new tasks then waits for
                                in-flight to finish (--force exits immediately
                                and abandons in-flight). 'kill' SIGKILLs the
                                daemon's process group, terminating every child
                                claude -p worker, and marks in-flight tasks
                                failed. 'status' prints inFlight + queue counts.
                                'reload' re-reads .mars/daemon.json (falling
                                back to MARS_MAX_* env vars and built-in
                                defaults) without restarting. 'set-flag
                                recovery <on|off>' toggles the
                                MARS_RECOVERY_DISABLED kill-switch in-memory
                                (not persisted across restarts).
  ab "<instruction>" --variants <path>
                                run an A/B experiment: same instruction, two
                                configurable variants from the JSON file (must
                                contain exactly 2 entries: { prompt, model?,
                                systemPrompt? }), pinned to the same base SHA,
                                judged by an LLM rubric. No merge — both
                                worktrees are retained.
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
                                signals from .mars/queue.db and .mars/mastra.db.
                                Default: last 10 completed tasks. Proposals are
                                inserted as drafts — never auto-run. Disable
                                signal capture entirely with the env var
                                MARS_REFLECT_DISABLED=1.
  deep-reflect [<task-id>]      deep, single-session post-mortem on one task.
                                Walks the stored claude -p transcript event-by
                                -event to surface dissonant tool calls (success
                                ful tool calls that did not achieve their stated
                                intent), verify-claim mismatches, and thrashing
                                patterns. Auto-picks a candidate when no id is
                                given. Requires a stored transcript.
  arc list [--limit N] [--json] [--with-transcript-only]
                                list task arcs grouped by COALESCE(origin_id, id).
                                Each arc covers an origin task plus any recovery
                                tasks. --limit N (default 10, clamped to [1, 100]).
                                --json emits the raw ArcCandidate[] as a JSON array.
                                --with-transcript-only restricts to arcs that have
                                at least one stored transcript.
  arc reflect <id>              deep, arc-level post-mortem. Accepts an originId
                                or any task id in the arc (resolved automatically).
                                Writes report to .mars/deep-reflections/arc-<id>-<iso>.json.
  inbox                         alias for 'inbox list open'
  inbox list [state] [--kind <kind>] [--lean]
                                list inbox items. state one of:
                                open|acknowledged|resolved|dismissed|all
                                (default: open). --kind filters by item
                                kind, e.g. recovery-failed, no-recipe.
                                Draft proposals (status='draft') surface
                                alongside inbox rows for state=open|all
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
  inbox show <id>               full detail for an inbox item (accepts a
                                full id or a unique 8-char prefix)
  inbox ack <id>                mark an inbox item acknowledged
  inbox resolve <id> [--note <text>] [--root-cause <text>]
                                mark an inbox item resolved
  inbox dismiss <id> [--note <text>]
                                mark an inbox item dismissed
  inbox raise --from <-|path>   file an inbox item from a JSON document
                                (stdin when path is '-'). Replaces the
                                deprecated pattern of writing one-shot
                                .ts scripts under orchestrator/scripts/.
  inbox watch                   live terminal UI for the inbox (ink TUI)
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
  init: `mars init [--force] [--no-fetch] [--dry-run] [--refresh] [--verbose]

Detect tech stack and generate specialized supervisors in
.mars/supervisors/ (skeleton + workflow contract). Recurses into
subdirectories (depth cap 6) to merge manifests from monorepo layouts;
honors .gitignore and skips .git, node_modules, .mars, .worktrees, dist,
build, .next, target, out, plus git submodules.

Flags:
  --force       overwrite existing supervisors
  --no-fetch    skip pulling specialist knowledge from the network
  --dry-run     show detected stack and proposed supervisors only
  --refresh     bypass the 7-day specialist cache
  --verbose     list discovered manifests on stderr`,
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
      follow-ups.`,
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
done, failed, dropped. Defaults to all when omitted.`,
  continue: `mars continue <id> [<id> ...]

Resume failed task(s) on their existing worktree+branch, jumping
straight into the failed phase (verify or merge). Reuses every commit
the worker already landed on the task branch.

Accepts one or more ids; processes them in order and stops on the first
error (the failing id is printed to stderr and exit is non-zero).

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
  purge: `mars purge <id> [<id> ...]

Delete failed/done task(s) entirely (worktree + branch + row). Refuses
in-flight tasks.

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
  worktree: `mars worktree clean [--dry-run] [--force] [--force-orphans]

Walk .mars/worktrees/ (and legacy .worktrees/), classify each directory
by joining against the matching queue.db row, and remove the safe ones.

Classifications:
  done + branch merged into main          → remove
  failed/dropped + zero-commit branch     → remove
  orphan (no queue row) + zero-commit     → remove
  orphan + branch has commits             → kept (use --force-orphans)
  done + branch not merged                → kept (desync — not for this verb)
  in-flight (queued/running/verifying/    → kept (never touch)
    merging/ready)
  draft / blocked                         → kept

Flags:
  --dry-run         print what would happen, change nothing, exit 0.
  --force           run even if the daemon is up. Otherwise refused.
  --force-orphans   also remove orphan worktrees whose branches contributed
                    commits (work is dropped — use with care).

Errors during 'git worktree remove' are caught, logged with the directory
path, and counted; the verb still processes remaining worktrees and exits
0 unless every action failed.`,
  daemon: `mars daemon <start|stop|kill|status|reload|set-flag> [flags]

Run the orchestration daemon. CLI write ops auto-spawn it via
'daemon start --detach'.

Subcommands:
  start [--detach]   run the daemon (foreground by default; --detach forks
                     to background)
  stop  [--force]    graceful shutdown: stop accepting new tasks, then wait
                     for in-flight tasks to finish and exit. No timeout — use
                     'kill' if you need to abort stuck work. --force exits
                     immediately and abandons in-flight tasks (legacy).
  kill               hard stop: mark every in-flight task failed and SIGKILL
                     the daemon's process group (kills all child claude -p
                     workers). Use when 'stop' is hanging on stuck work.
  status             print pid, startedAt, inFlight, and queue counts
  reload             re-read .mars/daemon.json (falling back to MARS_MAX_*
                     env vars and built-in defaults) without restarting
  set-flag <flag> <on|off>
                     toggle an in-memory kill-switch on the running daemon.
                     Currently only 'recovery' is supported: 'on' sets
                     MARS_RECOVERY_DISABLED=1 (fix-task/Investigator spawns
                     are suppressed); 'off' unsets it. Not persisted —
                     a daemon restart re-reads the spawn env.`,
  ab: `mars ab "<instruction>" --variants <path>

Run an A/B experiment: same instruction, two configurable variants from
the JSON file (must contain exactly 2 entries: { prompt, model?,
systemPrompt? }), pinned to the same base SHA, judged by an LLM rubric.
No merge — both worktrees are retained.`,
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
  arc: `mars arc <subcommand> ...

Subcommands:
  list [--limit N] [--json] [--with-transcript-only]
      List task arcs grouped by COALESCE(origin_id, id) so ad-hoc tasks
      without a proposal still appear as one-task arcs.

      Text output: header row, then one tab-separated row per arc:
        originId  tasks  done  failed  tokens  costUsd  lastActivity

      Flags:
        --limit N              max arcs to return (default 10, clamped to [1, 100])
        --json                 emit a JSON array of ArcCandidate objects
        --with-transcript-only only include arcs with at least one stored transcript

  reflect <originId-or-task-id>
      Deep, arc-level post-mortem across every task in a single Mars arc.
      Accepts either an originId or any task id that belongs to the arc;
      the origin is resolved automatically via COALESCE(origin_id, id).

      Walks every stored transcript event-by-event and reasons across tasks
      to surface cross-task patterns (recovery tasks that repeated a failing
      strategy, work undone across tasks, etc.). Identical findings to
      'mars deep-reflect' but scoped to the full arc instead of a single session.

      Output: findings printed to stdout, full JSON report persisted to
      .mars/deep-reflections/arc-<originId>-<iso>.json.

      Requires at least one stored transcript in the arc. Disabled by
      MARS_REFLECT_DISABLED=1. Model defaults to opus; override with
      MARS_DEEP_REFLECT_MODEL.`,
  reflect: `mars reflect [--since <iso>] [--limit <n>]

Synthesize draft task suggestions from recent completed tasks. Reads
token + scorer signals from .mars/queue.db and .mars/mastra.db. Default:
last 10 completed tasks. Suggestions are inserted as proposals — never
auto-run. Disable signal capture entirely with the env var
MARS_REFLECT_DISABLED=1.

Flags:
  --since <iso>   only reflect on tasks completed after this ISO timestamp
  --limit <n>     max number of tasks to include (default: 10)`,
  'deep-reflect': `mars deep-reflect [<task-id>]

Deep, single-session post-mortem on one Mars task. Walks the stored
claude -p transcript event-by-event to surface things 'mars reflect'
cannot see — in particular, tool calls that succeeded at the call site
but did not achieve the assistant's stated intent (e.g. an Edit that
landed on the wrong line, a Bash 'git commit' that printed "nothing to
commit", a verify step that reported pass with "0 passed, 0 failed").

Cross-references end-of-turn assistant claims against the recorded
verify output. Identifies thrashing patterns (same file Read 5+ times,
Edit-and-revert pairs, repeated identical Bash invocations).

Output: structured findings printed to stdout, full JSON report
persisted to .mars/deep-reflections/<task-id>-<iso>.json (gitignored).
Suggestions are filtered through save|absorb|drop verdicts and only
"save" verdicts land as draft proposals with source='reflection'.

When no <task-id> is given, the candidate is auto-picked:
  1. most recent failed task with a stored transcript;
  2. else, highest-cost done task in last 7 days (cost ≥ 2× median);
  3. else, most recent done task with a transcript;
  4. else, prints "no eligible session found" and exits 0.

Requires a stored transcript (captured automatically by the implement
workflow unless MARS_REFLECT_DISABLED=1 is set). The model defaults to
opus; override with MARS_DEEP_REFLECT_MODEL.`,
  inbox: `mars inbox <subcommand> ...

Subcommands:
  (no args)                          alias for 'inbox list open'
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
  raise --from <-|path>              file a new inbox item from JSON.
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
                                     inbox id on stdout, one line, no
                                     decoration. Exit codes: 0 ok, 1
                                     library error, 2 parse/validation
                                     error.
  watch                              live terminal UI for the inbox (ink TUI;
                                     j/k move, enter detail, a ack,
                                     r resolve, d dismiss, R toggle resolved,
                                     q quit)`,
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
    })
    return
  }

  const ctx = resolveContext(repo)

  if (cmd === 'where') {
    console.log(`repo:           ${ctx.repoRoot}`)
    console.log(`stateDir:       ${ctx.stateDir}`)
    console.log(`queueDb:        ${ctx.queueDbPath}`)
    console.log(`mastraDb:       ${ctx.mastraDbPath}`)
    console.log(`supervisorsDir: ${ctx.supervisorsDir}`)
    console.log(`cacheDir:       ${ctx.cacheDir}`)
    return
  }

  if (cmd === 'init') {
    const boolFlags = new Set(rest.filter((a) => a.startsWith('--')))
    const force = boolFlags.has('--force')
    const fetch = !boolFlags.has('--no-fetch')
    const dryRun = boolFlags.has('--dry-run')
    const refresh = boolFlags.has('--refresh')
    const verbose = boolFlags.has('--verbose')
    const { sendRequest } = await import('./mastra/daemon/client')
    let result
    try {
      result = (await sendRequest({
        op: 'init',
        opts: { force, fetch, dryRun, refresh, verbose },
      })) as Awaited<
        ReturnType<typeof import('./mastra/workflows/init-workflow').runInit>
      >
    } catch (err: unknown) {
      const e = err as Error & { code?: string }
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
    return
  }

  const enqueueViaDaemon = async (
    prompt: string,
    skipTriage: boolean,
    blockerIds?: readonly string[],
    priority?: number,
    tag?: 'coder' | 'writer',
    spec?: {
      files: readonly string[]
      verifyCmd: string | null
      doneCriteria: readonly string[]
      taskType: 'auto' | 'checkpoint'
    },
  ): Promise<void> => {
    const { detectNoCommitMarker } = await import('./mastra/lib/no-commit-marker')
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
    const { resolveAuthor, formatAuthor } = await import('./mastra/author')
    const author = resolveAuthor(flags['--author'])
    const { sendRequest } = await import('./mastra/daemon/client')
    const task = (await sendRequest(
      {
        op: 'add',
        prompt,
        plan,
        skipTriage,
        author,
        ...(blockerIds && blockerIds.length > 0 ? { blockerIds } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(tag !== undefined ? { tag } : {}),
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
          'usage: mars task add "<prompt>" [--author kind:name] [--blocked-by <id> ...] [--priority 0..3] [--tag coder|writer] [--files <path> ...] [--verify "<cmd>"] [--done "<criterion>" ...] [--type auto|checkpoint] [plan flags]',
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
      const tagRaw = flags['--tag']
      let tag: 'coder' | 'writer' | undefined
      if (tagRaw !== undefined) {
        if (tagRaw !== 'coder' && tagRaw !== 'writer') {
          console.error(`tag must be one of coder, writer; got '${tagRaw}'`)
          process.exit(1)
        }
        tag = tagRaw
      }
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
      await enqueueViaDaemon(prompt, true, blockerIds, priority, tag, spec)
      return
    }
    if (sub === 'show') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars task show <id>')
        process.exit(1)
      }
      const { formatAuthor } = await import('./mastra/author')
      const { getTask, listBlockers, listSiblings } = await import(
        './mastra/queue'
      )
      const task = await getTask(id)
      if (!task) {
        console.error(`no task matching ${id}`)
        process.exit(1)
      }
      console.log(`kind:       task`)
      console.log(`id:         ${task.id}`)
      console.log(`Status:     ${task.status}`)
      console.log(`tag:        ${task.tag ?? 'coder'}`)
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
      }
      const blockerTaskIds = await listBlockers(task.id)
      if (blockerTaskIds.length > 0) {
        console.log(`blockedBy:  ${blockerTaskIds.join(', ')}`)
      }
      if (task.originId && task.originId !== task.id) {
        const { getProposal } = await import('./mastra/proposals')
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
      const { sendRequest } = await import('./mastra/daemon/client')
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
      const { resolveAuthor, formatAuthor } = await import('./mastra/author')
      const author = resolveAuthor(flags['--author'])
      const { createProposal } = await import('./mastra/proposals')
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
      const { createProposal } = await import('./mastra/proposals')
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
        './mastra/proposals'
      )
      const { formatAuthor } = await import('./mastra/author')
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
      const { listTasksForProposal } = await import('./mastra/queue')
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
      const { setProposalField } = await import('./mastra/proposals')
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
      const { addProposalUserStory } = await import('./mastra/proposals')
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
      const { removeProposalUserStory } = await import('./mastra/proposals')
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
      const { sendRequest } = await import('./mastra/daemon/client')
      try {
        const r = (await sendRequest(
          { op: 'idea.promote', ideaId: id },
          {
            onSpawnNotice: (pid, log) =>
              console.log(`[mars] started daemon (pid ${pid}, log: ${log})`),
          },
        )) as { ideaId: string; status: string }
        console.log(`proposal ${r.ideaId} marked ${r.status}`)
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
      const { sendRequest } = await import('./mastra/daemon/client')
      try {
        const r = (await sendRequest(
          { op: 'idea.slice', ideaId: id },
          {
            onSpawnNotice: (pid, log) =>
              console.log(`[mars] started daemon (pid ${pid}, log: ${log})`),
          },
        )) as { ideaId: string; status: string; taskIds: string[] }
        console.log(
          `proposal ${r.ideaId} ${r.status} into ${r.taskIds.length} task(s):`,
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
      const { rejectProposal } = await import('./mastra/proposals')
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
      const { deleteProposal } = await import('./mastra/proposals')
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
      const { listProposals } = await import('./mastra/proposals')
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
      const { addProposalDependencies } = await import('./mastra/proposals')
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
      const { removeProposalDependency } = await import('./mastra/proposals')
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
      const { listProposalDependencies } = await import('./mastra/proposals')
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
      const { resolveProposalId } = await import('./mastra/proposals')
      const { addProposalBlockers } = await import('./mastra/queue')
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
      const { resolveProposalId } = await import('./mastra/proposals')
      const { removeProposalBlocker } = await import('./mastra/queue')
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
      const { listProposalBlockers } = await import('./mastra/queue')
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
    console.error(
      'usage: mars proposal <add|new|list|show|set|add-user-story|remove-user-story|promote|slice|reject|delete|block|unblock|blockers|block-task|unblock-task|task-blockers> ...',
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
    const { getTask } = await import('./mastra/queue')
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
    const { sendRequest } = await import('./mastra/daemon/client')
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
    const { formatAuthor } = await import('./mastra/author')
    const { getTask } = await import('./mastra/queue')
    const task = await getTask(id)
    if (task) {
      console.log(`kind:       task`)
      console.log(`id:         ${task.id}`)
      console.log(`Status:     ${task.status}`)
      console.log(`tag:        ${task.tag ?? 'coder'}`)
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
      }
      const { listBlockers, listSiblings } = await import('./mastra/queue')
      const blockerTaskIds = await listBlockers(task.id)
      if (blockerTaskIds.length > 0) {
        console.log(`blockedBy:  ${blockerTaskIds.join(', ')}`)
      }
      if (task.originId && task.originId !== task.id) {
        const { getProposal } = await import('./mastra/proposals')
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
      './mastra/proposals'
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
      const { listTasksForProposal } = await import('./mastra/queue')
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

  if (cmd === 'continue' || cmd === 'restart' || cmd === 'purge') {
    const ids = rest.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      console.error(`usage: mars ${cmd} <id> [<id> ...]`)
      process.exit(1)
    }
    const { sendRequest } = await import('./mastra/daemon/client')
    for (const id of ids) {
      try {
        await sendRequest({ op: cmd, id })
      } catch (err) {
        console.error(`${id}: ${(err as Error).message}`)
        process.exit(1)
      }
      const verb =
        cmd === 'continue'
          ? `queued ${id} to continue from the failed phase`
          : cmd === 'restart'
            ? `queued ${id} for restart from setup`
            : `purged ${id}`
      console.log(verb)
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
    const { sendRequest } = await import('./mastra/daemon/client')
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
    const { sendRequest } = await import('./mastra/daemon/client')
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
    const { sendRequest } = await import('./mastra/daemon/client')
    const data = (await sendRequest({
      op: 'block',
      id,
      blockerIds: blockerArgs,
    })) as { taskId: string; blockerIds: string[] }
    console.log(`blocked ${data.taskId} by: ${data.blockerIds.join(', ')}`)
    return
  }

  const { listTasks } = await import('./mastra/queue')

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
    const sub = rest[0]
    const subFlags = new Set(rest.slice(1).filter((a) => a.startsWith('--')))

    if (sub === 'stop') {
      const force = subFlags.has('--force')
      const { sendRequest } = await import('./mastra/daemon/client')
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
      const { sendRequest } = await import('./mastra/daemon/client')
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
      const { sendRequest } = await import('./mastra/daemon/client')
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
            "daemon not running; use 'mars daemon start --detach' to start it",
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
      const { sendRequest } = await import('./mastra/daemon/client')
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
            "daemon not running; use 'mars daemon start --detach' to start it",
          )
          process.exit(1)
        }
        throw err
      }
      return
    }

    if (sub === 'status') {
      const { sendRequest } = await import('./mastra/daemon/client')
      const data = (await sendRequest({ op: 'status' }, { autoSpawn: false })) as {
        pid: number
        startedAt: string
        inFlight: ReadonlyArray<{ taskId: string; kind: string }>
        counts: Record<string, number>
      }
      console.log(`pid:        ${data.pid}`)
      console.log(`startedAt:  ${data.startedAt}`)
      console.log(
        `counts:     draft=${data.counts.draft} queued=${data.counts.queued} running=${data.counts.running} verifying=${data.counts.verifying} merging=${data.counts.merging}`,
      )
      console.log(`inFlight:   ${data.inFlight.length}`)
      for (const f of data.inFlight) console.log(`  ${f.kind} ${f.taskId}`)
      return
    }

    if (sub === 'start') {
      const detach = subFlags.has('--detach')
      if (detach) {
        const { spawn } = await import('node:child_process')
        const { daemonPaths, resolveLaunchCommand, tryConnectSocket } =
          await import('./mastra/daemon/paths')
        const { socket } = daemonPaths()
        if (await tryConnectSocket(socket)) {
          console.log('daemon already running')
          return
        }
        const { command, baseArgs } = resolveLaunchCommand()
        const child = spawn(
          command,
          [...baseArgs, '--repo', ctx.repoRoot, 'daemon', 'start'],
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

      // Foreground.
      const { startDaemon } = await import('./mastra/daemon/server')
      await startDaemon({ log: (line) => console.log(line) })
      // Block forever until SIGINT/SIGTERM (the daemon handles shutdown).
      await new Promise(() => {})
      return
    }

    console.error('usage: mars daemon <start|stop|kill|status|reload|set-flag> [flags]')
    process.exit(2)
  }

  if (cmd === 'worktree') {
    const sub = rest[0]
    if (sub !== 'clean') {
      console.error('usage: mars worktree clean [--dry-run] [--force] [--force-orphans]')
      process.exit(1)
    }
    const wtFlags = new Set(rest.slice(1).filter((a) => a.startsWith('--')))
    const dryRun = wtFlags.has('--dry-run')
    const force = wtFlags.has('--force')
    const forceOrphans = wtFlags.has('--force-orphans')

    const { daemonPaths } = await import('./mastra/daemon/paths')
    const { isDaemonRunning, runWorktreeClean } = await import(
      './mastra/lib/worktree-clean'
    )
    if (await isDaemonRunning(daemonPaths().socket)) {
      if (!force) {
        console.error(
          'mars daemon is running; refusing to clean worktrees. Stop it (mars daemon stop) or pass --force to override.',
        )
        process.exit(1)
      }
      console.error(
        'warning: mars daemon is running; --force in effect. Concurrent sweeps may race.',
      )
    }

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

  if (cmd === 'ab') {
    const instruction = rest.join(' ')
    if (!instruction) {
      console.error('usage: mars ab "<instruction>" --variants <path-to-json>')
      process.exit(1)
    }
    const variantsPath = flags['--variants']
    if (!variantsPath) {
      console.error('mars ab requires --variants <path-to-json>')
      process.exit(1)
    }
    let variantsJson: unknown
    try {
      variantsJson = JSON.parse(readFileSync(variantsPath, 'utf8'))
    } catch (err) {
      console.error(`failed to read/parse ${variantsPath}: ${(err as Error).message}`)
      process.exit(1)
    }
    if (!Array.isArray(variantsJson) || variantsJson.length !== 2) {
      console.error('--variants JSON must be an array of exactly 2 entries')
      process.exit(1)
    }
    const branch = process.env.INTEGRATION_BRANCH ?? 'main'
    const { sendRequest } = await import('./mastra/daemon/client')
    let report: {
      experimentId: string
      baseSha: string
      instruction: string
      variants: ReadonlyArray<{
        label: 'A' | 'B'
        worktreePath: string
        branch: string
        usage: {
          inputTokens: number
          outputTokens: number
          cacheCreateTokens: number
          cacheReadTokens: number
          messageCount: number
        }
        verifyResult: { passed: boolean; steps: ReadonlyArray<{ name: string; passed: boolean }> }
        wallClockMs: number
        diff: { changedFiles: string[]; additions: number; deletions: number; patchTruncated: boolean }
        rubric: {
          correctness: number
          completeness: number
          unnecessaryChanges: number
          mistakes: string[]
          rationale: string
        }
      }>
      judgeRationale: string
      tokensWinner: 'A' | 'B' | 'tie'
    }
    try {
      report = (await sendRequest({
        op: 'ab',
        instruction,
        variants: variantsJson,
        integrationBranch: branch,
      })) as typeof report
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
    console.log(`\n=== A/B experiment ${report.experimentId} ===`)
    console.log(`base SHA: ${report.baseSha}`)
    console.log(`instruction: ${report.instruction}`)
    for (const v of report.variants) {
      console.log(`\n--- Variant ${v.label} ---`)
      console.log(`  worktree:       ${v.worktreePath}`)
      console.log(`  branch:         ${v.branch}`)
      console.log(`  wallClock:      ${(v.wallClockMs / 1000).toFixed(1)}s`)
      console.log(`  tokens (in):    ${v.usage.inputTokens}`)
      console.log(`  tokens (out):   ${v.usage.outputTokens}`)
      console.log(`  cache create:   ${v.usage.cacheCreateTokens}`)
      console.log(`  cache read:     ${v.usage.cacheReadTokens}`)
      console.log(`  verify passed:  ${v.verifyResult.passed}`)
      console.log(
        `  diff:           ${v.diff.changedFiles.length} files, +${v.diff.additions}/-${v.diff.deletions}${v.diff.patchTruncated ? ' (truncated)' : ''}`,
      )
      console.log(`  rubric:`)
      console.log(`    correctness:        ${v.rubric.correctness}/10`)
      console.log(`    completeness:       ${v.rubric.completeness}/10`)
      console.log(`    unnecessaryChanges: ${v.rubric.unnecessaryChanges}/10`)
      if (v.rubric.mistakes.length > 0) {
        console.log(`    mistakes:`)
        for (const m of v.rubric.mistakes) console.log(`      - ${m}`)
      }
      console.log(`    rationale: ${v.rubric.rationale}`)
    }
    console.log(`\nJudge: ${report.judgeRationale}`)
    console.log(`Token-efficiency winner: ${report.tokensWinner}`)
    console.log(
      `\nBoth worktrees retained for inspection. cd into either to inspect or run further commands.`,
    )
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
      const { sendRequest } = await import('./mastra/daemon/client')
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
      const { sendRequest } = await import('./mastra/daemon/client')
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
      const { readGlossaryFile } = await import('./mastra/lib/glossary')
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
      const { readGlossaryFile } = await import('./mastra/lib/glossary')
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
      const { sendRequest } = await import('./mastra/daemon/client')
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
    const { loadRecentTaskCorpus } = await import('./mastra/lib/reflect-query')
    const { runReflector, persistSuggestions } = await import('./mastra/lib/reflector')
    const corpus = await loadRecentTaskCorpus({ sinceIso, limit })
    if (corpus.entries.length === 0) {
      console.log('no completed tasks in window — nothing to reflect on')
      return
    }
    const cs = corpus.costSummary
    console.log(
      `reflecting over ${corpus.entries.length} task(s) — total spend $${cs.totalCostUsd.toFixed(4)} (${cs.successCount} done / ${cs.failureCount} failed)…`,
    )
    const result = await runReflector(corpus)
    if (result.costAnalysis) {
      const ca = result.costAnalysis
      console.log('\nCost analysis')
      if (ca.headline) console.log(`  ${ca.headline}`)
      if (ca.cacheHealth) {
        console.log(
          `  cache: ratio=${ca.cacheHealth.ratio.toFixed(2)} (${ca.cacheHealth.verdict}) — ${ca.cacheHealth.evidence}`,
        )
      }
      if (ca.successVsFailureSpend) {
        const s = ca.successVsFailureSpend
        console.log(
          `  success vs failure spend: $${s.successUsd.toFixed(4)} vs $${s.failureUsd.toFixed(4)} — ${s.verdict}`,
        )
      }
      for (const t of ca.expensiveTasks) {
        console.log(
          `  expensive task ${t.taskId}: $${t.costUsd.toFixed(4)} (${t.multipleOfMedian.toFixed(1)}× median) — ${t.rootCause}`,
        )
      }
      for (const s of ca.expensiveSteps) {
        console.log(
          `  expensive step ${s.stepId}: $${s.totalCostUsd.toFixed(4)} (${s.verdict}) — ${s.evidence}`,
        )
      }
      if (ca.notes) console.log(`  notes: ${ca.notes}`)
    }
    if (result.suggestions.length === 0) {
      console.log('\nno suggestions produced')
      if (result.exitCode !== 0) {
        console.error(`reflector exit code ${result.exitCode}`)
        process.exit(1)
      }
      return
    }
    const { insertReflectionTask } = await import('./mastra/queue')
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

  if (cmd === 'deep-reflect') {
    if (process.env.MARS_REFLECT_DISABLED === '1') {
      console.log('reflection disabled via MARS_REFLECT_DISABLED=1')
      return
    }
    const explicitId = rest[0] && !rest[0].startsWith('--') ? rest[0] : null
    const {
      pickDeepReflectCandidate,
      loadDeepReflectSession,
    } = await import('./mastra/lib/deep-reflect-query')
    const { runDeepReflector } = await import('./mastra/lib/deep-reflector')
    const { applyVerdicts } = await import('./mastra/lib/reflector')
    const { insertReflectionTask } = await import('./mastra/queue')

    let chosenId: string
    let pickLine: string
    if (explicitId) {
      chosenId = explicitId
      pickLine = `task ${explicitId} (explicit selection)`
    } else {
      const pick = await pickDeepReflectCandidate()
      if (!pick) {
        console.log(
          'no eligible session found (need at least one done/failed task with a stored transcript)',
        )
        return
      }
      chosenId = pick.taskId
      pickLine = `task ${pick.reason.taskId} (status=${pick.reason.status}, cost=$${pick.reason.costUsd.toFixed(4)}, picked: ${pick.reason.reason})`
    }

    const session = await loadDeepReflectSession(chosenId)
    if (!session) {
      console.error(`no transcript found for task ${chosenId}`)
      process.exit(1)
    }

    console.log(pickLine)
    console.log(
      `loading transcript: ${session.conversation.length} event(s), verifyOutput=${session.verifyOutput ? `${session.verifyOutput.length} chars` : 'none'}`,
    )

    const result = await runDeepReflector(session)
    const report = result.report

    const sourceTaskId = await insertReflectionTask(1)
    const verdictResult = await applyVerdicts(report.suggestions, sourceTaskId)

    const { mkdir, writeFile } = await import('node:fs/promises')
    const { resolve: resolvePath } = await import('node:path')
    const { getStateDir } = await import('./mastra/context')
    const outDir = resolvePath(getStateDir(), 'deep-reflections')
    await mkdir(outDir, { recursive: true })
    const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = resolvePath(outDir, `${chosenId}-${isoStamp}.json`)
    const fullDoc = {
      taskId: chosenId,
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
    console.log(
      `Dissonant calls: ${report.dissonantCalls.length}${
        report.verifyMismatch ? ` | verify mismatch: ${report.verifyMismatch.severity}` : ''
      }`,
    )
    if (report.dissonantCalls.length > 0) {
      console.log('Top dissonant calls:')
      for (const d of report.dissonantCalls.slice(0, 3)) {
        console.log(
          `  [${d.severity}] event ${d.eventIndex} ${d.tool}: ${d.statedIntent} → ${d.actualOutcome}`,
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

  if (cmd === 'arc') {
    const sub = rest[0]

    if (sub === 'reflect') {
      if (process.env.MARS_REFLECT_DISABLED === '1') {
        console.log('reflection disabled via MARS_REFLECT_DISABLED=1')
        return
      }
      const inputId = rest[1]
      if (!inputId || inputId.startsWith('--')) {
        console.error('usage: mars arc reflect <originId-or-task-id>')
        process.exit(1)
      }
      const {
        loadDeepReflectArc,
        resolveOriginIdForTaskOrSelf,
      } = await import('./mastra/lib/deep-reflect-query')
      const { runDeepReflectorArc } = await import('./mastra/lib/deep-reflector')
      const { applyVerdicts } = await import('./mastra/lib/reflector')
      const { insertReflectionTask } = await import('./mastra/queue')

      const originId = await resolveOriginIdForTaskOrSelf(inputId)
      const arc = await loadDeepReflectArc(originId)
      if (!arc) {
        console.error(`no arc found for ${originId}`)
        process.exit(1)
      }

      const statusMixStr = Object.entries(arc.statusMix)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      console.log(
        `arc ${originId}: ${arc.taskCount} task(s) [${statusMixStr}], ${arc.totals.eventCount} event(s), $${arc.totals.totalCostUsd.toFixed(4)} total`,
      )

      const result = await runDeepReflectorArc(arc)
      const report = result.report

      const sourceTaskId = await insertReflectionTask(1)
      const verdictResult = await applyVerdicts(report.suggestions, sourceTaskId)

      const { mkdir, writeFile } = await import('node:fs/promises')
      const { resolve: resolvePath } = await import('node:path')
      const { getStateDir } = await import('./mastra/context')
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
      './mastra/lib/deep-reflect-query'
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
    console.log('originId\ttasks\tdone\tfailed\ttokens\tcostUsd\tlastActivity')
    for (const arc of candidates) {
      const done = arc.statusMix.done ?? 0
      const failed = arc.statusMix.failed ?? 0
      const tokens = arc.totalTokens.toLocaleString('en-US')
      const costUsd = `$${arc.totalCostUsd.toFixed(4)}`
      console.log(
        `${arc.originId}\t${arc.taskCount}\t${done}\t${failed}\t${tokens}\t${costUsd}\t${arc.lastActivity}`,
      )
    }
    return
  }

  if (cmd === 'inbox') {
    const lean = rest.includes('--lean')
    const subRest = lean ? rest.filter((a) => a !== '--lean') : rest
    const sub = subRest[0]
    const inbox = await import('./mastra/lib/inbox')
    type InboxItem = Awaited<ReturnType<typeof inbox.listInboxItems>>[number]

    interface DraftRow {
      id: string
      title: string
      source: string
      status: 'draft' | 'dismissed'
      createdAt: number
    }

    const printList = (rows: InboxItem[], drafts: DraftRow[]): void => {
      if (rows.length === 0 && drafts.length === 0) {
        console.log('inbox empty')
        return
      }
      for (const row of rows) {
        const idShort = row.id.slice(0, 8)
        const sig = row.signature ? `(${row.signature})` : '()'
        console.log(
          `${idShort}\t${row.state}\t${row.priority}\t×${row.seenCount}\t${row.kind}${sig}\t${row.title}`,
        )
      }
      for (const d of drafts) {
        const idShort = d.id.slice(0, 8)
        const title = d.title.replace(/\s+/g, ' ').trim() || '(no title)'
        console.log(
          `${idShort}\t${d.status === 'draft' ? 'open' : 'dismissed'}\t-\t-\tdraft(${d.source})\t${title}`,
        )
      }
    }

    interface LeanDraft {
      id: string
      title: string
    }

    interface BlockerGroup {
      kind: string
      signature: string
      count: number
      latestTaskId: string
      latestRaisedAt: string
    }

    const LEAN_PREVIEW = 3

    // Pull the upstream task id out of an inbox payload. recovery-failed
    // items use `originTaskId`; task-blocked items use `taskId`. Fall back
    // to '-' so the group row stays renderable.
    const extractTaskId = (payload: Record<string, unknown>): string => {
      const origin = payload.originTaskId
      if (typeof origin === 'string' && origin.length > 0) return origin
      const taskId = payload.taskId
      if (typeof taskId === 'string' && taskId.length > 0) return taskId
      return '-'
    }

    // Normalize the kind for grouping. task-blocked rows embed the task
    // id in the kind (e.g. `task-blocked(mars-bf2ae21b)`); strip the
    // suffix so siblings collapse.
    const normalizeKind = (kind: string): string => {
      const paren = kind.indexOf('(')
      return paren === -1 ? kind : kind.slice(0, paren)
    }

    // Extract the failure signature (step + reason) without the task id.
    // recovery-failed signatures look like `<taskId>:<step>/<reason>`; we
    // drop the leading task-id segment. task-blocked signatures are just
    // the task id, so we fall back to payload.lastErrorSignature.
    const extractSignature = (row: InboxItem): string => {
      const sig = row.signature ?? ''
      if (sig.includes(':')) return sig.slice(sig.indexOf(':') + 1)
      const fallback = row.payload.lastErrorSignature
      if (typeof fallback === 'string' && fallback.length > 0) return fallback
      return '-'
    }

    const groupBlockers = (rows: InboxItem[]): BlockerGroup[] => {
      const byKey = new Map<string, BlockerGroup>()
      for (const row of rows) {
        const kind = normalizeKind(row.kind)
        const signature = extractSignature(row)
        const key = `${kind}|${signature}`
        const taskId = extractTaskId(row.payload)
        const existing = byKey.get(key)
        if (existing === undefined) {
          byKey.set(key, {
            kind,
            signature,
            count: 1,
            latestTaskId: taskId,
            latestRaisedAt: row.raisedAt,
          })
          continue
        }
        existing.count += 1
        // listInboxItems returns raised_at DESC, so the first row we see
        // for a group is already the latest. Guard anyway in case ordering
        // changes upstream.
        if (row.raisedAt > existing.latestRaisedAt) {
          existing.latestRaisedAt = row.raisedAt
          existing.latestTaskId = taskId
        }
      }
      return [...byKey.values()].sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return b.latestRaisedAt.localeCompare(a.latestRaisedAt)
      })
    }

    const printLean = (rows: InboxItem[], drafts: LeanDraft[]): void => {
      if (rows.length === 0 && drafts.length === 0) {
        console.log('inbox empty')
        return
      }
      const counts: Record<string, number> = {}
      for (const row of rows) {
        counts[row.priority] = (counts[row.priority] ?? 0) + 1
      }
      const order = ['high', 'medium', 'low']
      const seen = new Set(order)
      const parts = [
        ...order.filter((p) => counts[p]).map((p) => `${p}:${counts[p]}`),
        ...Object.keys(counts)
          .filter((p) => !seen.has(p))
          .map((p) => `${p}:${counts[p]}`),
      ]
      const summary =
        parts.length > 0
          ? `inbox ${rows.length} open (${parts.join(', ')})`
          : `inbox ${rows.length} open`
      console.log(summary)

      if (rows.length > 0) {
        const groups = groupBlockers(rows)
        const header =
          groups.length < rows.length
            ? `blockers (${groups.length} groups, ${rows.length} items):`
            : `blockers (${rows.length}):`
        console.log(header)
        for (const g of groups.slice(0, LEAN_PREVIEW)) {
          console.log(
            `  ${g.kind}  ${g.signature}  x${g.count}  latest ${g.latestTaskId}`,
          )
        }
        const overflow = groups.length - LEAN_PREVIEW
        if (overflow > 0) {
          console.log(`  ... +${overflow} more`)
        }
      }

      if (drafts.length > 0) {
        console.log(`drafts (${drafts.length}):`)
        for (const d of drafts.slice(0, LEAN_PREVIEW)) {
          const idShort = d.id.slice(0, 8)
          console.log(`  ${idShort}  ${d.title}`)
        }
      }
    }

    const printShow = (item: InboxItem): void => {
      const sig = item.signature ?? '-'
      console.log(`id:           ${item.id}`)
      console.log(`kind:         ${item.kind} (${sig})`)
      console.log(`category:     ${item.category}`)
      console.log(`state:        ${item.state}`)
      console.log(`priority:     ${item.priority}`)
      console.log(`seen_count:   ${item.seenCount}`)
      console.log(`raised_by:    ${item.raisedBy}`)
      console.log(`raised_at:    ${item.raisedAt}`)
      console.log(`last_seen_at: ${item.lastSeenAt}`)
      console.log('')
      console.log(item.body)
      console.log('')
      console.log('payload:')
      const payloadJson = JSON.stringify(item.payload, null, 2)
      for (const line of payloadJson.split('\n')) console.log(`  ${line}`)
      console.log('context:')
      const contextJson = JSON.stringify(item.context, null, 2)
      for (const line of contextJson.split('\n')) console.log(`  ${line}`)
      console.log('')
      if (item.resolutionDetails) {
        console.log('resolution:')
        console.log(`  state:       ${item.resolutionDetails.state}`)
        console.log(`  resolved_by: ${item.resolutionDetails.resolvedBy ?? '-'}`)
        console.log(`  resolved_at: ${item.resolutionDetails.resolvedAt}`)
        if (item.resolutionDetails.note) {
          console.log(`  note:        ${item.resolutionDetails.note}`)
        }
        if (item.resolutionDetails.rootCause) {
          console.log(`  root_cause:  ${item.resolutionDetails.rootCause}`)
        }
      }
      if (item.history.length > 0) {
        console.log('history:')
        for (const h of item.history) {
          const from = h.fromState ?? '-'
          const by = h.by ?? '-'
          const note = h.note ? ` note=${JSON.stringify(h.note)}` : ''
          console.log(`  ${h.at}\t${from} -> ${h.toState}\tby=${by}${note}`)
        }
      }
    }

    if (sub === 'watch') {
      const { runInboxWatch } = await import('./cli/inbox-watch')
      runInboxWatch()
      return
    }

    if (sub === 'raise') {
      const from = flags['--from']
      if (!from) {
        console.error('usage: mars inbox raise --from <-|path>')
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
      const { inboxRaiseSchema } = await import('./cli/inbox-raise-schema')
      const parseResult = inboxRaiseSchema.safeParse(json)
      if (!parseResult.success) {
        console.error('inbox raise: schema validation failed')
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
        const id = await inbox.raiseInboxItem(payload)
        console.log(id)
      } catch (err) {
        console.error(`inbox raise: ${(err as Error).message}`)
        process.exit(1)
      }
      return
    }

    if (sub === undefined || sub === 'list') {
      const stateRaw = sub === 'list' ? subRest[1] : 'open'
      const state = stateRaw ?? 'open'
      const allowed = new Set([
        'open',
        'acknowledged',
        'resolved',
        'dismissed',
        'all',
      ])
      if (!allowed.has(state)) {
        console.error(
          `usage: mars inbox list [open|acknowledged|resolved|dismissed|all] [--kind <kind>] [--lean]`,
        )
        process.exit(1)
      }
      const kind = flags['--kind']
      const rows = await inbox.listInboxItems(
        state as never,
        kind === undefined ? {} : { kind },
      )
      // Drafts surface alongside inbox rows for the human-attention views.
      // --kind filters inbox kinds only, so suppress drafts when it's set.
      const draftStatusForState =
        kind === undefined
          ? state === 'open' || state === 'all'
            ? 'draft'
            : state === 'dismissed'
              ? 'dismissed'
              : null
          : null
      const draftIdeas =
        draftStatusForState === null
          ? []
          : await (async () => {
              const { listProposals } = await import('./mastra/proposals')
              return listProposals({ status: draftStatusForState })
            })()
      if (lean) {
        // listProposals returns newest first; reverse for FIFO (oldest first).
        const drafts: LeanDraft[] = [...draftIdeas].reverse().map((i) => ({
          id: i.id,
          title: i.title.replace(/\s+/g, ' ').trim() || '(no title)',
        }))
        printLean(rows, drafts)
      } else {
        const drafts: DraftRow[] = draftIdeas.map((i) => ({
          id: i.id,
          title: i.title,
          source: i.source,
          status: i.status === 'dismissed' ? 'dismissed' : 'draft',
          createdAt: i.createdAt,
        }))
        printList(rows, drafts)
      }
      return
    }

    // Drafts surface in `mars inbox list`, but the inbox verbs don't own
    // their lifecycle — point the caller at `mars proposal ...` instead of
    // failing with a generic "no inbox item" message.
    const isDraftId = async (id: string): Promise<boolean> => {
      const { resolveProposalId } = await import('./mastra/proposals')
      const resolved = await resolveProposalId(id)
      return resolved.kind === 'unique'
    }

    if (sub === 'show') {
      const id = subRest[1]
      if (!id) {
        console.error('usage: mars inbox show <id>')
        process.exit(1)
      }
      const item = await inbox.getInboxItem(id)
      if (!item) {
        if (await isDraftId(id)) {
          console.error(
            `${id} is a draft proposal, not an inbox item. Use \`mars proposal show ${id}\`.`,
          )
        } else {
          console.error(`no inbox item matching ${id}`)
        }
        process.exit(1)
      }
      printShow(item)
      return
    }

    if (sub === 'ack' || sub === 'resolve' || sub === 'dismiss') {
      const id = subRest[1]
      if (!id) {
        console.error(`usage: mars inbox ${sub} <id>`)
        process.exit(1)
      }
      const targetState =
        sub === 'ack' ? 'acknowledged' : sub === 'resolve' ? 'resolved' : 'dismissed'
      const note = flags['--note']
      const rootCause = flags['--root-cause']
      if (sub !== 'resolve' && rootCause !== undefined) {
        console.error('--root-cause is only valid with `mars inbox resolve`')
        process.exit(1)
      }
      const before = await inbox.getInboxItem(id)
      if (!before) {
        if (await isDraftId(id)) {
          const hint =
            sub === 'dismiss'
              ? `Use \`mars proposal reject ${id}\` or \`mars proposal delete ${id}\`.`
              : sub === 'resolve'
                ? `Promote it with \`mars proposal promote ${id}\` or enqueue via \`mars task add\`.`
                : `Shape it with \`/mars:grill ${id}\` or promote via \`mars proposal promote\`.`
          console.error(
            `${id} is a draft proposal, not an inbox item. ${hint}`,
          )
        } else {
          console.error(`no inbox item matching ${id}`)
        }
        process.exit(1)
      }
      const isAlreadyTerminal =
        before.state === 'resolved' || before.state === 'dismissed'
      if (isAlreadyTerminal) {
        console.error(
          `inbox item ${before.id.slice(0, 8)} is already ${before.state}; no change`,
        )
        return
      }
      const { resolveAuthor, formatAuthor } = await import('./mastra/author')
      const author = resolveAuthor(flags['--author'])
      const opts: {
        by?: string
        note?: string
        rootCause?: string
        resolution?: string
      } = { by: formatAuthor(author) }
      if (note !== undefined) opts.note = note
      if (rootCause !== undefined) opts.rootCause = rootCause
      if (sub === 'resolve' || sub === 'dismiss') {
        opts.resolution = targetState
      }
      await inbox.setInboxState(before.id, targetState, opts)
      console.log(`${sub} ${before.id.slice(0, 8)} (${targetState})`)
      return
    }

    console.error(
      'usage: mars inbox [list [state] [--lean] | show <id> | ack <id> | resolve <id> [--note <text>] [--root-cause <text>] | dismiss <id> [--note <text>] | raise --from <-|path> | watch]',
    )
    process.exit(1)
  }

  if (cmd === 'diagnose') {
    const sub = rest[0]
    const { setDiagnosis, getDiagnosis, DIAGNOSIS_KINDS } = await import(
      './mastra/lib/diagnose'
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
    const { runTriage } = await import('./mastra/workflows/triage-workflow')
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
    const { findWrapperFor, resolveUninstallPaths, runUninstall } = await import(
      './commands/uninstall.js'
    )

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
      })

      if (result.outcome === 'cancelled') {
        console.log('uninstall cancelled')
      }
    } finally {
      rl?.close()
    }
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
