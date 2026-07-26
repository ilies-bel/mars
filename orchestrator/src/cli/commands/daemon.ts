/**
 * `daemon` command group: `start`, `stop`, `restart`, `kill`, `status`,
 * `reload`, `set-flag`, plus the group fallback. Legacy flag-form aliases
 * (`mars daemon --detach` / `--stop`) are normalised by the group fallback,
 * which re-dispatches to the canonical leaf.
 *
 * All daemon-control RPCs require the daemon to be running — they never
 * auto-spawn it. This is the global default; see client.ts sendRequest().
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  patchDaemonConfigFile,
  persistLeverAutonomyLevel,
  readDaemonConfigFile,
} from '../../core/daemon/config'
import type { AutonomyLevel } from '../../core/daemon/config'
import {
  daemonPaths,
  isDaemonAlive,
  resolveLaunchCommand,
} from '../../core/daemon/paths'
import type { Command, CommandDeps } from '../command'
import { errorMessage, isDaemonDownError } from './shared'

const spawnDetached = (deps: CommandDeps): void => {
  const { command, baseArgs } = resolveLaunchCommand()
  const child = spawn(
    command,
    [...baseArgs, '--repo', deps.ctx.repoRoot, 'daemon', 'start', '--foreground'],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MARS_REPO: deps.ctx.repoRoot },
    },
  )
  child.unref()
}

/**
 * Poll `isDaemonAlive()` at 100ms intervals until the daemon's socket is
 * connectable or the 10s deadline is exceeded.
 *
 * On success: prints the canonical `[mars] daemon detached (pid …)` message
 * and returns `{ code: 0 }`.  On timeout: prints an error pointing at the
 * watch.log boot log and returns `{ code: 1 }`.
 *
 * Called by both `daemonStart` (after the first spawn) and `daemonRestart`
 * (after stop + respawn), so the poll loop lives here rather than inlined.
 */
const waitForDaemonReady = async (deps: CommandDeps): Promise<{ code: number }> => {
  const { logFile } = daemonPaths()
  const POLL_INTERVAL_MS = 100
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))
    const check = await isDaemonAlive()
    if (check.alive) {
      deps.out(`[mars] daemon detached (pid ${check.pid}, log: ${logFile})`)
      return { code: 0 }
    }
  }
  deps.err(
    `[mars] daemon did not become ready within 10s; check ${logFile}`,
  )
  return { code: 1 }
}

const daemonStop: Command = {
  path: 'daemon stop',
  summary: 'drain-stop the daemon (--force to abandon in-flight)',
  usage: 'usage: mars daemon stop [--force]',
  run: async (args, deps) => {
    const force = args.positional.includes('--force')
    try {
      if (force) {
        await deps.daemon.sendRequest(
          { op: 'shutdown', force: true },
        )
        deps.out('daemon stopping (force; in-flight tasks abandoned)')
        return { code: 0 }
      }
      const data = (await deps.daemon.sendRequest(
        { op: 'shutdown', drain: true },
      )) as { inFlight: number; draining: boolean }
      if (data.inFlight === 0) {
        deps.out('daemon stopping')
      } else {
        deps.out(
          `daemon draining: stopped accepting new work; waiting on ${data.inFlight} in-flight task(s). Run \`mars daemon kill\` to abort.`,
        )
      }
    } catch (err) {
      const msg = errorMessage(err)
      if (isDaemonDownError(msg)) {
        deps.err('daemon not running')
        return { code: 1 }
      }
      throw err
    }
    return { code: 0 }
  },
}

const daemonKill: Command = {
  path: 'daemon kill',
  summary: 'hard-kill the daemon and abort in-flight tasks',
  usage: 'usage: mars daemon kill',
  run: async (_args, deps) => {
    try {
      const data = (await deps.daemon.sendRequest(
        { op: 'kill' },
      )) as { killed: ReadonlyArray<{ taskId: string; kind: string }> }
      if (data.killed.length === 0) {
        deps.out('daemon killed (no in-flight tasks)')
      } else {
        deps.out(`daemon killed; aborted ${data.killed.length} in-flight task(s):`)
        for (const t of data.killed) deps.out(`  ${t.kind} ${t.taskId}`)
      }
    } catch (err) {
      const msg = errorMessage(err)
      // Connection reset is the expected outcome — the daemon kills its
      // process group immediately after responding.
      if (/ECONNRESET|EPIPE|socket hang up/i.test(msg)) {
        deps.out('daemon killed')
        return { code: 0 }
      }
      if (isDaemonDownError(msg)) {
        deps.err('daemon not running')
        return { code: 1 }
      }
      throw err
    }
    return { code: 0 }
  },
}

const daemonReload: Command = {
  path: 'daemon reload',
  summary: 'reload concurrency caps without restarting',
  usage: 'usage: mars daemon reload',
  run: async (_args, deps) => {
    try {
      const data = (await deps.daemon.sendRequest(
        { op: 'reload-config' },
      )) as {
        caps: {
          implement: number
          triage: number
          refine: number
          'structured-write': number
        }
      }
      deps.out(
        `concurrency reloaded: implement=${data.caps.implement} triage=${data.caps.triage} refine=${data.caps.refine} structured-write=${data.caps['structured-write']}`,
      )
    } catch (err) {
      const msg = errorMessage(err)
      if (isDaemonDownError(msg)) {
        deps.err("daemon not running; use 'mars daemon start' to start it")
        return { code: 1 }
      }
      throw err
    }
    return { code: 0 }
  },
}

const daemonSetFlag: Command = {
  path: 'daemon set-flag',
  summary: 'toggle a daemon flag (on|off)',
  usage: 'usage: mars daemon set-flag <flag> <on|off>',
  run: async (args, deps) => {
    const positional = args.positional.filter((a) => !a.startsWith('--'))
    const flag = positional[0]
    const value = positional[1]
    if (!flag || !value) {
      deps.err('usage: mars daemon set-flag <flag> <on|off>')
      return { code: 2 }
    }
    if (value !== 'on' && value !== 'off') {
      deps.err(`mars daemon set-flag: value must be 'on' or 'off'; got '${value}'`)
      return { code: 2 }
    }
    try {
      const data = (await deps.daemon.sendRequest(
        { op: 'set-flag', flag, value },
      )) as { flag: string; value: string }
      deps.out(`flag ${data.flag}=${data.value}`)
    } catch (err) {
      const msg = errorMessage(err)
      if (isDaemonDownError(msg)) {
        deps.err("daemon not running; use 'mars daemon start' to start it")
        return { code: 1 }
      }
      throw err
    }
    return { code: 0 }
  },
}

const daemonPause: Command = {
  path: 'daemon pause',
  summary: 'suspend dispatch (in-flight tasks continue; daemon stays alive)',
  usage: 'usage: mars daemon pause',
  run: async (_args, deps) => {
    try {
      const data = (await deps.daemon.sendRequest(
        { op: 'pause' },
      )) as { paused: boolean; inFlight: number }
      deps.out(
        `daemon paused: dispatch suspended (${data.inFlight} task(s) in flight). Run \`mars daemon resume\` to resume.`,
      )
    } catch (err) {
      const msg = errorMessage(err)
      if (isDaemonDownError(msg)) {
        deps.err("daemon not running; use 'mars daemon start' to start it")
        return { code: 1 }
      }
      throw err
    }
    return { code: 0 }
  },
}

const daemonResume: Command = {
  path: 'daemon resume',
  summary: 'resume dispatch after a pause',
  usage: 'usage: mars daemon resume',
  run: async (_args, deps) => {
    try {
      await deps.daemon.sendRequest({ op: 'resume' })
      deps.out('daemon resumed: dispatch re-enabled')
    } catch (err) {
      const msg = errorMessage(err)
      if (isDaemonDownError(msg)) {
        deps.err("daemon not running; use 'mars daemon start' to start it")
        return { code: 1 }
      }
      throw err
    }
    return { code: 0 }
  },
}

const daemonStatus: Command = {
  path: 'daemon status',
  summary: 'print daemon pid, counts, and in-flight tasks',
  usage: 'usage: mars daemon status',
  run: async (_args, deps) => {
    const liveness = await isDaemonAlive()
    if (!liveness.alive) {
      deps.err(`daemon not running (${liveness.reason})`)
      return { code: 1 }
    }
    const data = (await deps.daemon.sendRequest(
      { op: 'status' },
    )) as {
      pid: number
      startedAt: string
      inFlight: ReadonlyArray<{ taskId: string; kind: string }>
      counts: Record<string, number>
      sourceSha: string | null
      currentSha: string | null
      isStale: boolean
      isPaused: boolean
    }
    if (data.isPaused) {
      deps.out('⏸ PAUSED — dispatch suspended; run `mars daemon resume` to resume')
    }
    deps.out(`pid:        ${data.pid}`)
    deps.out(`startedAt:  ${data.startedAt}`)
    deps.out(
      `counts:     draft=${data.counts.draft} queued=${data.counts.queued} running=${data.counts.running} verifying=${data.counts.verifying} merging=${data.counts.merging} vega-reconciling=${data.counts['vega-reconciling']}`,
    )
    deps.out(`inFlight:   ${data.inFlight.length}`)
    for (const f of data.inFlight) deps.out(`  ${f.kind} ${f.taskId}`)
    if (data.isStale && data.sourceSha !== null && data.currentSha !== null) {
      deps.out(
        `⚠ running code from ${data.sourceSha.slice(0, 7)}; HEAD is now ${data.currentSha.slice(0, 7)} — run \`mars daemon restart\``,
      )
    }
    return { code: 0 }
  },
}

const daemonStart: Command = {
  path: 'daemon start',
  summary: 'start the daemon (detached, or --foreground)',
  usage: 'usage: mars daemon start [--foreground]',
  run: async (args, deps) => {
    const foreground = args.positional.includes('--foreground')
    if (foreground) {
      const { logFile } = daemonPaths()
      const writeBootLog = (msg: string): void => {
        try {
          mkdirSync(dirname(logFile), { recursive: true })
          appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`)
        } catch {
          // ignore — still surface the error below
        }
      }
      try {
        const { startDaemon } = await import('../../core/daemon/server')
        await startDaemon({ log: (line) => deps.out(line) })
        // Block until SIGINT/SIGTERM (the daemon handles shutdown).
        await new Promise(() => {})
      } catch (err) {
        const msg =
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        // Write to watch.log before re-throwing so early-boot crashes are
        // visible even when the process is running detached (daemon mode)
        // and stderr is not captured.  The regular daemon logger attaches
        // only after server.ts imports succeed, so any module-level error
        // (e.g. stale @mars/workflow dist) would otherwise leave watch.log
        // empty and be diagnosable only via --foreground.
        writeBootLog(`[mars] daemon boot failed: ${msg}`)
        throw err
      }
      return { code: 0 }
    }
    const liveness = await isDaemonAlive()
    if (liveness.alive) {
      const { logFile } = daemonPaths()
      deps.out(`[mars] daemon detached (pid ${liveness.pid}, log: ${logFile})`)
      return { code: 0 }
    }
    spawnDetached(deps)
    // Block until the daemon's socket is connectable. This closes the TOCTOU
    // race: a second `daemon start` racing within the boot window will call
    // isDaemonAlive(), find a live socket, and take the idempotent branch
    // above instead of spawning a second child.
    return waitForDaemonReady(deps)
  },
}

const daemonRestart: Command = {
  path: 'daemon restart',
  summary: 'force-stop then start a fresh daemon',
  usage: 'usage: mars daemon restart',
  run: async (_args, deps) => {
    const liveness = await isDaemonAlive()
    if (liveness.alive) {
      try {
        await deps.daemon.sendRequest(
          { op: 'shutdown', force: true },
        )
      } catch (err) {
        const msg = errorMessage(err)
        if (!isDaemonDownError(msg)) throw err
      }
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        const check = await isDaemonAlive()
        if (!check.alive) break
      }
    }
    spawnDetached(deps)
    return waitForDaemonReady(deps)
  },
}

/**
 * Maps the kebab-case CLI cap names to their camelCase JSON keys in daemon.json.
 * `loadDaemonConfig` reads both spellings; we always write camelCase for consistency.
 */
const CAP_NAME_MAP: Readonly<Record<string, string>> = {
  implement: 'implement',
  triage: 'triage',
  refine: 'refine',
  'structured-write': 'structuredWrite',
  'setup-install': 'setupInstall',
}

const daemonSetCap: Command = {
  path: 'daemon set-cap',
  summary: 'set a concurrency cap and hot-reload into the running daemon',
  usage: 'usage: mars daemon set-cap <name> <n>',
  run: async (args, deps) => {
    const positional = args.positional.filter((a) => !a.startsWith('--'))
    const name = positional[0]
    const rawN = positional[1]
    if (!name || !rawN) {
      deps.err('usage: mars daemon set-cap <name> <n>')
      return { code: 2 }
    }
    const capKey = CAP_NAME_MAP[name]
    if (capKey === undefined) {
      deps.err(
        `mars daemon set-cap: unknown cap '${name}'; valid names: ${Object.keys(CAP_NAME_MAP).join(', ')}`,
      )
      return { code: 2 }
    }
    const n = Number(rawN)
    if (!Number.isInteger(n) || n <= 0) {
      deps.err(`mars daemon set-cap: <n> must be a positive integer; got '${rawN}'`)
      return { code: 2 }
    }
    const current = readDaemonConfigFile()
    const existingCaps =
      current.caps !== null &&
      typeof current.caps === 'object' &&
      !Array.isArray(current.caps)
        ? (current.caps as Record<string, unknown>)
        : {}
    patchDaemonConfigFile({ caps: { ...existingCaps, [capKey]: n } })
    try {
      const data = (await deps.daemon.sendRequest({ op: 'reload-config' })) as {
        caps: {
          implement: number
          triage: number
          refine: number
          'structured-write': number
        }
      }
      deps.out(
        `concurrency reloaded: implement=${data.caps.implement} triage=${data.caps.triage} refine=${data.caps.refine} structured-write=${data.caps['structured-write']}`,
      )
    } catch (err) {
      const msg = errorMessage(err)
      if (isDaemonDownError(msg)) {
        deps.out(`cap ${name}=${n} written; will apply on next daemon start`)
        return { code: 0 }
      }
      throw err
    }
    return { code: 0 }
  },
}

const VALID_AUTONOMY_LEVELS = new Set<string>(['off', 'ask', 'silent'])

const daemonSetLever: Command = {
  path: 'daemon set-lever',
  summary: 'set a lever property (autonomy: off|ask|silent)',
  usage: 'usage: mars daemon set-lever <name> autonomy <off|ask|silent>',
  run: async (args, deps) => {
    const positional = args.positional.filter((a) => !a.startsWith('--'))
    const name = positional[0]
    const prop = positional[1]
    const value = positional[2]
    if (!name || prop !== 'autonomy' || !value) {
      deps.err('usage: mars daemon set-lever <name> autonomy <off|ask|silent>')
      return { code: 2 }
    }
    if (!VALID_AUTONOMY_LEVELS.has(value)) {
      deps.err(
        `mars daemon set-lever: autonomy must be 'off', 'ask', or 'silent'; got '${value}'`,
      )
      return { code: 2 }
    }
    persistLeverAutonomyLevel(name, value as AutonomyLevel)
    deps.out(`lever ${name} autonomy=${value}`)
    return { code: 0 }
  },
}

const daemonGroup: Command = {
  path: 'daemon',
  summary: 'daemon subcommands',
  usage:
    'usage: mars daemon <start|stop|restart|kill|status|reload|set-flag|set-cap|set-lever|pause|resume> [flags]',
  run: (_args, deps) => {
    deps.err(
      'usage: mars daemon <start|stop|restart|kill|status|reload|set-flag|set-cap|set-lever|pause|resume> [flags]',
    )
    return { code: 2 }
  },
}

export const daemonCommands: readonly Command[] = [
  daemonStart,
  daemonStop,
  daemonRestart,
  daemonKill,
  daemonStatus,
  daemonReload,
  daemonSetFlag,
  daemonSetCap,
  daemonSetLever,
  daemonPause,
  daemonResume,
  daemonGroup,
]
