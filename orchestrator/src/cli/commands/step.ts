/**
 * Manual-step subcommands: `mars step done [<task-id>]` and
 * `mars step reset <task-id> <step-name>`.
 *
 * `mars step done` — operator calls this from inside the leased worktree
 * to signal that the current manual step is complete. The command resolves the
 * awaiting promise in the workflow engine and lets the pipeline proceed to the
 * next step (auto or manual). The lease follows the operator: if the pipeline
 * parks at another manual step it is re-granted to the same owner.
 *
 * `mars step reset` — operator command to rewind a stuck task to an earlier
 * named workflow step. Clears the durable checkpoint for the named step and
 * every downstream step, clears stale failure metadata, and re-queues (or
 * restores blocked status) so the next dispatch begins at the requested step.
 * Requires an idle, unleased task (failed, blocked, queued, or awaiting-human
 * without an active lease).
 */

import { spawnSync } from 'node:child_process'
import { sep } from 'node:path'
import type { Command } from '../command'
import { errorMessage } from './shared'

/**
 * Attempt to derive the current task-id from the working directory path.
 * Returns the task id when CWD is inside `.mars/worktrees/<taskId>/`, or
 * `null` when running outside any known worktree.
 */
const taskIdFromCwd = (): string | null => {
  const cwd = process.cwd()
  const worktreesSegment = `${sep}.mars${sep}worktrees${sep}`
  const idx = cwd.indexOf(worktreesSegment)
  if (idx === -1) return null
  const rest = cwd.slice(idx + worktreesSegment.length)
  const taskId = rest.split(sep)[0]
  return taskId || null
}

const stepDone: Command = {
  path: 'step done',
  summary:
    'complete the current manual step; pipeline continues, lease follows to the next manual step',
  usage: 'usage: mars step done [<task-id>]',
  run: async (args, deps) => {
    // task-id is optional: fall back to detecting the task from CWD.
    const positionals = args.positional.filter((a) => !a.startsWith('--'))
    let id = positionals[0]
    if (!id) {
      id = taskIdFromCwd() ?? ''
    }
    if (!id) {
      deps.err('usage: mars step done [<task-id>]')
      deps.err('  no task-id supplied and CWD is not inside a worktree')
      return { code: 1 }
    }

    const task = await deps.store.getTask(id)
    if (!task) {
      deps.err(`task ${id} not found`)
      return { code: 1 }
    }
    if (task.status !== 'awaiting-human') {
      if (task.status === 'running') {
        deps.err(`step is auto — nothing to complete (task ${id} is currently running)`)
      } else {
        deps.err(
          `task ${id} is ${task.status}; 'mars step done' only applies to an 'awaiting-human' task`,
        )
      }
      return { code: 1 }
    }
    if (task.leaseOwner === null) {
      deps.err(`task ${id} has no active lease`)
      return { code: 1 }
    }

    // Uncommitted-changes guard: the pipeline's has-diff/commits-ahead checks
    // treat uncommitted work as invisible — the same rule that binds Workers
    // binds humans.
    const worktreePath = task.worktreePath
    if (worktreePath) {
      const gitResult = spawnSync(
        'git',
        ['-C', worktreePath, 'status', '--porcelain'],
        { encoding: 'utf8', timeout: 5000 },
      )
      if (gitResult.status === 0 && (gitResult.stdout ?? '').trim() !== '') {
        deps.err(`worktree ${worktreePath} has uncommitted changes`)
        deps.err('commit or stash your changes before completing the step')
        return { code: 1 }
      }
    }

    try {
      await deps.daemon.sendRequest({ op: 'step-done', id })
    } catch (err) {
      deps.err(`${id}: ${errorMessage(err)}`)
      return { code: 1 }
    }

    deps.out(
      `${id}: manual step complete — pipeline continues; if it parks at another manual step the lease comes back to you`,
    )
    return { code: 0 }
  },
}

/** Statuses that the CLI can safely refuse before contacting the daemon. */
const STEP_RESET_ALLOWED_STATUSES = new Set([
  'failed',
  'blocked',
  'queued',
  'awaiting-human',
])

const stepReset: Command = {
  path: 'step reset',
  summary:
    'rewind a task to an earlier named workflow step, preserving committed work',
  usage: 'usage: mars step reset <task-id> <step-name>',
  run: async (args, deps) => {
    const positionals = args.positional.filter((a) => !a.startsWith('--'))
    const id = positionals[0]
    const stepName = positionals[1]

    if (!id || !stepName) {
      deps.err('usage: mars step reset <task-id> <step-name>')
      deps.err('  <step-name> is the exact name of the workflow step to rewind to')
      return { code: 1 }
    }

    const task = await deps.store.getTask(id)
    if (!task) {
      deps.err(`task ${id} not found`)
      return { code: 1 }
    }

    if (!STEP_RESET_ALLOWED_STATUSES.has(task.status)) {
      deps.err(
        `task ${id} is ${task.status}; 'mars step reset' requires a task in ` +
          `failed, blocked, queued, or awaiting-human status`,
      )
      return { code: 1 }
    }
    if (task.leaseOwner !== null) {
      deps.err(
        `task ${id} is leased by '${task.leaseOwner}'; ` +
          `release the lease first with 'mars release --abort ${id}'`,
      )
      return { code: 1 }
    }

    let result: { nextStep: string; queued: boolean; cleared: string[] }
    try {
      result = (await deps.daemon.sendRequest({ op: 'step-reset', id, stepName })) as {
        nextStep: string
        queued: boolean
        cleared: string[]
      }
    } catch (err) {
      deps.err(`${id}: ${errorMessage(err)}`)
      return { code: 1 }
    }

    const statusWord = result.queued ? 'queued for dispatch' : 'blocked (incomplete blockers remain)'
    deps.out(`${id}: reset to step '${result.nextStep}' — task is now ${statusWord}`)
    if (result.cleared.length > 1) {
      deps.out(
        `  cleared ${result.cleared.length} step checkpoints: ${result.cleared.join(', ')}`,
      )
    }
    return { code: 0 }
  },
}

const stepGroup: Command = {
  path: 'step',
  summary: 'manual-step subcommands',
  usage: 'usage: mars step <done|reset> [<task-id>] [<step-name>]',
  run: (_args, deps) => {
    deps.err('usage: mars step <done|reset> [<task-id>] [<step-name>]')
    return { code: 1 }
  },
}

export const stepCommands: readonly Command[] = [stepGroup, stepDone, stepReset]
