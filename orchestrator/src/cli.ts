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
  init [--force] [--no-fetch] [--dry-run]
                                detect tech stack and generate specialized supervisors
                                in .mars/supervisors/ (skeleton + workflow contract).
  add "<prompt>" [plan flags]   enqueue a task (via enqueue-task tool)
  set-functional <id> <text|@file>
                                set the functional plan on a queued task
  set-technical <id> <text|@file>
                                set the technical plan on a queued task
  show <id>                     print full task incl. plan sections
  list [status]                 list tasks (queued|running|verifying|merging|done|failed)
  run                           dispatch all queued tasks (unlimited parallel)
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
    return
  }

  if (cmd === 'init') {
    const boolFlags = new Set(rest.filter((a) => a.startsWith('--')))
    const force = boolFlags.has('--force')
    const fetch = !boolFlags.has('--no-fetch')
    const dryRun = boolFlags.has('--dry-run')
    const { runInit } = await import('./mastra/workflows/init-workflow')
    const result = await runInit({ force, fetch, dryRun })

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
        console.log(`[${r.value.task.id}] ${r.value.result.status}`)
      } else {
        console.error('run rejected:', r.reason)
      }
    }
    return
  }

  console.error(`unknown command: ${cmd}`)
  console.log(usage)
  process.exit(1)
}

await main()
process.exit(0)
