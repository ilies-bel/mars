#!/usr/bin/env node
import { MARS_VERSION } from './version'
import { parseArgs, hasFlag } from './cli/args'
import { registry } from './cli/commands'
import { dispatch, isUnknown, makeProductionDeps } from './cli/dispatch'
import { renderCommandHelp, renderTopLevelHelp } from './cli/help'

const swallowEpipe = (err: NodeJS.ErrnoException): void => {
  if (err.code === 'EPIPE') return
}
process.stdout.on('error', swallowEpipe)
process.stderr.on('error', swallowEpipe)

const HELP_FLAGS = new Set(['--help', '-h', 'help'])

const printCommandHelp = (path: string): boolean => {
  const command = registry.get(path)
  if (!command) return false
  console.log(renderCommandHelp(registry, command))
  return true
}

/**
 * Normalise the legacy `mars daemon --detach` / `mars daemon --stop` flag-forms
 * to their canonical subcommand names before routing, so the registry router
 * stays a pure prefix match. `--detach` → `start`, `--stop` → `stop`.
 */
const normalizeDaemonAliases = (positional: string[]): string[] => {
  if (positional[0] !== 'daemon') return positional
  const sub = positional[1]
  if (sub === '--detach') return ['daemon', 'start', ...positional.slice(2)]
  if (sub === '--stop') return ['daemon', 'stop', ...positional.slice(2)]
  return positional
}

/** Resolve the DB target for the best-effort CLI trace without creating `.mars/`. */
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

/** Record a best-effort CLI trace after a command returns. */
const emitCliInvocationTrace = async (
  repo: string | undefined,
  command: string,
  flags: Record<string, string>,
  exitCode: number,
  startMs: number,
): Promise<void> => {
  if (command === 'cut' || command.startsWith('cut ')) return
  const { isReflectDisabled } = await import('./core/lib/reflect-signals')
  if (isReflectDisabled()) return
  const dbTarget = await findReachableDbTarget(repo)
  if (!dbTarget) return
  const { openTraceEventStore } = await import('./core/lib/trace-events-store')
  const { detectOriginSession } = await import('./core/author')
  const truncatedFlags: Record<string, string> = {}
  for (const [key, value] of Object.entries(flags)) {
    truncatedFlags[key] = String(value ?? '').slice(0, 200)
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

  if (rawArgv.includes('--version') || rawArgv.includes('-v')) {
    console.log(MARS_VERSION)
    return 0
  }

  const parsed = parseArgs(rawArgv)
  const positional = normalizeDaemonAliases(parsed.positional)
  const cmd = positional[0]
  const rest = positional.slice(1)

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const target = rest[0]
    if (target && printCommandHelp(target)) return 0
    console.log(renderTopLevelHelp(registry))
    return 0
  }

  if (rest.some((arg) => HELP_FLAGS.has(arg)) || hasFlag(parsed, '--help') || hasFlag(parsed, '-h')) {
    const subTokens = rest.filter((arg) => !HELP_FLAGS.has(arg))
    if (subTokens.length > 0 && printCommandHelp(`${cmd} ${subTokens.join(' ')}`)) return 0
    if (printCommandHelp(cmd)) return 0
    console.log(renderTopLevelHelp(registry))
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
    console.log(renderTopLevelHelp(registry))
  }
  return exitCode
}

let exitCode = 0
try {
  exitCode = await main()
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`error: ${message}`)
  exitCode = 1
}
process.exit(exitCode)
