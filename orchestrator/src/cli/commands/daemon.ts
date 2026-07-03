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
  const { logFile } = daemonPaths()
  deps.out(`[mars] daemon detached (pid ${child.pid}, log: ${logFile})`)
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
      const { startDaemon } = await import('../../core/daemon/server')
      await startDaemon({ log: (line) => deps.out(line) })
      // Block until SIGINT/SIGTERM (the daemon handles shutdown).
      await new Promise(() => {})
      return { code: 0 }
    }
    const liveness = await isDaemonAlive()
    if (liveness.alive) {
      const { logFile } = daemonPaths()
      deps.out(`[mars] daemon detached (pid ${liveness.pid}, log: ${logFile})`)
      return { code: 0 }
    }
    spawnDetached(deps)
    return { code: 0 }
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
    return { code: 0 }
  },
}

const daemonGroup: Command = {
  path: 'daemon',
  summary: 'daemon subcommands',
  usage:
    'usage: mars daemon <start|stop|restart|kill|status|reload|set-flag|pause|resume> [flags]',
  run: (_args, deps) => {
    deps.err(
      'usage: mars daemon <start|stop|restart|kill|status|reload|set-flag|pause|resume> [flags]',
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
  daemonPause,
  daemonResume,
  daemonGroup,
]
