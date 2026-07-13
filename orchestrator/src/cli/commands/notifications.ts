/**
 * `notifications` command group: `on`, `off`, `status` (default for bare
 * invocation). Persists the operator's desktop-notification preference in the
 * `preferences` table via the slice-1 state-store helpers.
 *
 * Each subcommand dynamically imports the state-store and state-client modules
 * at invocation time (the same pattern used by `action-queue reconcile`) so
 * the import resolves against the module-cache in effect at call time — which
 * means `vi.resetModules()` + a temp-dir `MARS_REPO` gives full test isolation
 * without injecting a separate client seam.
 */

import type { Command } from '../command'

const notificationsOn: Command = {
  path: 'notifications on',
  summary: 'enable desktop notifications',
  usage: 'usage: mars notifications <on|off|status>',
  run: async (_args, deps) => {
    const { migrateStateSchema, setNotificationsEnabled } = await import(
      '../../core/store/state-store'
    )
    const { resolveStateClient } = await import('../../core/store/state-client')
    await migrateStateSchema()
    await setNotificationsEnabled(resolveStateClient(), true)
    deps.out('notifications: on')
    return { code: 0 }
  },
}

const notificationsOff: Command = {
  path: 'notifications off',
  summary: 'disable desktop notifications',
  usage: 'usage: mars notifications <on|off|status>',
  run: async (_args, deps) => {
    const { migrateStateSchema, setNotificationsEnabled } = await import(
      '../../core/store/state-store'
    )
    const { resolveStateClient } = await import('../../core/store/state-client')
    await migrateStateSchema()
    await setNotificationsEnabled(resolveStateClient(), false)
    deps.out('notifications: off')
    return { code: 0 }
  },
}

const notificationsStatus: Command = {
  path: 'notifications status',
  summary: 'show current notification preference',
  usage: 'usage: mars notifications <on|off|status>',
  run: async (_args, deps) => {
    const { migrateStateSchema, getNotificationsEnabled } = await import(
      '../../core/store/state-store'
    )
    const { resolveStateClient } = await import('../../core/store/state-client')
    await migrateStateSchema()
    const enabled = await getNotificationsEnabled(resolveStateClient())
    deps.out(`notifications: ${enabled ? 'on' : 'off'}`)
    return { code: 0 }
  },
}

const notificationsGroup: Command = {
  path: 'notifications',
  summary: 'manage desktop notification preferences (on|off|status)',
  usage: 'usage: mars notifications <on|off|status>',
  run: async (args, deps) => {
    if (args.positional.length > 0) {
      deps.err('usage: mars notifications <on|off|status>')
      return { code: 2 }
    }
    // Bare `mars notifications` → show current status
    const { migrateStateSchema, getNotificationsEnabled } = await import(
      '../../core/store/state-store'
    )
    const { resolveStateClient } = await import('../../core/store/state-client')
    await migrateStateSchema()
    const enabled = await getNotificationsEnabled(resolveStateClient())
    deps.out(`notifications: ${enabled ? 'on' : 'off'}`)
    return { code: 0 }
  },
}

export const notificationsCommands: readonly Command[] = [
  notificationsOn,
  notificationsOff,
  notificationsStatus,
  notificationsGroup,
]
