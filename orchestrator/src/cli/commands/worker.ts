/**
 * `worker` command group: `worker list`, `worker add`, and the group fallback.
 *
 * Reads/writes the persisted worker registry under the repo's `.mars/`
 * (resolved from `deps.ctx.stateDir`). No daemon involvement.
 */

import {
  listWorkersForDisplay,
  addWorkerToRegistry,
  type WorkerDeclaration,
} from '../../core/workers/persisted-registry'
import { WORKER_PROVIDER } from '../../core/workers'
import { PROVIDER_MODELS, tierForModel, type ProviderModelTier, type ProviderName } from '../../core/workers/provider-types'
import type { Command } from '../command'

const TIER_NAMES = new Set<string>(['flagship', 'balanced', 'fast'])

const WORKER_ADD_USAGE =
  'usage: mars worker add <name> --model <tier|model> [--effort high|medium|...] [--permission-mode default|bypassPermissions] [--tag <tag> ...]'

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
      'TIER'.padEnd(12) +
      'MODEL'.padEnd(36) +
      'EFFORT'.padEnd(10) +
      'PERMISSION'
    deps.out(header)
    for (const entry of entries) {
      const { worker, modelTier, resolvedModel, conflictingOverride } = entry
      const perm =
        worker.config.permissionMode === 'bypassPermissions'
          ? 'bypass'
          : worker.config.permissionMode
      if (conflictingOverride !== undefined) {
        // Surface the conflict clearly: the stored override doesn't belong to
        // the active provider. Mark the tier column with '!' and show the
        // tier-based fallback model so the row is still readable.
        deps.out(
          worker.config.name.padEnd(20) +
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
    const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
    if (!VALID_EFFORTS.has(effortRaw)) {
      deps.err(
        `effort must be one of low, medium, high, xhigh, max; got '${effortRaw}'`,
      )
      return { code: 2 }
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
