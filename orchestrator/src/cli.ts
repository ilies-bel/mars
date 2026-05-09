#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolveContext } from './mastra/context'

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
])

const REPEATABLE_FLAGS = new Set(['--blocked-by'])

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
  task add "<prompt>" [--author kind:name] [--blocked-by <id>] [plan flags]
                                enqueue a runnable task directly (status='queued',
                                skips triage; can be picked up by agent runners).
                                --blocked-by <id> is repeatable; every id must
                                already exist. The task will not dispatch until
                                every listed blocker reaches 'done'.
  idea add "<goal>" [--author kind:name]
                                create an idea/plan in .mars/state.db. Author is
                                detected from env/git when omitted: human if
                                running interactively, agent if MARS_AGENT_NAME
                                or CLAUDE_CODE/CLAUDECODE is set.
  idea list [--source reflection|human|planner] [--status <status>]
                                list ideas; filter by source and/or status
  idea show <id>                show an idea from .mars/state.db
  idea set <id> <goal|story|technical|status> "<text>"
                                update a single field on an idea row
  idea add-acceptance <id> "<bullet>"
                                append a bullet to the idea's acceptance list
  idea remove-acceptance <id> <index>
                                remove the 0-based bullet; positions repack
  idea promote <id>             promote a shaped draft idea (story+technical+
                                >=1 acceptance) into a queued task. Flips the
                                idea's status to 'promoted' and stores the
                                resulting task id.
  add "<prompt>" [plan flags]   (deprecated) draft a task; lands in 'draft' state
                                so triage can promote to 'queued'. Prefer
                                'mars task add' or 'mars idea add'.
  set-functional <id> <text|@file>
                                set the functional plan on a draft/queued task
  set-technical <id> <text|@file>
                                set the technical plan on a draft/queued task
  show <id>                     print full detail for an id; tries tasks
                                (.mars/queue.db), then ideas (.mars/state.db)
  list [status]                 list tasks (draft|queued|running|verifying|merging|done|failed|dropped)
  retry <id>                    re-queue a failed/done task (cleans worktree+branch)
  purge <id>                    delete a failed/done task entirely (worktree+branch+row)
  unblock <id>                  phantom-recovery: flip a 'blocked' task to
                                'failed' AND clear every task_blockers row for
                                <id>. Use when a task is stuck on a blocker
                                that no longer exists.
  unblock <id> <blocker-id> [<blocker-id> ...]
                                edge-removal: delete the listed (task,blocker)
                                edges only; status is left untouched. Errors
                                per-id when an edge is absent.
  block <task-id> <blocker-id> [<blocker-id> ...]
                                add blocker edges so <task-id> waits for each
                                <blocker-id> to reach 'done' before dispatch.
                                All ids must already exist; self-blocking is
                                rejected.
  watch [--detach|--stop|--status|--force|--reload]
                                run the orchestration daemon (foreground by default);
                                CLI write ops auto-spawn it. --detach forks to
                                background; --stop asks daemon to exit (refuses
                                if tasks are in flight unless --force); --status
                                prints inFlight + queue counts; --reload re-reads
                                MARS_MAX_* env vars without restarting.
  ab "<instruction>" --variants <path>
                                run an A/B experiment: same instruction, two
                                configurable variants from the JSON file (must
                                contain exactly 2 entries: { prompt, model?,
                                systemPrompt? }), pinned to the same base SHA,
                                judged by an LLM rubric. No merge — both
                                worktrees are retained.
  triage [<task-id>]            run triage once on one draft, or all drafts in
                                parallel (Haiku assesses actionability + blockers)
  blockers <task-id>            list incomplete blockers on a task
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
                                synthesize draft ideas (source='reflection') from
                                recent completed tasks. Reads token + scorer
                                signals from .mars/queue.db and .mars/mastra.db.
                                Default: last 10 completed tasks. Ideas are
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
  next [--json]                 list draft ideas (status='draft'). Default
                                output is human-readable; --json prints a
                                structured payload for the /mars:next skill
                                to consume. Source ('reflection' | 'human' |
                                'planner') is annotated per row.
  inbox                         alias for 'inbox list open'
  inbox list [state]            list inbox items. state one of:
                                open|acknowledged|resolved|dismissed|all
                                (default: open)
  inbox show <id>               full detail for an inbox item (accepts a
                                full id or a unique 8-char prefix)
  inbox ack <id>                mark an inbox item acknowledged
  inbox resolve <id> [--note <text>] [--root-cause <text>]
                                mark an inbox item resolved
  inbox dismiss <id> [--note <text>]
                                mark an inbox item dismissed
  inbox watch                   live terminal UI for the inbox (ink TUI)
  where                         print resolved repo + state directory
  help                          show this message

Plan flags for 'task add' / 'add':
  --functional <text|@file>     functional plan text (or @path to read a file)
  --func <text|@file>           alias for --functional
  --technical <text|@file>      technical plan text (or @path to read a file)
  --tech <text|@file>           alias for --technical
  --functional-file <path>      read functional plan from a file
  --technical-file <path>       read technical plan from a file

Author flag for 'task add' / 'idea add' / 'add':
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
'mars idea add' (plan only).

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
  idea: `mars idea <subcommand> ...

Subcommands:
  add "<goal>" [--author kind:name]
      Create a plan/idea in .mars/state.db. Author is detected from env
      and git when omitted (agent if MARS_AGENT_NAME/CLAUDE_CODE is set,
      otherwise human with git user.email). Use --author to override,
      e.g. --author agent:vega.
  list [--source reflection|human|planner] [--status <status>]
      List ideas. Filter by source and/or status.
  show <id>
      Show an idea from .mars/state.db. <id> must be the full idea slug.
  set <id> <goal|story|technical|status> "<text>"
      Update a single field on an existing idea. Replaces the field; does
      not append.
  add-acceptance <id> "<bullet>"
      Append a bullet to the idea's acceptance list (positions auto-assigned).
  remove-acceptance <id> <index>
      Remove the 0-based acceptance bullet; remaining positions repack.`,
  'set-functional': `mars set-functional <id> <text|@file>

Set the functional plan on a draft/queued task. Use @path to read from a
file.`,
  'set-technical': `mars set-technical <id> <text|@file>

Set the technical plan on a draft/queued task. Use @path to read from a
file.`,
  show: `mars show <id>

Print full detail for an id. Looks up tasks first (.mars/queue.db),
then ideas (.mars/state.db).`,
  list: `mars list [status]

List tasks. Status one of: draft, queued, running, verifying, merging,
done, failed, dropped. Defaults to all when omitted.`,
  retry: `mars retry <id>

Re-queue a failed/done task. Cleans the worktree and branch first.`,
  purge: `mars purge <id>

Delete a failed/done task entirely (worktree + branch + row). Refuses
in-flight tasks.`,
  watch: `mars watch [--detach|--stop|--status|--force|--reload]

Run the orchestration daemon (foreground by default). CLI write ops
auto-spawn it.

Flags:
  --detach   fork to background
  --stop     ask the daemon to exit (refuses if tasks are in flight)
  --status   print inFlight + queue counts
  --force    with --stop, exit even if tasks are in flight
  --reload   re-read MARS_MAX_* env vars without restarting the daemon`,
  ab: `mars ab "<instruction>" --variants <path>

Run an A/B experiment: same instruction, two configurable variants from
the JSON file (must contain exactly 2 entries: { prompt, model?,
systemPrompt? }), pinned to the same base SHA, judged by an LLM rubric.
No merge — both worktrees are retained.`,
  triage: `mars triage [<task-id>]

Run triage once on one draft, or all drafts in parallel. Haiku assesses
actionability + blockers.`,
  blockers: `mars blockers <task-id>

List incomplete blockers on a task.`,
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
"save" verdicts land as draft ideas with source='reflection'.

When no <task-id> is given, the candidate is auto-picked:
  1. most recent failed task with a stored transcript;
  2. else, highest-cost done task in last 7 days (cost ≥ 2× median);
  3. else, most recent done task with a transcript;
  4. else, prints "no eligible session found" and exits 0.

Requires a stored transcript (captured automatically by the implement
workflow unless MARS_REFLECT_DISABLED=1 is set). The model defaults to
opus; override with MARS_DEEP_REFLECT_MODEL.`,
  next: `mars next [--json]

List draft ideas in .mars/state.db (ideas where status='draft'),
including reflection-origin and planner-origin ideas. Source can be
inspected with 'mars show <id>' or 'mars idea list --source <s>'.

Default output is a single section, designed to be read by both
humans and the /mars:next slash command. Pass --json to get a
machine-readable payload of the same data.`,
  inbox: `mars inbox <subcommand> ...

Subcommands:
  (no args)                          alias for 'inbox list open'
  list [state]                       list items by state
                                     (open|acknowledged|resolved|dismissed|all,
                                     default: open)
  show <id>                          full detail (accepts full id or unique
                                     8-char prefix)
  ack <id>                           mark item acknowledged
  resolve <id> [--note <text>] [--root-cause <text>]
                                     mark item resolved
  dismiss <id> [--note <text>]       mark item dismissed
  watch                              live terminal UI for the inbox (ink TUI;
                                     j/k move, enter detail, a ack,
                                     r resolve, d dismiss, R toggle resolved,
                                     q quit)`,
  where: `mars where

Print resolved repo + state directory.`,
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
  const { repo, flags, multiFlags, positional } = parseArgs(process.argv.slice(2))
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
    const { runInit } = await import('./mastra/workflows/init-workflow')
    const { NestedTechError, WalkAccessError } = await import(
      './init/walk-manifests'
    )
    let result
    try {
      result = await runInit({ force, fetch, dryRun, refresh, verbose })
    } catch (err: unknown) {
      if (err instanceof NestedTechError) {
        console.error(`error: ${err.message}`)
        console.error(`  outer: ${err.outerPath}`)
        console.error(`  inner: ${err.innerPath}`)
        process.exit(1)
      }
      if (err instanceof WalkAccessError) {
        console.error(`error: ${err.message}`)
        console.error(`  path:  ${err.path}`)
        process.exit(1)
      }
      throw err
    }

    if (result.detected) {
      const d = result.detected
      console.log('detected stack:')
      console.log(`  languages:   ${d.languages.join(', ') || '(none)'}`)
      console.log(`  frameworks:  ${d.frameworks.join(', ') || '(none)'}`)
      console.log(`  infra:       ${d.infra.join(', ') || '(none)'}`)
      console.log(`  mobile:      ${d.mobile.join(', ') || '(none)'}`)
      console.log(`  specialized: ${d.specialized.join(', ') || '(none)'}`)
      console.log('proposed supervisors:')
      for (const s of d.supervisors) {
        console.log(`  - ${s.name} (${s.persona}) — ${s.kind} — ${s.detectedFrom.join(', ')}`)
      }
      if (d.supervisors.length === 0) console.log('  (none)')
    }

    if (result.status === 'dry-run') {
      console.log('\ndry run: no files written')
      return
    }
    if (result.status === 'aborted-existing') {
      console.error(`\n${result.message}`)
      process.exit(1)
    }

    if (result.outcomes && result.outcomes.length > 0) {
      console.log('\nspecialist enrichment:')
      for (const o of result.outcomes) {
        if (o.outcome === 'hit' && o.externalSource) {
          console.log(`  - ${o.name}: hit (${o.externalSource.slug}.md)`)
        } else if (o.outcome === 'miss') {
          console.log(`  - ${o.name}: miss (tried: ${o.triedSlugs.join(', ') || '-'})`)
        } else {
          console.log(`  - ${o.name}: error`)
        }
      }
    }

    console.log('\nwrote:')
    for (const w of result.written ?? []) console.log(`  ${w}`)
    return
  }

  const enqueueViaDaemon = async (
    prompt: string,
    skipTriage: boolean,
    blockerIds?: readonly string[],
    priority?: number,
  ): Promise<void> => {
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
      `[mars] 'mars add' is deprecated; use 'mars task add' (skip refinement) or 'mars idea add' (plan with author).`,
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
          'usage: mars task add "<prompt>" [--author kind:name] [--blocked-by <id> ...] [--priority 0..3] [plan flags]',
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
      await enqueueViaDaemon(prompt, true, blockerIds, priority)
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
    console.error('usage: mars task <add|priority> ...')
    process.exit(1)
  }

  if (cmd === 'idea') {
    const sub = rest[0]
    if (sub === 'add') {
      const goal = rest.slice(1).join(' ')
      if (!goal) {
        console.error('usage: mars idea add "<goal>" [--author kind:name]')
        process.exit(1)
      }
      const { resolveAuthor, formatAuthor } = await import('./mastra/author')
      const author = resolveAuthor(flags['--author'])
      const { createIdea } = await import('./mastra/ideas')
      const idea = await createIdea(goal, { author })
      console.log(`${idea.id} (author: ${formatAuthor(author)})`)
      return
    }
    if (sub === 'new') {
      const goal = rest.slice(1).join(' ')
      if (!goal) {
        console.error('usage: mars idea new "<goal>"')
        process.exit(1)
      }
      const { createIdea } = await import('./mastra/ideas')
      const idea = await createIdea(goal)
      console.log(idea.id)
      return
    }
    if (sub === 'show') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars idea show <id>')
        process.exit(1)
      }
      const { getIdea, resolveIdeaId } = await import('./mastra/ideas')
      const { formatAuthor } = await import('./mastra/author')
      const resolved = await resolveIdeaId(id)
      if (resolved.kind === 'ambiguous') {
        console.error(
          `ambiguous prefix '${id}' matches ${resolved.count} ideas`,
        )
        process.exit(1)
      }
      const idea = resolved.kind === 'unique' ? await getIdea(resolved.id) : null
      if (!idea) {
        console.error(`idea ${id} not found`)
        process.exit(1)
      }
      console.log(`id:         ${idea.id}`)
      console.log(`status:     ${idea.status}`)
      console.log(`source:     ${idea.source}`)
      console.log(`author:     ${formatAuthor(idea.author)}`)
      console.log(`createdAt:  ${new Date(idea.createdAt).toISOString()}`)
      console.log(`updatedAt:  ${new Date(idea.updatedAt).toISOString()}`)
      if (idea.promotedTaskId) {
        console.log(`promotedTaskId: ${idea.promotedTaskId}`)
      }
      console.log(`goal:`)
      console.log(idea.goal)
      if (idea.story.trim().length > 0) {
        console.log(`story:`)
        console.log(idea.story)
      }
      if (idea.acceptance.length > 0) {
        console.log(`acceptance:`)
        idea.acceptance.forEach((b, i) => console.log(`  [${i}] ${b}`))
      }
      if (idea.technical.trim().length > 0) {
        console.log(`technical:`)
        console.log(idea.technical)
      }
      return
    }
    if (sub === 'set') {
      const id = rest[1]
      const field = rest[2]
      const value = rest.slice(3).join(' ')
      if (!id || !field || value.length === 0) {
        console.error(
          'usage: mars idea set <id> <goal|story|technical|status> "<text>"',
        )
        process.exit(1)
      }
      if (
        field !== 'goal' &&
        field !== 'story' &&
        field !== 'technical' &&
        field !== 'status'
      ) {
        console.error(
          `unknown field '${field}'; expected one of goal|story|technical|status`,
        )
        process.exit(1)
      }
      const { setIdeaField } = await import('./mastra/ideas')
      try {
        await setIdeaField(id, field, value)
        console.log(`updated ${id}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'add-acceptance') {
      const id = rest[1]
      const bullet = rest.slice(2).join(' ')
      if (!id || bullet.length === 0) {
        console.error('usage: mars idea add-acceptance <id> "<bullet>"')
        process.exit(1)
      }
      const { addIdeaAcceptance } = await import('./mastra/ideas')
      try {
        const idea = await addIdeaAcceptance(id, bullet)
        console.log(`added bullet [${idea.acceptance.length - 1}] to ${id}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'remove-acceptance') {
      const id = rest[1]
      const idxRaw = rest[2]
      if (!id || idxRaw === undefined) {
        console.error('usage: mars idea remove-acceptance <id> <index>')
        process.exit(1)
      }
      const idx = Number(idxRaw)
      if (!Number.isInteger(idx) || idx < 0) {
        console.error(`index must be a non-negative integer; got '${idxRaw}'`)
        process.exit(1)
      }
      const { removeIdeaAcceptance } = await import('./mastra/ideas')
      try {
        await removeIdeaAcceptance(id, idx)
        console.log(`removed bullet [${idx}] from ${id}`)
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
      return
    }
    if (sub === 'promote') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars idea promote <id>')
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
        )) as { taskId: string; ideaId: string }
        console.log(`promoted idea ${r.ideaId} -> task ${r.taskId} (queued)`)
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
      const { listIdeas } = await import('./mastra/ideas')
      const filter: { source?: 'reflection' | 'human' | 'planner'; status?: string } = {}
      if (sourceFlag) filter.source = sourceFlag as 'reflection' | 'human' | 'planner'
      if (statusFlag) filter.status = statusFlag
      const ideas = await listIdeas(filter)
      if (ideas.length === 0) {
        console.log('no ideas')
        return
      }
      for (const i of ideas) {
        const goal = i.goal.trim() || '(no goal)'
        console.log(
          `${i.id.slice(0, 8)}\t${i.status}\tsource=${i.source}\t${goal}`,
        )
      }
      return
    }
    console.error(
      'usage: mars idea <add|new|list|show|set|add-acceptance|remove-acceptance|promote> ...',
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
      console.log(`status:     ${task.status}`)
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
      if (task.retryCount > 0) {
        console.log(`retryCount: ${task.retryCount}`)
      }
      if (task.fixForTaskId) {
        console.log(`fixForTask: ${task.fixForTaskId}`)
      }
      if (task.failureSignature) {
        console.log(`failureSig: ${task.failureSignature}`)
      }
      const { listBlockers } = await import('./mastra/queue')
      const blockerTaskIds = await listBlockers(task.id)
      if (blockerTaskIds.length > 0) {
        console.log(`blockedBy:  ${blockerTaskIds.join(', ')}`)
      }
      return
    }
    const { getIdea, resolveIdeaId } = await import('./mastra/ideas')
    const ideaResolved = await resolveIdeaId(id)
    if (ideaResolved.kind === 'ambiguous') {
      console.error(
        `ambiguous prefix '${id}' matches ${ideaResolved.count} ideas`,
      )
      process.exit(1)
    }
    const idea =
      ideaResolved.kind === 'unique' ? await getIdea(ideaResolved.id) : null
    if (idea) {
      console.log(`kind:       idea`)
      console.log(`id:         ${idea.id}`)
      console.log(`status:     ${idea.status}`)
      console.log(`source:     ${idea.source}`)
      console.log(`author:     ${formatAuthor(idea.author)}`)
      console.log(`createdAt:  ${new Date(idea.createdAt).toISOString()}`)
      console.log(`updatedAt:  ${new Date(idea.updatedAt).toISOString()}`)
      if (idea.promotedTaskId) {
        console.log(`promotedTaskId: ${idea.promotedTaskId}`)
      }
      console.log(`goal:`)
      console.log(idea.goal)
      if (idea.story.trim().length > 0) {
        console.log(`story:`)
        console.log(idea.story)
      }
      if (idea.acceptance.length > 0) {
        console.log(`acceptance:`)
        idea.acceptance.forEach((b, i) => console.log(`  [${i}] ${b}`))
      }
      if (idea.technical.trim().length > 0) {
        console.log(`technical:`)
        console.log(idea.technical)
      }
      return
    }
    console.error(`no task or idea matching ${id}`)
    process.exit(1)
  }

  if (cmd === 'retry' || cmd === 'purge') {
    const id = rest[0]
    if (!id) {
      console.error(`usage: mars ${cmd} <id>`)
      process.exit(1)
    }
    const { sendRequest } = await import('./mastra/daemon/client')
    await sendRequest({ op: cmd, id })
    console.log(cmd === 'retry' ? `queued ${id} for retry` : `purged ${id}`)
    return
  }

  if (cmd === 'unblock') {
    const id = rest[0]
    const blockerArgs = rest.slice(1)
    if (!id) {
      console.error(
        `usage: mars unblock <id>                       (phantom-recovery: clears all task_blockers, flips 'blocked' -> 'failed')\n       mars unblock <id> <blocker-id> [<blocker-id> ...]  (edge-removal: removes specific edges, status unchanged)`,
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
          `unblocked ${data.taskId} (was ${data.previousStatus}; now failed). Use 'mars retry ${data.taskId}' to re-queue.`,
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
    const watchFlags = new Set(rest.filter((a) => a.startsWith('--')))
    const detach = watchFlags.has('--detach')
    const stop = watchFlags.has('--stop')
    const status = watchFlags.has('--status')
    const force = watchFlags.has('--force')
    const reload = watchFlags.has('--reload')

    if (stop) {
      const { sendRequest } = await import('./mastra/daemon/client')
      await sendRequest({ op: 'shutdown', force }, { autoSpawn: false })
      console.log('daemon stopping')
      return
    }
    if (reload) {
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
            "daemon not running; use 'mars watch --detach' to start it",
          )
          process.exit(1)
        }
        throw err
      }
      return
    }
    if (status) {
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

    if (detach) {
      const { spawn } = await import('node:child_process')
      const { existsSync } = await import('node:fs')
      const { daemonPaths, resolveLaunchCommand } = await import(
        './mastra/daemon/paths'
      )
      const { socket } = daemonPaths()
      if (existsSync(socket)) {
        console.log('daemon already running')
        return
      }
      const { command, baseArgs } = resolveLaunchCommand()
      const child = spawn(command, [...baseArgs, '--repo', ctx.repoRoot, 'watch'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, MARS_REPO: ctx.repoRoot },
      })
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

  if (cmd === 'sweeper') {
    const sweeperFlags = new Set(rest.filter((a) => a.startsWith('--')))
    const intervalArg = flags['--interval-ms']
    const intervalMs = intervalArg ? Number.parseInt(intervalArg, 10) : undefined
    const oneShot = sweeperFlags.has('--once')
    const { startSweeper, runSweep } = await import('./mastra/sweeper/server')
    if (oneShot) {
      await runSweep((line) => console.log(line))
      return
    }
    await startSweeper({
      log: (line) => console.log(line),
      ...(Number.isInteger(intervalMs) && intervalMs! > 0 ? { intervalMs } : {}),
    })
    await new Promise(() => {})
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
    const { mastra } = await import('./mastra/index')
    const wf = mastra.getWorkflow('abExperimentWorkflow')
    const run = await wf.createRun()
    const result = await run.start({
      inputData: {
        instruction,
        variants: variantsJson,
        integrationBranch: branch,
      },
    })
    if (result.status !== 'success') {
      const err = 'error' in result && result.error instanceof Error
        ? result.error.message
        : '(no error message)'
      console.error(`ab experiment ${result.status}: ${err}`)
      process.exit(1)
    }
    const report = result.result as {
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
          totalCostUsd: number
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
      console.log(`  cost (USD):     ${v.usage.totalCostUsd.toFixed(4)}`)
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
      `\n${result.suggestions.length} suggestion(s) saved as draft ideas (source='reflection'). Review with 'mars idea list --source reflection' and promote with 'mars idea promote <id>'.`,
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

  if (cmd === 'next') {
    const json = rest.includes('--json')
    const { listIdeas } = await import('./mastra/ideas')
    const ideas = await listIdeas({ status: 'draft' })
    const drafts = ideas.map((i) => ({
      id: i.id,
      goal: i.goal,
      source: i.source,
      storySet: i.story.trim().length > 0,
      technicalSet: i.technical.trim().length > 0,
      acceptanceCount: i.acceptance.length,
    }))

    if (json) {
      console.log(JSON.stringify({ drafts }, null, 2))
      return
    }

    if (drafts.length === 0) {
      console.log('Nothing to refine. Create a draft with: mars idea add "<goal>"')
      return
    }

    console.log('Pick something to refine, or describe a new feature:\n')

    console.log('Existing drafts:')
    for (const d of drafts) {
      const goal = d.goal.trim() || '(no goal)'
      const flags: string[] = []
      flags.push(`source:${d.source}`)
      if (!d.storySet) flags.push('story:empty')
      if (!d.technicalSet) flags.push('technical:empty')
      if (d.acceptanceCount === 0) flags.push('acceptance:0')
      const tail = flags.length > 0 ? `  [${flags.join(' ')}]` : ''
      console.log(`  ${d.id.slice(0, 8)}  ${goal}${tail}`)
    }
    return
  }

  if (cmd === 'inbox') {
    const sub = rest[0]
    const inbox = await import('./mastra/lib/inbox')
    type InboxItem = Awaited<ReturnType<typeof inbox.listInboxItems>>[number]

    const printList = (rows: InboxItem[]): void => {
      if (rows.length === 0) {
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

    if (sub === undefined || sub === 'list') {
      const stateRaw = sub === 'list' ? rest[1] : 'open'
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
          `usage: mars inbox list [open|acknowledged|resolved|dismissed|all]`,
        )
        process.exit(1)
      }
      const rows = await inbox.listInboxItems(state as never)
      printList(rows)
      return
    }

    if (sub === 'show') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars inbox show <id>')
        process.exit(1)
      }
      const item = await inbox.getInboxItem(id)
      if (!item) {
        console.error(`no inbox item matching ${id}`)
        process.exit(1)
      }
      printShow(item)
      return
    }

    if (sub === 'ack' || sub === 'resolve' || sub === 'dismiss') {
      const id = rest[1]
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
        console.error(`no inbox item matching ${id}`)
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
      'usage: mars inbox [list [state] | show <id> | ack <id> | resolve <id> [--note <text>] [--root-cause <text>] | dismiss <id> [--note <text>] | watch]',
    )
    process.exit(1)
  }

  if (cmd === 'triage') {
    const id = rest[0]
    const { runTriage } = await import('./mastra/workflows/triage-workflow')
    if (id) {
      const result = await runTriage(id)
      console.log(
        `[${result.taskId}] actionable=${result.actionable} blockers=${result.blockerCount} suggestions=${result.suggestionCount}`,
      )
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
        console.log(
          `[${v.taskId}] actionable=${v.result.actionable} blockers=${v.result.blockerCount} suggestions=${v.result.suggestionCount}`,
        )
      } else {
        console.log(`[${v.taskId}] error: ${v.error}`)
      }
    }
    return
  }

  if (cmd === 'blockers') {
    const id = rest[0]
    if (!id) {
      console.error('usage: mars blockers <task-id>')
      process.exit(1)
    }
    const { listBlockers, getTask } = await import('./mastra/queue')
    const blockerIds = await listBlockers(id)
    if (blockerIds.length === 0) {
      console.log(`task ${id} has no incomplete blockers`)
      return
    }
    for (const bid of blockerIds) {
      const t = await getTask(bid)
      if (!t) {
        console.log(`${bid}\t(missing)`)
        continue
      }
      console.log(`${t.id}\t${t.status}\t${t.prompt.slice(0, 60)}`)
    }
    return
  }

  console.error(`unknown command: ${cmd}`)
  console.log(usage)
  process.exit(1)
}

await main()
process.exit(0)
