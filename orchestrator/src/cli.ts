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
  add "<prompt>" [plan flags]   enqueue a task (via enqueue-task tool)
  set-functional <id> <text|@file>
                                set the functional plan on a queued task
  set-technical <id> <text|@file>
                                set the technical plan on a queued task
  show <id>                     print full task incl. plan sections
  list [status]                 list tasks (queued|running|verifying|merging|done|failed)
  retry <id>                    re-queue a failed/done task (cleans worktree+branch)
  purge <id>                    delete a failed/done task entirely (worktree+branch+row)
  run                           dispatch all queued tasks (unlimited parallel)
  feature list [status]         list features from .mars/state.db (read-only)
  feature show <id>             show a single feature from .mars/state.db (read-only)
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
  INTEGRATION_BRANCH    target branch for merges (default: integration)
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
    console.log(`queued ${task.id}`)
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
    if (task.status !== 'queued') {
      console.error(
        `task ${id} is ${task.status}; plan can only be modified while queued`,
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
    const branch = process.env.INTEGRATION_BRANCH ?? 'integration'
    const queued = await listTasks('queued')
    if (queued.length === 0) {
      console.log('no queued tasks')
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

  console.error(`unknown command: ${cmd}`)
  console.log(usage)
  process.exit(1)
}

await main()
process.exit(0)
