#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolveContext } from './mastra/context'

interface ParsedArgs {
  repo?: string
  flags: Record<string, string>
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
])

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positional: string[] = []
  const flags: Record<string, string> = {}
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
      flags[key] = value
      continue
    }
    positional.push(a)
  }
  return { repo, flags, positional }
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
  add "<prompt>" [plan flags]   draft a task (lands in 'draft' state; triage
                                promotes it to 'queued' once actionable)
  set-functional <id> <text|@file>
                                set the functional plan on a draft/queued task
  set-technical <id> <text|@file>
                                set the technical plan on a draft/queued task
  show <id>                     print full task incl. plan sections
  list [status]                 list tasks (draft|queued|running|verifying|merging|done|failed)
  retry <id>                    re-queue a failed/done task (cleans worktree+branch)
  purge <id>                    delete a failed/done task entirely (worktree+branch+row)
  watch [--detach|--stop|--status|--force]
                                run the orchestration daemon (foreground by default);
                                CLI write ops auto-spawn it. --detach forks to
                                background; --stop asks daemon to exit (refuses
                                if tasks are in flight unless --force); --status
                                prints inFlight + queue counts.
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
  feature list [status]         list ideas from .mars/state.db merged with on-disk
                                features/*.md drafts (de-duped by id)
  feature show <id>             show an idea from .mars/state.db; falls back to
                                features/<id>.md if not in DB
  feature new "<goal>"          create a new idea row in .mars/state.db; prints id
  feature set <id> <field> <value>
                                update an idea field (goal|story|technical|status)
  feature add-acceptance <id> "<bullet>"
                                append a bullet to the idea's acceptance list
  feature remove-acceptance <id> <index>
                                remove the bullet at 0-based index, repacks positions
  feature export <id> [--out <path>]
                                render an idea as markdown (frontmatter + Goal +
                                Story + Acceptance + Technical) to stdout or file
  feature delete <id>           remove an idea from .mars/state.db (does not
                                touch features/*.md)
  reflect [--since <iso>] [--limit <n>]
                                synthesize draft task suggestions from recent
                                completed tasks. Reads token + scorer signals
                                from .mars/queue.db and .mars/mastra.db.
                                Default: last 10 completed tasks. Suggestions
                                are inserted as proposals — never auto-run.
                                Disable signal capture entirely with the env
                                var MARS_REFLECT_DISABLED=1.
  suggestions [status]          list reflection suggestions (status defaults
                                to all; common values: proposed, accepted)
  promote <suggestion-id>       enqueue a suggestion as a task; marks the
                                suggestion accepted and links the new task id
  where                         print resolved repo + state directory
  help                          show this message

Plan flags for 'add':
  --functional <text|@file>     functional plan text (or @path to read a file)
  --func <text|@file>           alias for --functional
  --technical <text|@file>      technical plan text (or @path to read a file)
  --tech <text|@file>           alias for --technical
  --functional-file <path>      read functional plan from a file
  --technical-file <path>       read technical plan from a file

Repo resolution (in priority order):
  1. --repo <path>
  2. \$MARS_REPO env var
  3. \`git rev-parse --show-toplevel\` from cwd

Other env:
  INTEGRATION_BRANCH       target branch for merges (default: integration)
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
  add: `mars add "<prompt>" [plan flags]

Draft a task. Lands in 'draft' state; triage promotes it to 'queued' once
actionable.

Plan flags:
  --functional <text|@file>   functional plan text (or @path to read a file)
  --func <text|@file>         alias for --functional
  --technical <text|@file>    technical plan text (or @path to read a file)
  --tech <text|@file>         alias for --technical
  --functional-file <path>    read functional plan from a file
  --technical-file <path>     read technical plan from a file`,
  'set-functional': `mars set-functional <id> <text|@file>

Set the functional plan on a draft/queued task. Use @path to read from a
file.`,
  'set-technical': `mars set-technical <id> <text|@file>

Set the technical plan on a draft/queued task. Use @path to read from a
file.`,
  show: `mars show <id>

Print full task incl. plan sections.`,
  list: `mars list [status]

List tasks. Status one of: draft, queued, running, verifying, merging,
done, failed. Defaults to all when omitted.`,
  retry: `mars retry <id>

Re-queue a failed/done task. Cleans the worktree and branch first.`,
  purge: `mars purge <id>

Delete a failed/done task entirely (worktree + branch + row). Refuses
in-flight tasks.`,
  watch: `mars watch [--detach|--stop|--status|--force]

Run the orchestration daemon (foreground by default). CLI write ops
auto-spawn it.

Flags:
  --detach   fork to background
  --stop     ask the daemon to exit (refuses if tasks are in flight)
  --status   print inFlight + queue counts
  --force    with --stop, exit even if tasks are in flight`,
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
  feature: `mars feature <subcommand> ...

Subcommands:
  list [status]                       list ideas merged with on-disk drafts
  show <id>                           show an idea (falls back to features/<id>.md)
  new "<goal>"                        create a new idea row; prints id
  set <id> <field> <value>            update goal|story|technical|status
  add-acceptance <id> "<bullet>"      append an acceptance bullet
  remove-acceptance <id> <index>      remove the bullet at 0-based index
  export <id> [--out <path>]          render an idea as markdown
  delete <id>                         remove an idea from .mars/state.db`,
  reflect: `mars reflect [--since <iso>] [--limit <n>]

Synthesize draft task suggestions from recent completed tasks. Reads
token + scorer signals from .mars/queue.db and .mars/mastra.db. Default:
last 10 completed tasks. Suggestions are inserted as proposals — never
auto-run. Disable signal capture entirely with the env var
MARS_REFLECT_DISABLED=1.

Flags:
  --since <iso>   only reflect on tasks completed after this ISO timestamp
  --limit <n>     max number of tasks to include (default: 10)`,
  suggestions: `mars suggestions [status]

List reflection suggestions. Status defaults to all; common values:
proposed, accepted.`,
  promote: `mars promote <suggestion-id>

Enqueue a suggestion as a task; marks the suggestion accepted and links
the new task id.`,
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
  const { repo, flags, positional } = parseArgs(process.argv.slice(2))
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

  if (cmd === 'add') {
    const prompt = rest.join(' ')
    if (!prompt) {
      console.error('prompt required')
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
    const { sendRequest } = await import('./mastra/daemon/client')
    const task = (await sendRequest(
      { op: 'add', prompt, plan },
      {
        onSpawnNotice: (pid, log) =>
          console.log(`[mars] started daemon (pid ${pid}, log: ${log})`),
      },
    )) as { id: string; status: string }
    console.log(`${task.status === 'queued' ? 'queued' : 'drafted'} ${task.id}`)
    return
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
    const { getTask } = await import('./mastra/queue')
    const task = await getTask(id)
    if (!task) {
      console.error(`task ${id} not found`)
      process.exit(1)
    }
    console.log(`id:         ${task.id}`)
    console.log(`status:     ${task.status}`)
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
    return
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

  const { listTasks } = await import('./mastra/queue')

  if (cmd === 'list') {
    const tasks = await listTasks(rest[0] as never)
    for (const t of tasks) {
      console.log(`${t.id}\t${t.status}\t${t.prompt.slice(0, 60)}`)
    }
    return
  }

  if (cmd === 'watch') {
    const watchFlags = new Set(rest.filter((a) => a.startsWith('--')))
    const detach = watchFlags.has('--detach')
    const stop = watchFlags.has('--stop')
    const status = watchFlags.has('--status')
    const force = watchFlags.has('--force')

    if (stop) {
      const { sendRequest } = await import('./mastra/daemon/client')
      await sendRequest({ op: 'shutdown', force }, { autoSpawn: false })
      console.log('daemon stopping')
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
    const branch = process.env.INTEGRATION_BRANCH ?? 'integration'
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

  if (cmd === 'feature') {
    const sub = rest[0]

    if (sub === 'new') {
      const goal = rest[1]
      if (!goal) {
        console.error('usage: mars feature new "<goal>"')
        process.exit(1)
      }
      const { createIdea } = await import('./mastra/ideas')
      const idea = await createIdea(goal)
      console.log(idea.id)
      return
    }

    if (sub === 'list') {
      const status = rest[1]
      const { listFeatures } = await import('./mastra/features')
      const { listIdeas } = await import('./mastra/ideas')
      const { listFeatureMarkdownIds, readFeatureMarkdown } = await import(
        './mastra/feature-md'
      )
      const ideas = await listIdeas()
      const features = await listFeatures(status as never)
      const seen = new Set<string>()
      const rows: Array<{ id: string; status: string; goal: string }> = []
      for (const i of ideas) {
        if (status && i.status !== status) continue
        seen.add(i.id)
        rows.push({ id: i.id, status: i.status, goal: i.goal })
      }
      for (const f of features) {
        if (seen.has(f.id)) continue
        seen.add(f.id)
        rows.push({ id: f.id, status: f.status, goal: f.goal })
      }
      for (const id of listFeatureMarkdownIds()) {
        if (seen.has(id)) continue
        const md = readFeatureMarkdown(id)
        if (!md) continue
        if (status && md.status !== status) continue
        seen.add(id)
        rows.push({ id: md.id, status: md.status, goal: md.goal })
      }
      for (const r of rows) {
        console.log(`${r.id}\t${r.status}\t${r.goal}`)
      }
      return
    }

    if (sub === 'show') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars feature show <id>')
        process.exit(1)
      }
      const { getIdea } = await import('./mastra/ideas')
      const idea = await getIdea(id)
      if (idea) {
        console.log(`id:         ${idea.id}`)
        console.log(`status:     ${idea.status}`)
        console.log(`origin:     ${idea.origin}`)
        console.log(`createdAt:  ${new Date(idea.createdAt).toISOString()}`)
        console.log(`updatedAt:  ${new Date(idea.updatedAt).toISOString()}`)
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
      const { getFeature } = await import('./mastra/features')
      const f = await getFeature(id)
      if (f) {
        console.log(`id:         ${f.id}`)
        console.log(`status:     ${f.status}`)
        console.log(`origin:     ${f.origin}`)
        console.log(`parentId:   ${f.parentId ?? '-'}`)
        console.log(`taskCount:  ${f.taskCount} (ready: ${f.readyTaskCount})`)
        console.log(`storeId:    ${f.storeId ?? '-'}`)
        console.log(`createdAt:  ${f.createdAt}`)
        console.log(`updatedAt:  ${f.updatedAt}`)
        console.log(`goal:`)
        console.log(f.goal)
        return
      }
      const { readFeatureMarkdown } = await import('./mastra/feature-md')
      const md = readFeatureMarkdown(id)
      if (md) {
        console.log(`id:         ${md.id}`)
        console.log(`status:     ${md.status}`)
        console.log(`origin:     ${md.origin}`)
        console.log(`source:     features/${md.id}.md`)
        console.log(`goal:`)
        console.log(md.goal)
        if (md.story.trim().length > 0) {
          console.log(`story:`)
          console.log(md.story)
        }
        if (md.acceptance.length > 0) {
          console.log(`acceptance:`)
          md.acceptance.forEach((b, i) => console.log(`  [${i}] ${b}`))
        }
        if (md.technical.trim().length > 0) {
          console.log(`technical:`)
          console.log(md.technical)
        }
        return
      }
      console.error(`feature ${id} not found`)
      process.exit(1)
    }

    if (sub === 'set') {
      const id = rest[1]
      const field = rest[2]
      const value = rest[3]
      const allowed = new Set(['goal', 'story', 'technical', 'status'])
      if (!id || !field || value === undefined || !allowed.has(field)) {
        console.error(
          'usage: mars feature set <id> <goal|story|technical|status> <value>',
        )
        process.exit(1)
      }
      const { setIdeaField } = await import('./mastra/ideas')
      const ok = await setIdeaField(id, field as never, value)
      if (!ok) {
        console.error(`idea ${id} not found`)
        process.exit(1)
      }
      console.log(`updated ${id} ${field}`)
      return
    }

    if (sub === 'add-acceptance') {
      const id = rest[1]
      const text = rest[2]
      if (!id || !text) {
        console.error('usage: mars feature add-acceptance <id> "<bullet>"')
        process.exit(1)
      }
      const { addAcceptance } = await import('./mastra/ideas')
      const ok = await addAcceptance(id, text)
      if (!ok) {
        console.error(`idea ${id} not found`)
        process.exit(1)
      }
      console.log(`added acceptance to ${id}`)
      return
    }

    if (sub === 'remove-acceptance') {
      const id = rest[1]
      const idxRaw = rest[2]
      const idx = Number(idxRaw)
      if (!id || idxRaw === undefined || !Number.isInteger(idx) || idx < 0) {
        console.error(
          'usage: mars feature remove-acceptance <id> <index> (0-based)',
        )
        process.exit(1)
      }
      const { removeAcceptance } = await import('./mastra/ideas')
      const ok = await removeAcceptance(id, idx)
      if (!ok) {
        console.error(`idea ${id} not found, or index out of range`)
        process.exit(1)
      }
      console.log(`removed acceptance[${idx}] from ${id}`)
      return
    }

    if (sub === 'export') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars feature export <id> [--out <path>]')
        process.exit(1)
      }
      const { getIdea, renderIdeaMarkdown } = await import('./mastra/ideas')
      const idea = await getIdea(id)
      if (!idea) {
        console.error(`idea ${id} not found`)
        process.exit(1)
      }
      const md = renderIdeaMarkdown(idea)
      const out = flags['--out']
      if (out) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(out, md, 'utf8')
        console.log(`wrote ${out}`)
      } else {
        process.stdout.write(md)
      }
      return
    }

    if (sub === 'delete') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars feature delete <id>')
        process.exit(1)
      }
      const { deleteIdea } = await import('./mastra/ideas')
      const ok = await deleteIdea(id)
      if (!ok) {
        console.error(`idea ${id} not found`)
        process.exit(1)
      }
      console.log(`deleted ${id}`)
      return
    }

    console.error(
      'usage: mars feature <new|list|show|set|add-acceptance|remove-acceptance|export|delete> ...',
    )
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
      `\n${result.suggestions.length} suggestion(s) saved. Review with 'mars suggestions' and enqueue with 'mars promote <id>'.`,
    )
    return
  }

  if (cmd === 'suggestions') {
    const { listSuggestions } = await import('./mastra/queue-suggestions')
    const status = rest[0]
    const rows = await listSuggestions(status)
    if (rows.length === 0) {
      console.log(status ? `no suggestions with status=${status}` : 'no suggestions')
      return
    }
    for (const s of rows) {
      const link = s.createdTaskId ? ` -> task ${s.createdTaskId}` : ''
      console.log(`${s.id}\t${s.status}${link}\t${s.title}`)
    }
    return
  }

  if (cmd === 'promote') {
    const id = rest[0]
    if (!id) {
      console.error('usage: mars promote <suggestion-id>')
      process.exit(1)
    }
    const { sendRequest } = await import('./mastra/daemon/client')
    const r = (await sendRequest({ op: 'promote', suggestionId: id })) as {
      taskId: string
    }
    console.log(`drafted ${r.taskId} (from suggestion ${id})`)
    return
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
