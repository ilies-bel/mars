/**
 * `mars enter <task-id>` — open an agent session on a task's worktree.
 *
 * Resolves the task, asserts it is in `awaiting-human` status with a leased
 * worktree, composes the live briefing (task id, done criteria, step guide,
 * progress journal), then spawns the operator's configured terminal agent
 * (default: `claude`, override: `MARS_LIVE_AGENT_CMD`) with its cwd set to
 * the task's worktree and the briefing piped into its stdin.
 *
 * The process inherits the parent's stdout and stderr so the agent session
 * renders normally in the operator's terminal.  The command blocks until the
 * spawned agent exits and returns the agent's exit code.
 */

import { spawn } from 'node:child_process'
import type { Command } from '../command'
import { composeLiveBriefing } from '../../core/lib/live-briefing'
import { errorMessage } from './shared'

const enter: Command = {
  path: 'enter',
  summary: "open an agent session on a task's worktree",
  usage: 'usage: mars enter <task-id>',
  run: async (args, deps) => {
    const positionals = args.positional.filter((a) => !a.startsWith('--'))
    const id = positionals[0]

    if (!id) {
      deps.err('usage: mars enter <task-id>')
      return { code: 1 }
    }

    const task = await deps.store.getTask(id)
    if (!task) {
      deps.err(`task ${id} not found`)
      return { code: 1 }
    }

    if (task.status !== 'awaiting-human') {
      deps.err(
        `task ${id} is ${task.status}; 'mars enter' only applies to an awaiting-human task`,
      )
      return { code: 1 }
    }

    const worktreePath = task.worktreePath
    if (!worktreePath) {
      deps.err(`task ${id} has no worktree`)
      return { code: 1 }
    }

    let briefing: string
    try {
      briefing = await composeLiveBriefing(id)
    } catch (err) {
      deps.err(`${id}: ${errorMessage(err)}`)
      return { code: 1 }
    }

    const cmdParts = (process.env.MARS_LIVE_AGENT_CMD ?? 'claude').split(' ')
    const [bin, ...binArgs] = cmdParts

    return new Promise<{ code: number }>((resolve) => {
      const child = spawn(bin, binArgs, {
        cwd: worktreePath,
        stdio: ['pipe', 'inherit', 'inherit'],
      })

      child.stdin!.write(briefing)
      child.stdin!.end()

      child.on('close', (code) => {
        resolve({ code: code ?? 1 })
      })

      child.on('error', (err) => {
        deps.err(`failed to spawn agent: ${errorMessage(err)}`)
        resolve({ code: 1 })
      })
    })
  },
}

export const enterCommands: readonly Command[] = [enter]
