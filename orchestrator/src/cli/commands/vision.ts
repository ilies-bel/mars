/**
 * `vision` command group: `set` and `show`.
 * Persists the product vision in `app_settings` via the existing
 * getSetting/setSetting helpers and the ONBOARDING_VISION_KEY constant.
 *
 * Reads and writes are local (direct DB access), not daemon-routed.
 * Dynamic imports ensure the module-cache matches the test's vi.resetModules()
 * isolation, following the same pattern as `notifications.ts`.
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
    const { migrateStateSchema } = await import('../../core/store/state-store')
    const { resolveStateClient } = await import('../../core/store/state-client')
    const { setSetting, ONBOARDING_VISION_KEY } = await import('../../core/lib/settings')
    await migrateStateSchema()
    await setSetting(resolveStateClient(), ONBOARDING_VISION_KEY, vision)
    deps.out('vision set')
    return { code: 0 }
  },
}

const visionShow: Command = {
  path: 'vision show',
  summary: 'show the stored product vision',
  usage: 'usage: mars vision show',
  run: async (_args, deps) => {
    const { migrateStateSchema } = await import('../../core/store/state-store')
    const { resolveStateClient } = await import('../../core/store/state-client')
    const { getSetting, ONBOARDING_VISION_KEY } = await import('../../core/lib/settings')
    await migrateStateSchema()
    const vision = await getSetting(resolveStateClient(), ONBOARDING_VISION_KEY)
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
