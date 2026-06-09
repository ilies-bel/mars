/**
 * `worker` command group: `worker list`, `worker add`, and the group fallback.
 *
 * Reads/writes the persisted worker registry under the repo's `.mars/`
 * (resolved from `deps.ctx.stateDir`). No daemon involvement.
 */

import {
  listMergedWorkers,
  addWorkerToRegistry,
} from '../../core/workers/persisted-registry'
import type { Command } from '../command'

const WORKER_ADD_USAGE =
  'usage: mars worker add <name> --model <model> [--effort high|medium|...] [--permission-mode default|bypassPermissions] [--max-messages <n>] [--tag <tag> ...]'

const workerList: Command = {
  path: 'worker list',
  summary: 'list the merged worker registry',
  usage: 'usage: mars worker list',
  run: (_args, deps) => {
    const workers = listMergedWorkers(deps.ctx.stateDir)
    const header =
      'NAME'.padEnd(20) + 'MODEL'.padEnd(36) + 'EFFORT'.padEnd(10) + 'PERMISSION'
    deps.out(header)
    for (const w of workers) {
      const perm =
        w.permissionMode === 'bypassPermissions' ? 'bypass' : w.permissionMode
      deps.out(
        w.name.padEnd(20) + w.model.padEnd(36) + w.effort.padEnd(10) + perm,
      )
    }
    return { code: 0 }
  },
}

const workerAdd: Command = {
  path: 'worker add',
  summary: 'add a worker to the persisted registry',
  usage: WORKER_ADD_USAGE,
  run: (args, deps) => {
    const name = args.positional[0]
    const model = args.flags['--model']
    if (!name || !model) {
      deps.err(WORKER_ADD_USAGE)
      return { code: 1 }
    }

    const effortRaw = args.flags['--effort'] ?? 'high'
    const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
    if (!VALID_EFFORTS.has(effortRaw)) {
      deps.err(
        `effort must be one of low, medium, high, xhigh, max; got '${effortRaw}'`,
      )
      return { code: 1 }
    }

    const permRaw = args.flags['--permission-mode'] ?? 'default'
    const VALID_PERMS = new Set([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
    ])
    if (!VALID_PERMS.has(permRaw)) {
      deps.err(
        `permission-mode must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan; got '${permRaw}'`,
      )
      return { code: 1 }
    }

    let maxMessages = 0
    const maxRaw = args.flags['--max-messages']
    if (maxRaw !== undefined) {
      const n = Number(maxRaw)
      if (!Number.isInteger(n) || n < 0) {
        deps.err(`max-messages must be a non-negative integer; got '${maxRaw}'`)
        return { code: 1 }
      }
      maxMessages = n
    }

    const tags = args.multiFlags['--tag']

    addWorkerToRegistry(deps.ctx.stateDir, {
      name,
      model,
      effort: effortRaw as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
      permissionMode: permRaw as
        | 'acceptEdits'
        | 'auto'
        | 'bypassPermissions'
        | 'default'
        | 'dontAsk'
        | 'plan',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      maxMessages,
      runtime: 'headless',
      ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
    })
    deps.out(`added worker ${name}`)
    return { code: 0 }
  },
}

const workerGroup: Command = {
  path: 'worker',
  summary: 'worker subcommands',
  usage: 'usage: mars worker <list|add>',
  run: (_args, deps) => {
    deps.err('usage: mars worker <list|add>')
    return { code: 2 }
  },
}

export const workerCommands: readonly Command[] = [
  workerList,
  workerAdd,
  workerGroup,
]
