#!/usr/bin/env node
import { MARS_VERSION } from './version'
import { parseArgs } from './cli/args'
import { registry } from './cli/commands'
import {
  dispatch,
  isUnknown,
  makeProductionDeps,
} from './cli/dispatch'

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

const usage = `mars — provider-agnostic orchestrator for parallel agent task workflows

Usage:
  mars [--repo <path>] <command> [args]

Commands:
  init [--force] [--dry-run] [--verbose] [--yes] [--wizard] [--wizard-off] [--skip-doctor]
                                scaffold CONTEXT.md, docs/adr/, .claude/ config,
                                .mcp.json, workflow templates, and databases.
                                On success, prints 'mars ui --repo <root>' to launch
                                the read-only Kanban + trace dashboard.
  update [--force] [--yes | --accept-all] [--verbose]
                                refresh the framework-owned files an existing
                                repo received from 'mars init' (CLAUDE.md,
                                .mcp.json, .gitignore) and
                                reconcile the user-owned workflow scaffolds in
                                .mars/workflows/. Workflow files are NEVER
                                silently overwritten (ADR-0057): an identical
                                file is refreshed quietly, a diverged
                                manifest-owned file shows a unified diff and
                                prompts accept/skip, and a workflow the user
                                removed from the init manifest is left
                                untouched. --yes runs non-interactively and
                                defaults to skip-on-conflict (for CI). Existing
                                harness files require --force to overwrite.
  task add ("<prompt>" | @<file> | --prompt-file <path> | -)
                                enqueue a runnable task directly (status='queued',
                                skips triage; can be picked up by agent runners).
                                Prompt body: inline string, @path/to/file (reads
                                file verbatim — safe for \${...}/backticks),
                                --prompt-file <path> (same), or - (reads stdin).
                                Missing @file / --prompt-file is a hard error.
                                [--author kind:name] [--blocked-by <id>] [--tag <tag>] [plan flags]
                                --blocked-by <id> is repeatable; every id must
                                already exist. The task will not dispatch until
                                every listed blocker reaches 'done'. --tag is
                                repeatable; collected values form the tags list.
                                The first tag routes to a Worker ('coder' is
                                the default). Unknown tags fall back to Coder.
  task show <id>                show a single task by id (or unique 8-char prefix)
  task priority <id> <0..3>     set the dispatch priority of a queued or blocked
                                task (0 = lowest, 3 = highest; takes effect on
                                the next drain cycle without a daemon restart)
  task note <id> "<text>"       journal a progress note on a task (appended to
                                the task's note log; useful during live steps)
  task check <id> <criterion>   mark a done-criterion as complete on a task
                                with a structured spec (--done flags)
  task ask <task-id> "<question>"
                                raise a question to the operator from within a
                                task run. Writes a task.question event to the
                                outbox; the question-raise subscriber converts
                                it to a coder-question action-queue item.
                                Workers call this via Bash(mars task ask ...).
                                Read-only workers (Planner, Slicer, Triager,
                                BehaviourVerifier, Scorer) have this pattern
                                in their disallowedTools and cannot use it.
  memory list --domain <d> [--min-salience <n>] [--limit <n>]
                                list active memory packets for a domain; default
                                min-salience 0.7, default limit 20. Prints a
                                table: id, salience, domain, text, created_at.
  memory add --domain <d> --text "<text>" [--salience <n>] [--origin-arc <id>]
                                insert a domain-scoped memory packet. --salience
                                is a float 0..1 (default 0.7). Prints the
                                inserted id.
  memory retire <id>            soft-delete a memory packet. Exits 0 and prints
                                'retired' on success; exits non-zero when the id
                                is unknown or already retired.
  proposal add "<goal>" [--author kind:name]
                                create a proposal/plan in the Mars database. Author
                                is detected from env/git when omitted: human if
                                running interactively, agent if MARS_AGENT_NAME
                                or CLAUDE_CODE/CLAUDECODE is set.
  proposal list [--source <source>] [--status <status>]
                                list proposals; filter by source and/or status
  proposal show <id>            show a proposal from the Mars database
  proposal delete <id>          remove a proposal row from the Mars database
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
  proposal dismiss <id>         dismiss a draft proposal (flips status to
                                'dismissed'; no tasks are dispatched)
  proposal slice <id>           decompose a 'prd-ready' proposal into N
                                tracer-bullet vertical-slice tasks (one per
                                user-observable behaviour) and queue them with
                                blockers wired between dependent slices. Flips
                                the proposal's status to 'sliced'.
  proposal block <proposal-id> <blocker-id> [<blocker-id> ...]
                                ADR-0008 planning-graph edge: <proposal-id> waits
                                on each <blocker-id>. Both endpoints must
                                exist; self-blocking is rejected. Stored in
                                proposal_dependencies (Mars database).
  proposal unblock <proposal-id> <blocker-id> [<blocker-id> ...]
                                remove the listed planning-graph edges only;
                                the proposal's status is left untouched.
  proposal blockers <proposal-id>
                                list the proposals <proposal-id> is blocked by.
  proposal block-task <task-id> <proposal-id> [<proposal-id> ...]
                                ADR-0015 cross-graph edge: <task-id> cannot
                                dispatch until each <proposal-id> is promoted.
                                Stored in task_proposal_blockers
                                (Mars database). Transferred onto a real
                                task_blockers edge atomically when the proposal
                                is sliced.
  proposal unblock-task <task-id> <proposal-id> [<proposal-id> ...]
                                remove the listed task->proposal edges only.
  proposal task-blockers <task-id>
                                list the proposals <task-id> is blocked by.
  proposal approve <id>         approve a shaped proposal (flips status to
                                'approved'; signals readiness for slicing)
  proposal take <id>            take ownership of a proposal (assigns the
                                current user as the owner for triage)
  proposal reslice <id>         re-slice a previously sliced proposal into
                                new tasks (purges old slices first)
  proposal ship-summary <id> [--json]
                                print a summary of the landed arc for a proposal:
                                each task's id, status, merge commit sha, and
                                commit subject. --json emits the raw object.
  step done <id>                signal step completion on a live task; the
                                workflow advances to the next step (auto steps
                                run immediately; the next manual step parks
                                awaiting input)
  validate <id> [<id> ...]      approve preview-gated task(s) and re-queue them
                                for merge via the running daemon.
  reject <id> [<id> ...]        reject preview-gated task(s), preserving their
                                worktrees and marking them failed.
  release <id>                  release a leased worktree without merging;
                                the worktree is preserved for inspection.
                                Use --abort to exit without merging.
  set-functional <id> <text|@file>
                                set the functional plan on a draft/queued task
  set-technical <id> <text|@file>
                                set the technical plan on a draft/queued task
  show <id>                     print full detail for an id; looks up tasks
                                first, then proposals (both in the Mars database)
  list [<status>] [--limit <n>] [--all]
                                list tasks; defaults to 10 rows with total
                                count. Status: draft|triaging|queued|blocked|
                                running|verifying|merging|vega-reconciling|
                                awaiting-validation|done|failed|dropped.
                                --limit <n> shows n rows; --all shows every
                                matching task.
  continue <id> [<id> ...]      resume failed task(s) on their existing
                                worktree+branch. Code-phase failures preserve
                                and resume prior work; pre-setup or missing-
                                worktree failures degrade safely to restart.
                                Refuses only non-failed tasks or tasks with an
                                in-flight recovery. Stops on the first error.
  merge cancel <jobId>          cancel an active merge job by id. Marks the job
                                canceled in the database and, if the merge worker
                                is currently processing it, aborts the in-flight
                                merge operation. Required before restarting or
                                purging a task that has an active merge job.
  restart <id> [<id> ...]       wipe worktree+branch and re-queue failed/done/
                                merging/vega-reconciling task(s) from setup
                                (full pipeline re-run). Stops on first error.
  purge <id> [<id> ...] [--force] delete failed/done/dropped task(s) entirely
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
  recover [<id>]                re-evaluate blocked task(s) on the running daemon
                                and re-queue any whose blockers are all resolved —
                                the on-demand equivalent of the boot-time recovery
                                scan (no daemon restart needed). With <id>, recovers
                                just that task; with no id, sweeps every 'blocked' task.
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
                                (and legacy .worktrees/) against the task rows and
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
  worktree reclaim [--dry-run]  read-only scan: classify every directory under
                                .mars/worktrees/ by task existence and status,
                                compute disk usage, and print a table with a
                                reclaimable-bytes footer. Nothing is deleted.
  daemon <start|stop|restart|kill|status|reload|set-flag|pause|resume> [flags]
                                run the orchestration daemon. 'start' forks to
                                background (also --detach). 'stop' stops
                                accepting new tasks then waits for in-flight to
                                finish (--force exits immediately and abandons
                                in-flight). 'restart' stops then starts fresh.
                                'kill' SIGKILLs the daemon's process group,
                                terminating every child provider worker, and
                                marks in-flight tasks failed. 'status' (also
                                --status) prints inFlight + queue counts.
                                'reload' re-reads .mars/daemon.json (falling
                                back to MARS_MAX_* env vars and built-in
                                defaults) without restarting. 'set-flag
                                recovery <on|off>' toggles the
                                MARS_RECOVERY_DISABLED kill-switch in-memory;
                                'set-flag scoring off' suppresses post-instance
                                Scorer runs (MARS_SCORING_DISABLED, in-memory,
                                not persisted across restarts). 'pause'
                                suspends dispatch while keeping the daemon
                                alive (in-flight tasks continue). 'resume'
                                re-enables dispatch after a pause.
  budget set [--window <dur>] [--window-tokens <N>] [--arc-tokens <N>]
                                configure the Spend meter (observe-and-warn
                                token-budget alerting). Any subset of flags;
                                thresholds persist under the 'budget' key in
                                .mars/daemon.json and the daemon spend sweep
                                picks them up within ~30s (no restart). Absent
                                config = meter disabled. Units are raw
                                cache-weighted tokens (cache reads at 0.1x).
  budget status [--json]        print configured thresholds, current rolling-
                                window burn (% of threshold + band), top live
                                arcs vs the per-arc ceiling, and any open
                                budget-* action-queue rows. The meter never
                                pauses dispatch — it only warns.
  sync                          run the daemon's startup reconcile on demand:
                                re-queue orphaned-blocked tasks (blocked with
                                no live blocker edges), finalize landed merges,
                                requeue stale-running tasks, repair blocker
                                drift, etc. Routes via daemon RPC when alive
                                (single-writer invariant); runs standalone in
                                this process when the daemon is down.
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
  enrich list                   list the gate-enrichment registry: every claimed
                                failure signature with status (candidate|shadow|
                                enforcing|retired|non-encodable), seen count and
                                shadow burn-in progress (PRD 745f33e0)
  enrich show "<signature>"     print one enrichment record
  enrich draft "<signature>" ('<json>' | -)
                                land the candidate's check spec (Writer verb):
                                {"cmd":"...","args":[...],"dir":"."}. '-' reads
                                the JSON from stdin.
  enrich approve "<signature>" [--by <name>]
                                HUMAN gate: promote a candidate check into
                                SHADOW mode (it runs but cannot fail verify);
                                enforcement requires the shadow burn-in.
  enrich retire "<signature>"   stop running a check; the signature stays
                                claimed so no candidate is regenerated
  enrich reopen "<signature>"   explicit operator verb: retired -> candidate
  chat-feedback list [--rating up|down] [--limit N] [--since <iso>]
                                list rated chat feedback entries (thumbs-up/down
                                on assistant replies). Read surface for steering
                                .mars/chat-system-prompt.md. Newest-first;
                                default limit 50. --rating filters to 'up' or
                                'down' only.
  reflect [--since <iso>] [--limit <n>]
                                synthesize draft proposals (source='reflection') from
                                recent completed tasks. Reads token + scorer
                                signals from .mars/mars.db. Default: last 10
                                completed tasks. Proposals are
                                inserted as drafts — never auto-run. Disable
                                signal capture entirely with the env var
                                MARS_REFLECT_DISABLED=1.
  reflect session [<sessionId>|<originId>]
                                session-scoped harness fitness reflection: reads
                                workflow step records and usage signals for all
                                arcs from a Foreground operator session, then
                                lands step-fitness and resource-spend verdicts as
                                draft proposals. Opt-in, operator-run (ADR-0067).
                                Disabled by MARS_REFLECT_DISABLED=1.
  reflect workflow-fit [<sessionId>|<originId>] [--dry-run]
                                evaluate workflow step fitness and token spend
                                for a Foreground session. Detects manual steps
                                that timed out (proposes runbook split) and
                                token-heavy steps (proposes progressive-
                                discovery skill). Inserts draft proposals
                                (source='reflection'). --dry-run prints the
                                would-be proposals without inserting them.
                                Disabled by MARS_REFLECT_DISABLED=1.
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
  arc purge <id> [--force]      purge a whole task arc (origin + all same-origin
                                siblings: worktree + branch + row for each).
                                Refuses if any arc branch has unique commits
                                ahead of the integration branch unless --force
                                is passed.
  scorer list [--status suggested|accepted|dismissed] [--workflow <kind>]
                                list Scorers (per-Workflow quality rubrics
                                suggested by 'mars arc reflect' when a
                                measurement gap is found). Stored in the
                                scorers table (Mars database).
  scorer show <id>              print a Scorer in full: target workflow kind,
                                quality dimension, rubric prompt, the
                                0..1-plus-rationale output contract, the
                                arc evidence + confidence that motivated it,
                                and its most recent recorded results.
  scorer accept <id>            accept a suggested Scorer. Flips status to
                                'accepted'; from then on every completed
                                instance of its target workflow is graded
                                post-merge (record-only — a low score never
                                blocks a merge or spawns recovery). Clears
                                the 'scorer-suggested' action-queue row.
  scorer dismiss <id>           dismiss a suggested Scorer (status
                                'dismissed'; clears the action-queue row).
  scorer trend [--workflow <kind>] [--window <n>]
                                per-workflow score trend over the trailing
                                window (default 20): median + p90 (never a
                                bare mean), latest score, and error-row
                                count. With --workflow, also lists the
                                window's rows with rationales. Kill-switch:
                                'mars daemon set-flag scoring off'.
  skill-forge scan [--limit <n>]
                                scan completed arc reflection reports for
                                recurring lessons (seen in 3+ distinct arcs)
                                and file one draft proposal per lesson with
                                source='skill-forge'. Idempotent — re-running
                                skips lessons that already have a proposal.
                                Reviews appear in 'mars proposal list
                                --source skill-forge'.
  tool-forge scan               scan recent failed tasks for recurring
                                missing-helper patterns (command-not-found,
                                module-not-found). When a helperKey's count
                                reaches the threshold (default 3, override via
                                MARS_TOOL_FORGE_THRESHOLD), inserts one
                                'proposed' ledger row in tool_promotion_attempts
                                and enqueues exactly one task tagged
                                'tool-forge'. Idempotent — re-running with
                                unchanged data is a no-op.
  steward inspect Coder [--provider codex|claude]
                                report the production Coder prompt's section
                                offsets, duplicated directives, and provider
                                assembly without changing it.
  steward optimize Coder [--provider codex|claude]
                                run the Steward prompt proposer. Its operator
                                autonomy lever defaults to the shared
                                autonomous level; use mars daemon set-lever
                                steward_prompt_optimizer autonomy off|ask|tell
                                to override it.
  steward revert <ledger-entry> restore a prior Worker prompt block recorded
                                by an autonomous Steward edit.
  action-queue                         alias for 'action-queue list open'
  action-queue list [state] [--kind <kind>] [--lean]
                                list action queue items. state one of:
                                open|all (default: open). --kind filters
                                by item kind, e.g. recovery-failed,
                                no-recipe. Draft proposals (status='draft')
                                surface alongside action queue rows for
                                state=open|all with kind='draft(<source>)'.
                                Use 'mars proposal ...' for the draft
                                lifecycle. --kind suppresses draft rows.
                                --lean
                                prints a compact summary (counts per
                                priority, then up to 3 oldest blockers
                                and 3 oldest drafts with section
                                totals) instead of one row per item;
                                intended for SessionStart hooks and
                                other terse summaries.
  action-queue show <id>               full detail for an action queue item (accepts a
                                full id or a unique 8-char prefix)
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
  alert list                    list arc-rooted alerts (failed arcs + stale
                                worktrees). Requires a running daemon.
  alert show <arc-id>           show full detail for a single alert by arc id.
                                Requires a running daemon.
  diagnose run <task-id>        trigger daemon-side failure diagnosis (Sonnet
                                root-cause); prints the diagnosis text. The
                                daemon must already be running; will not auto-start.
  diagnose investigate <task-id>
                                trigger daemon-side worktree investigation
                                (Haiku triage); prints the explanation. The
                                daemon must already be running; will not auto-start.
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
  ui stop                       stop the running UI server
  ui status                     print UI server status (running/stopped + port)
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
  plugin activate <plugin-dir>  register the Mars Claude Code plugin into
                                ~/.claude/settings.json (idempotent; 'mars init'
                                runs this automatically — use this verb to repair
                                a broken or manually removed plugin entry)
  plugin deactivate             deregister the Mars Claude Code plugin from
                                ~/.claude/settings.json
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
  db compact                    prune high-volume tables, then VACUUM
                                (ANALYZE). Safe to run while the daemon is
                                running.
  kpi snapshot                  take a KPI snapshot (task throughput + cycle
                                time) and print it as JSON to stdout
  kpi show                      print the KPI window comparison (previous
                                window vs current window) as JSON to stdout
  project add <path> [--name <label>]
                                register a project path in the global project
                                registry (~/.mars/projects.json)
  project list                  list registered projects
  project remove <projectId>    remove a project from the global registry
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
  workflow author               author a new workflow from a JS/TS file
                                and register it in the workflow registry
  workflow approve <id>         approve a workflow draft for use in the
                                orchestrator pipeline
  self-update                   update the mars binary via the running daemon
                                (prod installs only). Downloads the latest
                                release, verifies sha256, atomically swaps
                                the binary, and re-execs the daemon. Dev
                                installs (git clone + npm install) are
                                refused — the daemon prints the correct
                                instruction ('git pull && npm install').
                                Requires a running daemon
                                ('mars daemon start').
  propose <verb> [args...]      emit a single-line JSON proposal envelope
                                { kind: 'mars-propose', verb, args, proposalId }
                                to stdout and exit 0 — no side effects. The
                                confirm gate renders it as a parked tool call.
                                Rejects verbs not in DESTRUCTIVE_MARS_VERBS
                                (exit 2, error to stderr).
  statusline                    print a one-line Claude Code status segment.
                                Reads stdin for session JSON (tolerated but
                                optional). Reads .mars/update.json for an
                                update nudge — never hits the network. Appends
                                "⚡ v<latest> available" only when
                                available===true; silent otherwise. Exits 0
                                always.
  where                         print resolved repo + state directory
  doctor                        preflight: verify worker-provider CLI, Codex chat
                                auth.json credentials, git, Node, codegraph, daemon,
                                and database. Exits non-zero on FAIL.
                                'mars init' runs this automatically (--skip-doctor
                                to bypass).
  help                          show this message
  --version, -v                 print mars version and exit

Deprecated:
  add "<prompt>" [plan flags]   (deprecated) draft a task; lands in 'draft'
                                state so triage can promote to 'queued'.
                                Prefer 'mars task add' or 'mars proposal add'.

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
  init: `mars init [--force] [--dry-run] [--verbose] [--yes] [--wizard] [--wizard-off]

Scaffold CONTEXT.md, docs/adr/, .claude/ config, .mcp.json, workflow
templates, and databases. Also activates the Mars Claude Code plugin so
mars:* skills, agents, and hooks are available in Claude Code immediately —
idempotent, so re-running is safe. If plugin activation fails (exotic
install layout, unwritable settings file), mars prints a warning and
continues; run \`mars plugin activate <dir>\` manually to fix it.

Single entry, two paths, full parity. \`mars init\` is ONE command. On an
interactive terminal it runs a short wizard (project registration). Off a
terminal — or with --yes or --wizard-off — it runs fully non-interactively
from flags + built-in defaults, asking nothing. Every wizard question has a
matching flag so the non-interactive path can answer everything the wizard
can; this parity is enforced by a build-guard test. Plugin activation is
automatic and is NOT a wizard question.

  --yes / -y         skip the wizard; take defaults (+ any flags)
  --wizard           force the wizard even when not on a terminal (it still
                     falls back to defaults if stdin cannot be read)
  --wizard-off       skip the wizard on a terminal; non-interactive resolve
  --register-project    wizard: register this repo in the project registry

After a successful init, mars prints the exact command to launch the
read-only Kanban + trace dashboard:

  mars ui --repo <abs-repo-root>   (serves at http://127.0.0.1:7777)

If the UI package is not yet built, init prints instructions to build it.

Flags:
  --force            overwrite existing config files
  --dry-run          no-op; report what would be written
  --verbose          verbose output
  --yes, -y          non-interactive: skip the wizard, take defaults
  --wizard           force the wizard (even off a terminal)
  --wizard-off       skip the wizard on a terminal
  --skip-doctor      bypass the automatic preflight check (worker CLI, Codex
                     chat credentials, git, Node).
                     Use in CI or when the environment is already validated.`,
  update: `mars update [--force] [--yes | --accept-all] [--verbose]

Re-run init in update-mode on an existing repo. Refreshes the
framework-owned files (root CLAUDE.md, .mcp.json, .gitignore) only with
--force, then reconciles the
user-owned workflow scaffolds under .mars/workflows/ WITHOUT clobbering
them (ADR-0057).

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
  --force            overwrite existing framework-owned harness files:
                     CLAUDE.md, .mcp.json, and .gitignore
  --yes, -y          non-interactive (CI): never prompt. Diverged owned
                     workflows default to skip-on-conflict — your version
                     is kept. (--no-edit is an accepted alias.)
  --verbose          verbose output`,
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
    -                       read prompt body from stdin

  show <id>
      Show a single task by id (or unique 8-char prefix).

  priority <id> <0..3>
      Set the dispatch priority of a queued or blocked task (0 = lowest,
      3 = highest). Takes effect on the next drain cycle without a
      daemon restart.

  note <id> "<text>"
      Journal a progress note on a task. Notes are appended to the
      task's note log and are useful for recording observations or
      blockers during live step execution.

  check <id> <criterion>
      Mark a done-criterion as complete on a task with a structured spec
      (i.e. one enqueued with --done flags). The criterion string must
      match one of the declared done-criteria exactly.`,
  memory: `mars memory <list|add|retire>

Manage domain-scoped memory packets stored in the Mars database.

Subcommands:
  list --domain <d> [--min-salience <n>] [--limit <n>]
      List active memory packets for a domain. Filters out retired rows.
      --min-salience defaults to 0.7, --limit defaults to 20.
      Output columns: id, salience, domain, text, created_at.
  add --domain <d> --text "<text>" [--salience <n>] [--origin-arc <id>]
      Insert a new memory packet. --salience is a float in [0, 1] (default 0.7).
      --origin-arc ties the packet to an arc id (optional). Prints the inserted id.
  retire <id>
      Soft-delete a memory packet by id. Exits 0 and prints 'retired' on success.
      Exits non-zero when the id is unknown or already retired.`,
  proposal: `mars proposal <subcommand> ...

Subcommands:
  add "<goal>" [--author kind:name]
      Create a plan/proposal in the Mars database. Author is detected from env
      and git when omitted (agent if MARS_AGENT_NAME/CLAUDE_CODE is set,
      otherwise human with git user.email). Use --author to override,
      e.g. --author agent:vega.
  list [--source <source>] [--status <status>]
      List proposals. Filter by source and/or status.
  show <id>
      Show a proposal from the Mars database. <id> accepts a full id or a unique prefix.
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
  dismiss <id>
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
(both in the Mars database).`,
  list: `mars list [<status>] [--limit <n>] [--all]

List tasks. Defaults to the 10 most-recent matching rows; use --all to see
every row or --limit <n> to set an explicit cap.

Status filters to a specific phase (omit for all statuses):
  draft, triaging, queued, blocked, running, verifying, merging,
  vega-reconciling, awaiting-validation, done, failed, dropped

Output includes a footer with total matching count and shown count so you
can tell at a glance whether there is more than what is displayed — without
having to drop into psql.

Flags:
  --limit <n>  Show at most <n> rows (default: 10)
  --all        Show every matching row (overrides --limit)`,
  continue: `mars continue <id> [<id> ...]

Resume failed task(s) on their existing worktree+branch. Reuses every
commit the worker already landed on the task branch.

Accepts one or more ids; processes them in order and stops on the first
error (the failing id is printed to stderr and exit is non-zero).

Flags: none in v1.

Refuses (non-zero exit) when:
  - the task is not in 'failed' status
  - an in-flight recovery (fix-task) already exists for the task

Code-phase resume: a code-phase failure with its worktree still on disk
is continuable. Any dangling changes are auto-committed as a salvage
checkpoint, then the coder resumes with a banner explaining that prior
work is preserved.

Degraded-to-restart: a pre-setup failure, legacy row without a recorded
failed_phase, missing branch/worktree path, or worktree missing on disk
silently delegates to restart instead of exiting non-zero. The response
reports 'degradedToRestart: true' and prints a note explaining why.`,
  restart: `mars restart <id> [<id> ...]

Re-queue failed, done, merging, or vega-reconciling task(s) from setup.
Removes each existing worktree and branch first, then runs the full
pipeline (setup -> code -> verify -> merge) on a fresh worktree.

Accepts one or more ids; processes them in order and stops on the first
error.`,
  purge: `mars purge <id> [<id> ...] [--force]

Delete failed/done/dropped task(s) entirely (worktree + branch + row). Refuses
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
mars worktree reclaim [--dry-run]

Walk .mars/worktrees/ (and legacy .worktrees/), classify each directory
by joining against the matching task row, and remove the safe ones.

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

'reclaim' (read-only scan, dry-run only):
  absent-task (no queue row)              → reclaimable
  terminal-clean (done/failed/dropped)    → reclaimable
  unknown (in-flight or human-held)       → kept

  Prints a table of id | status | category | bytes and a footer showing
  the total reclaimable entry count and bytes. Nothing is deleted.

Flags (both subcommands):
  --dry-run         print what would happen, change nothing, exit 0.

Flags (clean only):
  --force-orphans   also remove orphan worktrees whose branches contributed
                    commits (work is dropped — use with care).

Errors during 'git worktree remove' are caught, logged with the directory
path, and counted; the verb still processes remaining worktrees and exits
0 unless every action failed.`,
  daemon: `mars daemon <start|stop|restart|kill|status|reload|set-flag|pause|resume> [flags]

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
                     the daemon's process group (kills all child provider
                     workers). Use when 'stop' is hanging on stuck work.
  status             print pid, startedAt, inFlight, and queue counts.
                     Equivalent to the legacy --status flag form.
  reload             re-read .mars/daemon.json (falling back to MARS_MAX_*
                     env vars and built-in defaults) without restarting
  set-flag <flag> <on|off>
                     toggle an in-memory kill-switch on the running daemon.
                     Supported flags:
                       recovery: 'on' sets MARS_RECOVERY_DISABLED=1
                     (fix-task/Investigator spawns are suppressed); 'off'
                     unsets it.
                       scoring: 'off' sets MARS_SCORING_DISABLED=1 (post-
                     instance Scorer runs are suppressed — the instant brake
                     on the one-judge-call-per-instance spend); 'on' unsets
                     it. Not persisted — a daemon restart re-reads the
                     spawn env.
  pause              suspend dispatch: stop acquiring new work while keeping
                     the daemon alive. In-flight tasks continue to completion.
                     Task add/unblock/purge/restart still work (state
                     mutations; they do not dispatch). Survives reload but
                     NOT a daemon restart. Use 'resume' to re-enable.
  resume             re-enable dispatch after a pause. Kicks the drain loop
                     so any tasks queued during the pause are dispatched.`,
  budget: `mars budget <set|status> [flags]

The Spend meter: observe-and-warn token-budget alerting. Two independent
meters, each with its own threshold and its own level-triggered action-queue
row: a rolling wall-clock window over ALL arcs (including in-flight ones) and
a per-live-arc lifetime ceiling. Units are raw cache-weighted tokens
(input + output + cacheCreate + cacheRead*0.1 — the cost_per_arc weighting).
The meter NEVER pauses dispatch and NEVER suppresses recoveries; the
operator is the only actuator.

Subcommands:
  set [--window <dur>] [--window-tokens <N>] [--arc-tokens <N>]
      Persist thresholds (any subset) under the 'budget' key in
      .mars/daemon.json via merge-patch — other keys are preserved and
      unnamed thresholds keep their prior values. Durations accept ms/s/m/h/d
      suffixes (e.g. 4h). The daemon's spend sweep re-reads the file every
      tick (default 30s, MARS_SPEND_SWEEP_MS), so changes take effect
      without a restart. Absent config = meter disabled (no rows).

  status [--json]
      Print configured thresholds, current window spend with % of threshold
      and a good/warn/bad band (<70% good, 70-100% warn, >=100% bad), the
      top live arcs by lifetime spend vs the per-arc ceiling, and any open
      'budget-window' / 'budget-arc' action-queue rows. --json emits the
      same shape for scripting. An unconfigured meter says so instead of
      printing zeros. Reads the DB directly — works with the daemon down.

Rows are level-triggered (ADR-0048): the sweep is both raiser and resolver.
The window row auto-resolves when spend drops below ~90% of the threshold
(hysteresis); a per-arc row auto-resolves when its arc reaches terminal
status.`,
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
  'reflect session': `mars reflect session [<sessionId>|<originId>]

Session-scoped harness fitness reflection (ADR-0067 closing ritual).

Joins the operator's Foreground session to its downstream task arcs via
origin_session_id, then evaluates two dimensions and lands every finding
as a draft proposal (source='reflection') — nothing is auto-applied.

1. STEP FITNESS: reads workflow step records (workflow_step_runs) to
   judge whether each step type (setup / code / verify / merge) was
   appropriately sized. Findings are phrased as concrete edits to the
   workflow file (e.g. orchestrator/src/workflows/implement-workflow.ts).
   Each verdict ends with "Run mars workflow validate <name> to check."

2. RESOURCE SPEND: reads per-arc usage signals. Where token burn is
   linked to a known pattern, names the remedy:
     - repeated file reads   → add the codegraph MCP tool
     - wide context gathering → wire the progressive-discovery skill
     - low cache-hit ratio    → restructure prompt / context ordering
     - CPU-heavy verify steps → parallelise or scope tests in the workflow

Positional argument:
  <sessionId>   RFC-4122 UUID of a Foreground Claude Code session
                (CLAUDE_CODE_SESSION_ID). All arcs whose origin task
                carries this session ID are included.
  <originId>    A task or arc origin ID; the session is resolved
                from the task's origin_session_id and all sibling
                arcs from that session are included.

When no argument is given, CLAUDE_CODE_SESSION_ID is used as the session.

Output:
  Draft proposals viewable with 'mars proposal list --source reflection'.
  Full report: .mars/deep-reflections/session-<id8>-<iso>.json

Disabled by MARS_REFLECT_DISABLED=1.
Model defaults to opus; override with MARS_DEEP_REFLECT_MODEL.`,
  'reflect workflow-fit': `mars reflect workflow-fit [<sessionId>|<originId>] [--dry-run]

Evaluate workflow step fitness and token spend for a Foreground session.

Reads the session's arc via origin_session_id join and checks two outlier
categories, landing each finding as a draft proposal (source='reflection'):

1. MANUAL STEP TIMEOUT — a step whose name signals operator involvement
   (manual-*, human-*, user-*, await-*, validate, review) has failed or
   ran for >4 hours. Proposal: replace it with a runbook-guided split.

2. TOKEN OUTLIER — a task whose weighted-token spend exceeds 3× the
   mean of all other tasks in the session (or >50k tokens when there is
   only one task). Proposal: apply the progressive-discovery skill.

Positional argument:
  <sessionId>   RFC-4122 UUID of a Foreground Claude Code session.
  <originId>    A task or arc origin ID; the session is resolved
                from the task's origin_session_id.

When no argument is given, CLAUDE_CODE_SESSION_ID is used.

Flags:
  --dry-run     Print the would-be proposals without inserting them.

Output:
  Draft proposals viewable with 'mars proposal list --source reflection'.

Disabled by MARS_REFLECT_DISABLED=1.`,
  'chat-feedback list': `mars chat-feedback list [--rating up|down] [--limit N] [--since <iso>]

List rated chat feedback entries (thumbs-up or thumbs-down on assistant
replies). The read surface for steering .mars/chat-system-prompt.md before
and after running 'mars reflect'. Results are shown newest-first.

Flags:
  --rating up|down   filter to thumbs-up or thumbs-down entries only
  --limit N          max entries to show (default 50)
  --since <iso>      only show entries created after this ISO timestamp

Output columns: date, rating, thread (8-char prefix), note, truncated
user prompt that preceded the rated reply.`,
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
      etc.) has zero rows in the DB. Run after resetting the database
      (delete .mars/pg/data with the daemon stopped) and re-initialising
      with 'mars init'.

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
  step: `mars step <subcommand> ...

Subcommands:
  done <id>
      Signal step completion on a live task. The workflow advances to
      the next step: auto steps run immediately; the next manual step
      parks awaiting input. If the verify step fails, fix inside the
      worktree and run 'step done' again. Preview-gated tasks use
      'mars validate' or 'mars reject' instead.`,
  validate: `mars validate <task-id> [<task-id> ...]

Approve one or more tasks parked at the preview gate. Each task must be in
'awaiting-validation' status. Mars calls the running daemon's validate action;
the daemon tears down the preview and re-queues the task for its merge
continuation.

Requires a running daemon.`,
  reject: `mars reject <task-id> [<task-id> ...]

Reject one or more tasks parked at the preview gate. Each task must be in
'awaiting-validation' status. Mars calls the running daemon's reject action;
the daemon tears down the preview, marks the task failed, and preserves its
worktree for inspection.

Requires a running daemon.`,
  release: `mars release <id>

Release a leased worktree. The worktree is preserved for inspection.

Flags:
  --abort    exit without merging; the worktree is kept on disk for
             manual inspection or later re-attach.`,
  run: `mars run <subcommand> ...

Subcommands:
  show <run-id>
      Print the full detail of a workflow run by its run id. Shows
      step status, timing, and any errors.`,
  enrich: `mars enrich <subcommand> ...

Subcommands:
  Enrich tasks or proposals with additional metadata (plans, specs,
  context). Typically invoked by the orchestrator pipeline rather
  than directly by operators.`,
  scorer: `mars scorer <subcommand> ...

Manage scorer definitions and inspect scoring results. Scorers grade
task instances post-merge and feed signals back to the reflection
loop.`,
  kpi: `mars kpi <subcommand> ...

Subcommands:
  snapshot
      Take a KPI snapshot (task throughput + cycle time) and print
      it as JSON to stdout.
  show
      Print the KPI window comparison (previous window vs current
      window) as JSON to stdout.`,
  propose: `mars propose <verb> [args...]

Emit a single-line JSON proposal envelope to stdout and exit 0. Performs
NO mutations — no Postgres writes, no worktree changes, no daemon HTTP
calls. The output is a JSON object:

  { kind: 'mars-propose', verb, args, proposalId }

where proposalId is a random UUID. The destructive-confirm gate reads
this envelope and renders it as a parked tool call awaiting operator
confirmation.

Valid verbs (DESTRUCTIVE_MARS_VERBS):
  dismiss          dismiss a scorer suggestion
  purge            delete a task (worktree + branch + row)
  reject           reject a preview-gated task
  prune-worktree   prune done/dropped worktrees

Any verb not in the list above causes a usage error (exit 2, message to
stderr).

Example:
  mars propose purge mars-abc1
  # → {"kind":"mars-propose","verb":"purge","args":["mars-abc1"],"proposalId":"<uuid>"}`,
  help: `mars help [command]

Show top-level help, or detailed help for a single command. Equivalent
to 'mars <command> --help'.`,
  doctor: `mars doctor

Preflight check. Verify that every runtime prerequisite is present and
healthy before running tasks. Prints one PASS/WARN/FAIL line per check.
Exits non-zero when any check returns FAIL.

Checks:
  PASS/FAIL  worker-provider CLI  selected worker binary is runnable and,
                                  for Codex workers, authenticated
  PASS/FAIL  chat credentials     Codex auth.json has a chat access token
  PASS/FAIL  git           found on PATH
  PASS/FAIL  Node.js       version >= 22.13.0
  PASS/WARN  codegraph     optional code-intelligence binary (ADR-0062)
  PASS/WARN  daemon        running; warns on stale dev install
  PASS/WARN  database      embedded PostgreSQL DSN published (.mars/pg.dsn)

'mars init' runs the same checks automatically (pass --skip-doctor to
bypass) and fails fast on worker CLI/chat credentials/git/Node FAIL items.`,
  'task add': `mars task add ("<prompt>" | @<file> | --prompt-file <path> | -) [flags]

Enqueue a runnable task directly (status='queued'; skips triage). Agent
runners can pick it up immediately.

Prompt input channels (exactly one):
  "<prompt>"              inline literal string
  @<file>                 read prompt body from file (no shell expansion;
                          safe for \${...}, backticks, \$(...)). Missing file
                          is a hard error.
  --prompt-file <path>    same as @<file>, explicit flag form
  -                       read prompt body from stdin

Structured-task flags (all optional):
  --files <path> ...       files the coder should focus on (repeatable)
  --verify "<cmd>"         shell command the orchestrator runs to verify the
                           work; non-zero exit → task fails
  --done "<criterion>" ... acceptance criteria checklist (repeatable)
  --type auto|checkpoint   task type: 'checkpoint' pauses for human review
                           before merging; 'auto' (default) merges directly

Other flags:
  --intent <text>          one-line summary stored on the task; derived from
                           the first sentence of the prompt when omitted
  --priority 0..3          dispatch priority (0 = lowest, 3 = highest)
  --tag <tag>              routing tag, repeatable; first tag selects the Worker
                           ('coder' is the default)
  --blocked-by <id>        blocker task id; repeatable. Task will not dispatch
                           until every listed blocker reaches 'done'
  --author kind:name       override detected author (human|agent)
  --workflow <name>        select the dispatch pipeline
                           (.mars/workflows/<name>-workflow.js); mutually
                           exclusive with --live unless --workflow live
  --live                   sugar for --workflow live; enqueue on the live
                           pipeline whose code step parks awaiting human input
  --supersede <task-id>    declare this new task as an operator-authored
                           continuation of the given failed task; the referenced
                           task must be in status 'failed'
  --qa auto|manual         review mode for the task's review step; 'auto'
                           (default) runs typecheck/tests/lint; 'manual' parks
                           the task for human sign-off before merge

Plan flags:
  --functional <text|@file>   functional plan text
  --technical <text|@file>    technical plan text
  --functional-file <path>    read functional plan from a file
  --technical-file <path>     read technical plan from a file

Examples:
  mars task add "Fix the slicer" --files src/slicer.ts --verify "npm test" --done "tests pass"
  mars task add @prompt.txt --type checkpoint --priority 2
  mars task add "Add auth" --blocked-by mars-task-1234`,
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
/**
 * Resolve the DB target for the best-effort CLI trace WITHOUT creating
 * `.mars/`. Returns `null` — and the trace is silently skipped — when the
 * repo root cannot be determined, `.mars/` does not exist yet, or (embedded
 * backend) the daemon has not published `.mars/pg.dsn`. Only once those
 * non-creating checks pass does it delegate to `resolveDbTarget` (whose
 * `resolveContext` mkdir is then a no-op on the existing directory).
 */
const findReachableDbTarget = async (
  repo: string | undefined,
): Promise<string | null> => {
  try {
    const { existsSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const { dirname, join, resolve } = await import('node:path')
    const explicit = repo ?? process.env.MARS_REPO
    let repoRoot: string
    if (explicit) {
      repoRoot = resolve(explicit)
    } else {
      // `--git-common-dir` resolves to the real repo's `.git` even from a
      // linked worktree (`.mars/worktrees/<id>`), matching detectRepoRoot.
      const gitCommonDir = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8' },
      ).trim()
      repoRoot = dirname(gitCommonDir)
    }
    const stateDir = join(repoRoot, '.mars')
    if (!existsSync(stateDir)) return null
    if (
      process.env.MARS_DB_BACKEND !== 'pglite' &&
      !existsSync(join(stateDir, 'pg.dsn'))
    ) {
      return null
    }
    const { resolveDbTarget } = await import('./core/context')
    return resolveDbTarget(repo)
  } catch {
    return null
  }
}

/**
 * Best-effort cli-invocation trace: emits one row into trace_events after a
 * command returns.  Never throws, never creates `.mars/`, gated by
 * MARS_REFLECT_DISABLED=1.
 *
 * The constraint "only when repo context is already resolvable" is enforced by
 * `findReachableDbTarget`: it checks `.mars/` (and, on the embedded backend,
 * the daemon-published `.mars/pg.dsn`) without calling `mkdirSync`, so
 * commands that never touched `deps.ctx` (and thus never created `.mars/`)
 * silently skip the trace, as do repos whose daemon is not running.
 */
const emitCliInvocationTrace = async (
  repo: string | undefined,
  command: string,
  flags: Record<string, string>,
  exitCode: number,
  startMs: number,
): Promise<void> => {
  // `cut verify` asserts table emptiness for the CLI acceptance harness; the
  // hook's own trace row would make a second run see a non-empty trace_events
  // (self-pollution). The cut family is internal harness tooling — skip it.
  if (command === 'cut' || command.startsWith('cut ')) return
  const { isReflectDisabled } = await import('./core/lib/reflect-signals')
  if (isReflectDisabled()) return
  const dbTarget = await findReachableDbTarget(repo)
  if (!dbTarget) return
  const { openTraceEventStore } = await import('./core/lib/trace-events-store')
  const { detectOriginSession } = await import('./core/author')
  const truncatedFlags: Record<string, string> = {}
  for (const [k, v] of Object.entries(flags)) {
    truncatedFlags[k] = String(v ?? '').slice(0, 200)
  }
  const store = await openTraceEventStore(dbTarget)
  try {
    await store.record({
      kind: 'cli-invocation',
      payload: {
        originSessionId: detectOriginSession(),
        command,
        flags: truncatedFlags,
        exitCode,
        durationMs: Date.now() - startMs,
      },
    })
  } finally {
    await store.close()
  }
}

const main = async (): Promise<number> => {
  const rawArgv = process.argv.slice(2)
  const startMs = Date.now()

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
    // Try the longest non-help prefix first so 'mars task add --help' looks up
    // 'task add' before falling back to 'task'. Strip help flags from rest to
    // build the sub-path tokens.
    const subTokens = rest.filter((a) => !HELP_FLAGS.has(a))
    if (subTokens.length > 0 && printCommandHelp(`${cmd} ${subTokens.join(' ')}`)) return 0
    if (printCommandHelp(cmd)) return 0
    console.log(usage)
    return 0
  }

  const deps = await makeProductionDeps(parsed.repo)
  const result = await dispatch(registry, { ...parsed, positional }, deps)

  const exitCode = isUnknown(result) ? 1 : result.code
  await emitCliInvocationTrace(
    parsed.repo,
    positional.join(' '),
    parsed.flags,
    exitCode,
    startMs,
  ).catch(() => {})

  if (isUnknown(result)) {
    console.error(`unknown command: ${result.cmd}`)
    console.log(usage)
  }
  return exitCode
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
