#!/usr/bin/env node
import { MARS_VERSION } from './version'
import { parseArgs } from './cli/args'
import { registry } from './cli/commands'
import {
  dispatch,
  isUnknown,
  makeProductionDeps,
} from './cli/dispatch'
import { buildUsage } from './cli/help'

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

const usage = buildUsage(registry)

const HELP_FLAGS = new Set(['--help', '-h', 'help'])

const COMMAND_HELP: Record<string, string> = {
  init: `mars init [--force] [--dry-run] [--verbose] [--yes] [--wizard] [--wizard-off] [-f|--config <path>]

Detect tech stack and generate specialized supervisors in
.mars/supervisors/ (skeleton + workflow contract). Also activates the Mars
Claude Code plugin so mars:* skills, agents, and hooks are available in
Claude Code immediately — idempotent, so re-running is safe. If plugin
activation fails (exotic install layout, unwritable settings file), mars
prints a warning and continues; run \`mars plugin activate <dir>\` manually
to fix it.

Single entry, two paths, full parity. \`mars init\` is ONE command. On an
interactive terminal it runs a short wizard (which supervisors to scaffold,
project registration, workflow scaffold mode). Off a terminal — or with
--yes, --wizard-off, or -f/--config — it runs fully non-interactively from
flags + config + built-in defaults, asking nothing. Every wizard question
has a matching flag AND a TOML config key, so the non-interactive path can
answer everything the wizard can; this parity is enforced by a build-guard
test. Plugin activation is automatic and is NOT a wizard question.

  --yes / -y         skip the wizard; take defaults (+ any flags/config)
  --wizard           force the wizard even when not on a terminal (it still
                     falls back to defaults if stdin cannot be read)
  --wizard-off       skip the wizard on a terminal; non-interactive resolve
  --supervisors <a,b>   wizard: comma-separated supervisor names to keep
                        (empty = all detected)
  --register-project    wizard: register this repo in the project registry
  --scaffold-mode <full|minimal>   wizard: workflow scaffold depth

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
  --yes, -y          non-interactive: skip the wizard, take defaults
  --wizard           force the wizard (even off a terminal)
  --wizard-off       skip the wizard on a terminal
  -f, --config <p>   read stack from a declarative TOML config (skips detection
                     and the wizard; a [wizard] table supplies wizard answers)`,
  update: `mars update [--yes] [--verbose] [-f|--config <path>]

Re-run init in update-mode on an existing repo. Refreshes the
framework-owned files (root + per-folder CLAUDE.md, supervisors) by force,
then reconciles the user-owned workflow scaffolds
under .mars/workflows/ WITHOUT clobbering them (ADR-0057).

Workflow reconciliation, per file:
  - missing on disk           → scaffolded fresh from the bundled template
  - identical to the template  → refreshed silently (no prompt)
  - diverged + manifest-owned  → prints a unified diff, then prompts
                                 accept/skip (your edits are never lost
                                 without your say-so)
  - diverged + NOT in the init manifest (you removed it)
                               → left completely untouched

The init manifest is refreshed on completion so subsequent updates keep
recognising your owned workflows.

Flags:
  --yes, -y          non-interactive (CI): never prompt. Diverged owned
                     workflows default to skip-on-conflict — your version
                     is kept. (--no-edit is an accepted alias.)
  --verbose          list discovered manifests on stderr
  -f, --config <p>   read stack from a declarative TOML config`,
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
  add ("<prompt>" | @<file> | --prompt-file <path> | -) [--intent <text>] [plan flags] [--author kind:name] [--blocked-by <id> ...]
      Enqueue a runnable task directly (status='queued'; skips triage).
      Agent runners can pick it up immediately via 'mars run' / the
      orchestrator. Plan flags and --author behave like 'mars add'.
      --blocked-by <id> may be repeated; each <id> must already exist.
      The new task will not dispatch until every blocker reaches 'done'.
      --intent <text>  one-line summary stored on the task; derived from the
                       first sentence of the prompt when omitted.

  Prompt input channels (exactly one):
    "<prompt>"              inline literal string
    @<file>                 read prompt body from file verbatim (no shell expansion;
                            safe for \${...}, backticks, \$(...)). Missing file is
                            a hard error.
    --prompt-file <path>    same as @<file>, explicit flag form
    -                       read prompt body from stdin`,
  proposal: `mars proposal <subcommand> ...

Subcommands:
  add "<goal>" [--author kind:name]
      Create a plan/proposal in .mars/mars.db. Author is detected from env
      and git when omitted (agent if MARS_AGENT_NAME/CLAUDE_CODE is set,
      otherwise human with git user.email). Use --author to override,
      e.g. --author agent:vega.
  list [--source reflection|human|planner] [--status <status>]
      List proposals. Filter by source and/or status.
  show <id>
      Show a proposal from .mars/mars.db. <id> must be the full proposal slug.
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

Print full detail for an id. Looks up tasks first, then proposals
(both in .mars/mars.db).`,
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
by joining against the matching mars.db row, and remove the safe ones.

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
token + scorer signals from .mars/mars.db. Default: last 10 completed
tasks. Suggestions are inserted as proposals — never auto-run. Disable
signal capture entirely with the env var MARS_REFLECT_DISABLED=1.

Flags:
  --since <iso>   only reflect on tasks completed after this ISO timestamp
  --limit <n>     max number of tasks to include (default: 10)`,
  'action-queue': `mars action-queue <subcommand> ...

Subcommands:
  (no args)                          alias for 'action-queue list open'
  list [state] [--lean]              list items by state
                                     (open|all, default: open). --lean
                                     prints a compact summary (counts per
                                     priority, then up to 3 oldest
                                     blockers and 3 oldest drafts with
                                     section totals) instead of one row
                                     per item; designed for SessionStart
                                     hooks.
  show <id>                          full detail (accepts full id or unique
                                     8-char prefix)
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
  alert: `mars alert <subcommand> ...

List arc-rooted alerts derived from failed arcs and stale worktrees. Read
through the daemon's Alert endpoints (GET /alerts, GET /alerts/:arcId) so
the CLI and UI render the same pure derivation (ADR-0054). The alert read
aggregate is never persisted — there is no row to close and no operator
dismiss verb; an alert disappears only when the arc leaves its failed
state (or the stale worktree is gone). If the daemon is not running,
both subcommands fail fast (exit 1).

Subcommands:
  (no args)                  alias for 'alert list'
  list                       list arc-rooted alerts (one tab-separated row
                             per alert: arcId, kind, goal, reason)
  show <arc-id>              show one alert's goal → reason → technical
                             hierarchy. Exits 1 with 'no alert for arc
                             <id>' when the arc has no live alert.`,
  diagnose: `mars diagnose <subcommand> ...

Trigger a daemon-side failure diagnosis or record/inspect a stored verdict
for a stuck task. The 'run' and 'investigate' subcommands require a live
daemon (--no-spawn); 'set' and 'show' read/write the local verdict store
directly.

Subcommands:
  run <task-id>
      Trigger daemon-side failure diagnosis (Sonnet root-cause). Prints
      the diagnosis text on stdout. Exits 1 if the daemon is unreachable
      or returns an error; exits 2 if <task-id> is missing.
  investigate <task-id>
      Trigger daemon-side worktree investigation (Haiku triage). Prints
      the explanation on stdout. Exit codes as for 'run'.
  set <task-id> --from <-|path>
      Record a diagnose Chore's verdict against a stuck task. Reads a
      JSON object from stdin (when path is '-') or a file. The JSON must
      have kind = "root-cause-found" (evidence, involvedFiles,
      fixDirection) or "inconclusive" (whatChecked, whyUnscoped).
      Overwrites any prior verdict for the same id. Exit codes: 0 ok,
      1 library error, 2 parse/validation error.
  show <task-id> [--json]
      Read the recorded verdict. Prints structured fields by default;
      --json emits the raw StoredDiagnosis object. An unrecorded task
      surfaces as kind="no-verdict".`,
  install: `mars install

Install the framework templates into a consumer repo. Resolves the
framework root from the running CLI's entry path, reads manifest.json,
and copies every file the manifest declares into the consumer repo
(resolved via the standard --repo > MARS_REPO > git toplevel chain).

This is the consumer-side install verb. For the dev clone install path,
use install-dev.sh from the framework checkout instead.

The runner reports the install outcome and the number of files written on
stdout. Exits 1 on a missing or malformed manifest, or on any
file-system error during the copy.`,
  kpi: `mars kpi [snapshot|show]

Read-only KPI window comparison. The bare 'mars kpi' is an alias for
'mars kpi show' — the obvious default read — following the bare-alias
pattern used by 'action-queue' and 'alert'.

Subcommands:
  (no args)        alias for 'kpi show'
  snapshot         take a fresh KPI snapshot from the task store and
                   print it as JSON on stdout. Side effect: writes the
                   snapshot row to .mars/mars.db so subsequent 'show'
                   calls can compare windows.
  show             print the current-vs-prior KPI window comparison as
                   JSON (failure rate, autonomous-completion rate,
                   recovery-success rate, cost-per-arc p50/p90, plus
                   deltas vs the prior window).`,
  plugin: `mars plugin <activate <plugin-dir> | deactivate>

Register or deregister the Mars Claude Code plugin in the user's Claude
Code settings file (~/.claude/settings.json). Idempotent — running the
same subcommand twice is safe.

Subcommands:
  activate <plugin-dir>
      Register the plugin so its skills, agents, and hooks become
      available in Claude Code. <plugin-dir> is required; exits 1 with
      usage on a missing argument.
  deactivate
      Remove the plugin from Claude Code settings. Leaves the plugin
      directory on disk untouched.`,
  recover: `mars recover [<id>]

Re-evaluate blocker edges and re-queue any blocked tasks whose blockers
have all reached 'done'. Without an <id>, processes every blocked task in
the queue and prints a summary (queued / still blocked / failed at
unblock). With an <id>, recovers that single task and prints its outcome:

  queued        → re-queued for dispatch
  noop          → still has unmet blockers
  not-blocked   → not in 'blocked' status; nothing to recover
  failed        → unblock attempt failed (failure reason printed)

Routes through the daemon; auto-spawns the daemon when needed.`,
  statusline: `mars statusline

Print a one-line status segment for Claude Code's statusline. Reads
optional session JSON from stdin (tolerated but not required) and the
.mars/update.json file for an update nudge — never hits the network.

When .mars/update.json reports available===true, appends
"⚡ v<latest> available" to the segment; otherwise the segment is silent
on updates. Exits 0 unconditionally.`,
  sync: `mars sync

Run the daemon's startup reconcile on demand: re-queue orphaned-blocked
tasks (blocked with no live blocker edges), finalize landed merges,
re-queue stale-running tasks, repair blocker drift, sweep orphan spans,
and (when the daemon is alive) slice stalled prd-ready proposals.

Routing (single-writer invariant):
  daemon alive  → routes via daemon RPC ('op: sync'); the daemon owns
                  every write.
  daemon down   → runs the reconcile standalone in this process against
                  .mars/mars.db. The output is annotated 'standalone —
                  daemon not running' so the operator knows tasks may
                  have been re-queued but nothing will dispatch them
                  until the daemon is started.

Both modes print one line per action taken (or 'nothing to reconcile —
queue is consistent' on a no-op). Exits 0 unconditionally.`,
}

const printCommandHelp = (cmd: string): boolean => {
  const text = COMMAND_HELP[cmd]
  if (!text) return false
  console.log(text)
  return true
}


/**
 * Normalise the legacy `mars daemon --detach` / `mars daemon --stop` flag-forms
 * to their canonical subcommand names before routing, so the registry router
 * stays a pure prefix match. `--detach` → `start`, `--stop` → `stop`. This is
 * the one CLI-surface alias the router does not model itself.
 */
const normalizeDaemonAliases = (positional: string[]): string[] => {
  if (positional[0] !== 'daemon') return positional
  const sub = positional[1]
  if (sub === '--detach') return ['daemon', 'start', ...positional.slice(2)]
  if (sub === '--stop') return ['daemon', 'stop', ...positional.slice(2)]
  return positional
}

/**
 * Production adapter (ADR-0023 §2). Resolves argv → parseArgs → route → run,
 * and returns the command's exit code. The version/help/usage layer
 * short-circuits here (these print and return 0 without touching the seam).
 * The single `process.exit` mapping site lives in the trailer below.
 */
const main = async (): Promise<number> => {
  const rawArgv = process.argv.slice(2)

  // --version / -v short-circuits BEFORE any subcommand parsing, context
  // resolution, or other side effects. The constant is injected at build time.
  if (rawArgv.includes('--version') || rawArgv.includes('-v')) {
    console.log(MARS_VERSION)
    return 0
  }

  const parsed = parseArgs(rawArgv)
  const positional = normalizeDaemonAliases(parsed.positional)
  const cmd = positional[0]
  const rest = positional.slice(1)

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    // 'mars help <cmd>' or 'mars --help <cmd>' prints per-command help.
    const target = rest[0]
    if (target && printCommandHelp(target)) return 0
    console.log(usage)
    return 0
  }

  if (rest.some((a) => HELP_FLAGS.has(a))) {
    if (printCommandHelp(cmd)) return 0
    console.log(usage)
    return 0
  }

  const deps = await makeProductionDeps(parsed.repo)
  const result = await dispatch(registry, { ...parsed, positional }, deps)

  if (isUnknown(result)) {
    console.error(`unknown command: ${result.cmd}`)
    console.log(usage)
    return 1
  }
  return result.code
}

// ── The single exit-mapping site (ADR-0023 §2) ───────────────────────────────
// Every command's CommandResult.code funnels through here; thrown errors map to
// exit 1 with the same `error: <message>` envelope the CLI has always emitted.
let exitCode = 0
try {
  exitCode = await main()
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`error: ${message}`)
  exitCode = 1
}
process.exit(exitCode)
