/**
 * `deploy logs` command.
 *
 * Fetches the raw log output for the latest deployment on a task from the
 * running daemon's `GET /deployments/:taskId/logs` route and streams it to
 * stdout. Exits non-zero when no deployment exists (404) or the daemon is not
 * running.
 *
 * Mirrors the thin CLI-over-daemon-HTTP pattern used by `self-update.ts`.
 */

import type { Command } from '../command'
import { readDaemonPort } from './shared'

const NO_DAEMON_MSG = 'deploy logs: daemon not running — run `mars daemon start` first'

const deployLogs: Command = {
  path: 'deploy logs',
  summary: 'print provider logs for the latest deployment on a task',
  usage: 'usage: mars deploy logs <taskId>',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    if (!taskId) {
      deps.err('usage: mars deploy logs <taskId>')
      return { code: 2 }
    }

    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }

    let status: number
    let ok: boolean
    let text: string
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/deployments/${encodeURIComponent(taskId)}/logs`,
      )
      status = res.status
      ok = res.ok
      text = await res.text()
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }

    if (ok) {
      deps.out(text)
      return { code: 0 }
    }

    if (status === 404) {
      deps.err(`deploy logs: no deployment found for task ${taskId}`)
      return { code: 1 }
    }

    // Surface the daemon's error message. Parse JSON for a cleaner message when
    // available; fall back to raw text for non-JSON bodies.
    let errorMsg: string
    try {
      const json = JSON.parse(text) as { error?: string }
      errorMsg = typeof json.error === 'string' ? json.error : text
    } catch {
      errorMsg = text
    }
    deps.err(`deploy logs: server error (${status}): ${errorMsg}`)
    return { code: 1 }
  },
}

const deployGroup: Command = {
  path: 'deploy',
  summary: 'deployment management commands',
  usage: 'usage: mars deploy <subcommand>\n\nSubcommands:\n  logs <taskId>  print provider logs for a task',
  run: async (_args, deps) => {
    deps.err('usage: mars deploy logs <taskId>')
    return { code: 2 }
  },
}

export const deployCommands: readonly Command[] = [deployGroup, deployLogs]
