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
  run                           dispatch all queued tasks (unlimited parallel);
                                also runs the triage watcher for drafts
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
  feature list [status]         list features from .mars/state.db (read-only)
  feature show <id>             show a single feature from .mars/state.db (read-only)
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

const main = async (): Promise<void> => {
  const { repo, flags, positional } = parseArgs(process.argv.slice(2))
  const cmd = positional[0]
  const rest = positional.slice(1)

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
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
    const { enqueueTask } = await import('./mastra/queue')
    const plan =
      functional !== undefined || technical !== undefined
        ? { functional: functional ?? '', technical: technical ?? '' }
        : undefined
    const task = await enqueueTask(prompt, plan)
    console.log(`drafted ${task.id}`)
    return
  }

  if (cmd === 'set-functional' || cmd === 'set-technical') {
    const id = rest[0]
    const value = rest.slice(1).join(' ')
    if (!id || !value) {
      console.error(`usage: mars ${cmd} <id> <text|@file>`)
      process.exit(1)
    }
    const { getTask, updateTask } = await import('./mastra/queue')
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
    await updateTask(id, { plan: next })
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
    const { getTask, updateTask, deleteTask } = await import('./mastra/queue')
    const task = await getTask(id)
    if (!task) {
      console.error(`task ${id} not found`)
      process.exit(1)
    }
    if (task.status !== 'failed' && task.status !== 'done') {
      const reason =
        cmd === 'retry'
          ? `only failed/done tasks can be retried`
          : `refuse to purge in-flight tasks`
      console.error(`task ${id} is ${task.status}; ${reason}`)
      process.exit(1)
    }

    const { existsSync } = await import('node:fs')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { removeWorktree } = await import('./mastra/lib/git')
    const { getRepoRoot } = await import('./mastra/context')

    const branch = task.branch ?? `task/${task.id}`
    if (task.worktreePath && existsSync(task.worktreePath)) {
      await removeWorktree({ path: task.worktreePath, branch }, true).catch(() => {})
    }
    await exec('git', ['branch', '-D', branch], { cwd: getRepoRoot() }).catch(
      () => {},
    )

    if (cmd === 'retry') {
      await updateTask(id, {
        status: 'queued',
        branch: null,
        worktreePath: null,
        claudeSessionId: null,
        error: null,
      })
      console.log(`queued ${id} for retry`)
    } else {
      await deleteTask(id)
      console.log(`purged ${id}`)
    }
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

  if (cmd === 'run') {
    const { mastra } = await import('./mastra/index')
    const { getTask } = await import('./mastra/queue')
    const { startTriageWatcher } = await import('./mastra/watcher-triage')
    const branch = process.env.INTEGRATION_BRANCH ?? 'integration'

    const triageWatcher = startTriageWatcher()

    const queued = await listTasks('queued')
    if (queued.length === 0) {
      const drafts = await listTasks('draft')
      if (drafts.length > 0) {
        console.log(
          `no queued tasks (${drafts.length} draft(s) — triage running; check 'mars list draft')`,
        )
      } else {
        console.log('no queued tasks')
      }
      await triageWatcher.stop()
      return
    }
    const wf = mastra.getWorkflow('implementWorkflow')
    const runs = queued.map(async (task) => {
      const run = await wf.createRun()
      const result = await run.start({
        inputData: {
          taskId: task.id,
          prompt: task.prompt,
          plan: task.plan,
          integrationBranch: branch,
        },
      })
      return { task, result }
    })
    const results = await Promise.allSettled(runs)
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { task, result } = r.value
        const persisted = await getTask(task.id)
        const queueSuffix = persisted ? ` (queue: ${persisted.status})` : ''
        if (result.status === 'success') {
          const merge = result.result as
            | { success?: boolean; message?: string }
            | undefined
          const outcome = merge?.success ? 'ok' : 'aborted'
          const message = merge?.message ?? '(no message)'
          console.log(`[${task.id}] ${outcome}: ${message}${queueSuffix}`)
        } else {
          const errMessage =
            'error' in result && result.error instanceof Error
              ? result.error.message
              : undefined
          const tail = errMessage ? `: ${errMessage}` : ''
          console.log(`[${task.id}] ${result.status}${tail}${queueSuffix}`)
        }
      } else {
        console.error('run rejected:', r.reason)
      }
    }
    await triageWatcher.stop()
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
    if (sub === 'list') {
      const status = rest[1] as never
      const { listFeatures } = await import('./mastra/features')
      const features = await listFeatures(status)
      for (const f of features) {
        console.log(`${f.id}\t${f.status}\t${f.goal}`)
      }
      return
    }
    if (sub === 'show') {
      const id = rest[1]
      if (!id) {
        console.error('usage: mars feature show <id>')
        process.exit(1)
      }
      const { getFeature } = await import('./mastra/features')
      const f = await getFeature(id)
      if (!f) {
        console.error(`feature ${id} not found`)
        process.exit(1)
      }
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
    console.error('usage: mars feature <list [status]|show <id>>')
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
    if (corpus.length === 0) {
      console.log('no completed tasks in window — nothing to reflect on')
      return
    }
    console.log(`reflecting over ${corpus.length} task(s)…`)
    const result = await runReflector(corpus)
    if (result.suggestions.length === 0) {
      console.log('no suggestions produced')
      if (result.exitCode !== 0) {
        console.error(`reflector exit code ${result.exitCode}`)
      }
      return
    }
    const sourceTaskId = `reflect-${new Date().toISOString()}`
    await persistSuggestions(result.suggestions, sourceTaskId)
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
    const { promoteSuggestion } = await import('./mastra/queue-suggestions')
    const r = await promoteSuggestion(id)
    if (!r) {
      console.error(`suggestion ${id} not found or already promoted`)
      process.exit(1)
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
