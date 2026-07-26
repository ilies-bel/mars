/**
 * `mars merge` subcommands.
 *
 * Currently provides a single verb:
 *   mars merge cancel <jobId>   — cancel an active merge job by id.
 */

import type { Command } from '../command'
import { errorMessage } from './shared'

const mergeCancel: Command = {
  path: 'merge cancel',
  summary: 'cancel an active merge job by id',
  usage: 'usage: mars merge cancel <jobId>',
  run: async (args, deps) => {
    const jobId = args.positional[0]
    if (!jobId) {
      deps.err('usage: mars merge cancel <jobId>')
      return { code: 2 }
    }

    let result: { canceled: boolean; workerAborted: boolean }
    try {
      result = (await deps.daemon.sendRequest({
        op: 'merge.cancel',
        jobId,
      })) as { canceled: boolean; workerAborted: boolean }
    } catch (err) {
      deps.err(`${jobId}: ${errorMessage(err)}`)
      return { code: 1 }
    }

    if (!result.canceled) {
      deps.err(
        `merge job ${jobId} not found or already terminal (done/failed/canceled)`,
      )
      return { code: 1 }
    }

    const abortNote = result.workerAborted
      ? ' and aborted the in-flight merge operation'
      : ' (job was queued; not yet running)'
    deps.out(`canceled merge job ${jobId}${abortNote}`)
    return { code: 0 }
  },
}

export const mergeCommands: readonly Command[] = [mergeCancel]
