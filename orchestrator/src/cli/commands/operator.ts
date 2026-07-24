/**
 * `operator` command group: `name-set` and `name-show`.
 * Persists the operator's name in `app_settings` via the existing
 * getSetting/setSetting helpers and the ONBOARDING_OPERATOR_NAME_KEY constant.
 *
 * Reads and writes are local (direct DB access), not daemon-routed.
 * Dynamic imports ensure the module-cache matches the test's vi.resetModules()
 * isolation, following the same pattern as `notifications.ts`.
 *
 * Commands use 2-token paths ('operator name-set', 'operator name-show'),
 * consistent with ADR-0023: CLI command seam is leaf-granular, flat, path-keyed,
 * with real CLI depth fixed at 2.
 */

import type { Command } from '../command'

const operatorNameSet: Command = {
  path: 'operator name-set',
  summary: 'set the operator name',
  usage: 'usage: mars operator name-set "<name>"',
  run: async (args, deps) => {
    const name = args.positional[0]
    if (!name) {
      deps.err('usage: mars operator name-set "<name>"')
      return { code: 2 }
    }
    const { migrateStateSchema } = await import('../../core/store/state-store')
    const { resolveStateClient } = await import('../../core/store/state-client')
    const { setSetting, ONBOARDING_OPERATOR_NAME_KEY } = await import(
      '../../core/lib/settings'
    )
    await migrateStateSchema()
    await setSetting(resolveStateClient(), ONBOARDING_OPERATOR_NAME_KEY, name)
    deps.out('operator name saved')
    return { code: 0 }
  },
}

const operatorNameShow: Command = {
  path: 'operator name-show',
  summary: 'show the stored operator name',
  usage: 'usage: mars operator name-show',
  run: async (_args, deps) => {
    const { migrateStateSchema } = await import('../../core/store/state-store')
    const { resolveStateClient } = await import('../../core/store/state-client')
    const { getSetting, ONBOARDING_OPERATOR_NAME_KEY } = await import(
      '../../core/lib/settings'
    )
    await migrateStateSchema()
    const name = await getSetting(resolveStateClient(), ONBOARDING_OPERATOR_NAME_KEY)
    if (name === null) {
      deps.err('no operator name set')
      return { code: 1 }
    }
    deps.out(name)
    return { code: 0 }
  },
}

const operatorGroup: Command = {
  path: 'operator',
  summary: 'operator subcommands',
  usage: 'usage: mars operator <name-set|name-show>',
  run: (_args, deps) => {
    deps.err('usage: mars operator <name-set|name-show>')
    return { code: 2 }
  },
}

export const operatorCommands: readonly Command[] = [
  operatorNameSet,
  operatorNameShow,
  operatorGroup,
]
