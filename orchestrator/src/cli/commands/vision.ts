/**
 * `vision` command group: `set` and `show`.
 *
 * `vision set` dispatches a `vision-write` RPC to the daemon, which runs the
 * structured-write pipeline and returns only after the file has merged.
 * `vision show` reads `docs/knowledge/vision.md` directly from the repo root
 * via the canonical `readVision` helper.
 *
 * There is no database row involved. ONBOARDING_VISION_KEY is gone.
 */

import type { Command } from '../command'

const visionSet: Command = {
  path: 'vision set',
  summary: 'set the product vision',
  usage: 'usage: mars vision set "<prose>"',
  run: async (args, deps) => {
    const vision = args.positional[0]
    if (!vision) {
      deps.err('usage: mars vision set "<prose>"')
      return { code: 2 }
    }
    await deps.daemon.sendRequest({ op: 'vision-write', content: vision })
    deps.out('vision set')
    return { code: 0 }
  },
}

const visionShow: Command = {
  path: 'vision show',
  summary: 'show the stored product vision',
  usage: 'usage: mars vision show',
  run: async (_args, deps) => {
    const { readVision } = await import('../../core/lib/vision')
    const vision = await readVision(deps.ctx.repoRoot)
    if (vision === null) {
      deps.err('no vision set')
      return { code: 1 }
    }
    deps.out(vision)
    return { code: 0 }
  },
}

const visionGroup: Command = {
  path: 'vision',
  summary: 'manage the product vision (set|show)',
  usage: 'usage: mars vision <set|show>',
  run: (_args, deps) => {
    deps.err('usage: mars vision <set|show>')
    return { code: 2 }
  },
}

/** All `mars vision` leaf commands registered by the CLI index. */
export const visionCommands: readonly Command[] = [visionSet, visionShow, visionGroup]
