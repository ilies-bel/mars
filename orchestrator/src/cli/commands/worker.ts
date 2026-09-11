/**
 * `worker` command group: `worker list`, `worker add`, and the group fallback.
 *
 * Reads/writes the persisted worker registry under the repo's `.mars/`
 * (resolved from `deps.ctx.stateDir`). No daemon involvement.
 */

import {
  listWorkersForDisplay,
  addWorkerToRegistry,
  removeWorkerFromRegistry,
  loadWorkerRegistry,
  type WorkerDeclaration,
} from '../../core/workers/persisted-registry'
import { WORKER_PROVIDER } from '../../core/workers'
import { PROVIDER_MODELS, tierForModel, type ProviderModelTier } from '../../core/workers/provider-types'
import type { Command } from '../command'

const TIER_NAMES = new Set<string>(['flagship', 'balanced', 'fast'])

const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const VALID_PERMS = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

const WORKER_ADD_USAGE =
  `usage: mars worker add <name> --model <tier|model> [--effort ${VALID_EFFORTS.join('|')}] [--permission-mode ${VALID_PERMS.join('|')}] [--tag <tag> ...]`

/**
 * Formats a "bad value for a closed set" diagnostic that names the offending
 * value and enumerates every accepted one — same shape as the --model message.
 */
const invalidClosedSetMsg = (flag: string, bad: string, allowed: readonly string[]): string =>
  `${flag} '${bad}' is not a recognised value; use one of: ${allowed.join(', ')}.`

const workerList: Command = {
  path: 'worker list',
  summary: 'list the merged worker registry',
  usage: 'usage: mars worker list',
  run: (_args, deps) => {
    const activeProvider = WORKER_PROVIDER
    const entries = listWorkersForDisplay(deps.ctx.stateDir, activeProvider)
    deps.out(`Provider: ${activeProvider}`)
    deps.out('')
    const header =
      'NAME'.padEnd(20) +
      'SOURCE'.padEnd(12) +
      'TIER'.padEnd(12) +
      'MODEL'.padEnd(36) +
      'EFFORT'.padEnd(10) +
      'PERMISSION'
    deps.out(header)
    for (const entry of entries) {
      const { worker, modelTier, resolvedModel, conflictingOverride, isBuiltIn } = entry
      const perm =
        worker.config.permissionMode === 'bypassPermissions'
          ? 'bypass'
          : worker.config.permissionMode
      const source = isBuiltIn ? 'built-in' : 'operator'
      if (conflictingOverride !== undefined) {
        // Surface the conflict clearly: the stored override doesn't belong to
        // the active provider. Mark the tier column with '!' and show the
        // tier-based fallback model so the row is still readable.
        deps.out(
          worker.config.name.padEnd(20) +
            source.padEnd(12) +
            `${modelTier}!`.padEnd(12) +
            resolvedModel.padEnd(36) +
            worker.config.effort.padEnd(10) +
            perm,
        )
        deps.out(
          `  CONFLICT: ${worker.config.name} has override '${conflictingOverride}' which is not in provider '${activeProvider}' — resolved via tier '${modelTier}' (${resolvedModel})`,
        )
      } else {
        deps.out(
          worker.config.name.padEnd(20) +
            source.padEnd(12) +
            modelTier.padEnd(12) +
            resolvedModel.padEnd(36) +
            worker.config.effort.padEnd(10) +
            perm,
        )
      }
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
    const modelArg = args.flags['--model']
    if (!name || !modelArg) {
      deps.err(WORKER_ADD_USAGE)
      return { code: 2 }
    }

    const effortRaw = args.flags['--effort'] ?? 'high'
    if (!(VALID_EFFORTS as readonly string[]).includes(effortRaw)) {
      deps.err(invalidClosedSetMsg('--effort', effortRaw, VALID_EFFORTS))
      return { code: 2 }
    }

    const permRaw = args.flags['--permission-mode'] ?? 'default'
    if (!(VALID_PERMS as readonly string[]).includes(permRaw)) {
      deps.err(invalidClosedSetMsg('--permission-mode', permRaw, VALID_PERMS))
      return { code: 2 }
    }

    // Resolve --model to a ProviderModelTier. Accepts:
    //   1. A tier name directly: flagship | balanced | fast
    //   2. A concrete model id that belongs to the active provider — mapped to its tier.
    // Rejects concrete model ids from a different provider (mismatch).
    let resolvedTier: ProviderModelTier
    if (TIER_NAMES.has(modelArg)) {
      resolvedTier = modelArg as ProviderModelTier
    } else {
      const activeProvider = WORKER_PROVIDER
      const matchedTier = tierForModel(modelArg, activeProvider)
      if (matchedTier === undefined) {
        deps.err(
          `--model '${modelArg}' is not in provider '${activeProvider}' ` +
            `and is not a recognised tier (flagship|balanced|fast). ` +
            `Use a tier name or a model id from the active provider ` +
            `(${Object.values(PROVIDER_MODELS[activeProvider]).join(', ')}).`,
        )
        return { code: 2 }
      }
      resolvedTier = matchedTier
    }

    const tags = args.multiFlags['--tag']

    const decl: WorkerDeclaration = {
      name,
      modelTier: resolvedTier,
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
      runtime: 'headless',
      ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
    }

    addWorkerToRegistry(deps.ctx.stateDir, decl)
    deps.out(`added worker ${name}`)
    return { code: 0 }
  },
}

const WORKER_REMOVE_USAGE = 'usage: mars worker remove <name>'

const workerRemove: Command = {
  path: 'worker remove',
  summary: 'remove an operator-added worker from the registry',
  usage: WORKER_REMOVE_USAGE,
  run: async (args, deps) => {
    const name = args.positional[0]
    if (!name) {
      deps.err(WORKER_REMOVE_USAGE)
      return { code: 2 }
    }

    // Check for running/queued tasks whose tags would route to this worker.
    // A task routes to a worker when the task's tag set intersects the worker's
    // tag set. We refuse removal when any such task is in an active state so
    // that dispatch never lands on a now-absent worker entry.
    const workerDecls = loadWorkerRegistry(deps.ctx.stateDir)
    const targetDecl = workerDecls.find((d) => d.name === name)

    // Validate early: if targetDecl is undefined the worker either doesn't
    // exist in the registry or is a built-in; removeWorkerFromRegistry will
    // produce the right error. But we still want to do the running-task check
    // when the worker IS found before attempting removal.
    if (targetDecl !== undefined && (targetDecl.tags?.length ?? 0) > 0) {
      const workerTagSet = new Set(targetDecl.tags ?? [])
      const activeStatuses = ['running', 'queued'] as const
      for (const status of activeStatuses) {
        const tasks = await deps.store.listTasks(status)
        for (const task of tasks) {
          const taskTags: readonly string[] = task.tags ?? []
          const intersection = taskTags.filter((t) => workerTagSet.has(t))
          if (intersection.length > 0) {
            deps.err(
              `cannot remove worker '${name}': task ${task.id} (status=${status}) ` +
                `is routed to it via tag(s): ${intersection.join(', ')}`,
            )
            return { code: 1 }
          }
        }
      }
    }

    try {
      removeWorkerFromRegistry(deps.ctx.stateDir, name)
      deps.out(`removed worker ${name}`)
      return { code: 0 }
    } catch (err: unknown) {
      deps.err(err instanceof Error ? err.message : String(err))
      return { code: 1 }
    }
  },
}

const workerGroup: Command = {
  path: 'worker',
  summary: 'worker subcommands',
  usage: 'usage: mars worker <list|add|remove>',
  run: (_args, deps) => {
    deps.err('usage: mars worker <list|add|remove>')
    return { code: 2 }
  },
}

export const workerCommands: readonly Command[] = [
  workerList,
  workerAdd,
  workerRemove,
  workerGroup,
]
