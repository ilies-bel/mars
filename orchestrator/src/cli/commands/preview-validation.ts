/**
 * Preview-gate verdict commands: `mars validate <id> [<id> ...]` and
 * `mars reject <id> [<id> ...]`.
 *
 * State transitions intentionally stay in the daemon. The CLI only checks the
 * task's current status for a useful operator-facing refusal, then calls the
 * same HTTP action route used by the UI.
 */

import type { Command } from '../command'
import { readDaemonPort } from './shared'

type PreviewVerdict = 'validate' | 'reject'

const previewValidationCommand = (verdict: PreviewVerdict): Command => {
  const pastTense = verdict === 'validate' ? 'validated' : 'rejected'
  const route = verdict === 'validate' ? 'validate' : 'reject'
  const result = verdict === 'validate' ? 're-queued for merge' : 'task failed; merge skipped'
  const daemonDown =
    `${verdict}: daemon not running — run \`mars daemon start\` first`

  return {
    path: verdict,
    summary:
      verdict === 'validate'
        ? 'approve preview-gated task(s) and re-queue them for merge'
        : 'reject preview-gated task(s), preserving worktrees for inspection',
    usage: `usage: mars ${verdict} <task-id> [<task-id> ...]`,
    run: async (args, deps) => {
      const ids = args.positional.filter((arg) => !arg.startsWith('--'))
      if (ids.length === 0) {
        deps.err(`usage: mars ${verdict} <task-id> [<task-id> ...]`)
        return { code: 2 }
      }

      for (const id of ids) {
        const task = await deps.store.getTask(id)
        if (!task) {
          deps.err(`task ${id} not found`)
          return { code: 1 }
        }
        if (task.status !== 'awaiting-validation') {
          if (task.status === 'awaiting-human') {
            deps.err(
              `task ${id} is awaiting-human; use \`mars step done ${id}\` to complete its manual step`,
            )
          } else {
            deps.err(
              `task ${id} is ${task.status}; \`mars ${verdict}\` only applies to an ` +
                "'awaiting-validation' task",
            )
          }
          return { code: 1 }
        }
      }

      const port = await readDaemonPort(deps.ctx.stateDir)
      if (port === null) {
        deps.err(daemonDown)
        return { code: 1 }
      }

      for (const id of ids) {
        let response: Response
        try {
          response = await fetch(
            `http://127.0.0.1:${port}/actions/${route}/${encodeURIComponent(id)}`,
            { method: 'POST' },
          )
        } catch {
          deps.err(daemonDown)
          return { code: 1 }
        }

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: unknown
            message?: unknown
          }
          const detail =
            typeof body.error === 'string'
              ? body.error
              : typeof body.message === 'string'
                ? body.message
                : `daemon returned ${response.status}`
          deps.err(`${verdict} ${id}: ${detail}`)
          return { code: 1 }
        }

        deps.out(`${pastTense} ${id}; ${result}`)
      }
      return { code: 0 }
    },
  }
}

export const previewValidationCommands: readonly Command[] = [
  previewValidationCommand('validate'),
  previewValidationCommand('reject'),
]
