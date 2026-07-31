/**
 * `operator` command group: `status`, `set`, `name-set`, and `name-show`.
 *
 * `operator status` — print the current value of every control lever, read
 *   directly from .mars/daemon.json (no daemon required).
 * `operator set <lever> <on|off>` — persist a lever to daemon.json and, if
 *   the daemon is up, apply it immediately via the `apply-lever` RPC so
 *   the running daemon picks up the change without a restart.
 *
 * `operator name-set` / `operator name-show` persist the operator's name in
 * `app_settings` via the existing getSetting/setSetting helpers.
 *
 * All reads and writes are local (direct file / DB access) except the
 * best-effort `apply-lever` RPC call in `operator set`. Dynamic imports
 * follow the same isolation pattern as `notifications.ts`.
 *
 * Commands use 2-token paths consistent with ADR-0023.
 */

import type { Command } from '../command'
import { readControlLevers, writeControlLever } from '../../core/daemon/config'
import {
  computeBudgetStatus,
  parseDurationToMs,
  parsePositiveInt,
  writeBudgetConfig,
} from '../../core/lib/spend-meter'
import { renderBudgetStatus } from './budget'
import { errorMessage, isDaemonDownError } from './shared'

const operatorStatus: Command = {
  path: 'operator status',
  summary: 'print current operator control lever values',
  usage: 'usage: mars operator status',
  run: async (_args, deps) => {
    const levers = readControlLevers()
    deps.out(`recovery: ${levers.recovery}`)
    deps.out(`scoring: ${levers.scoring}`)
    renderBudgetStatus(await computeBudgetStatus(deps.store), deps.out)
    return { code: 0 }
  },
}

const operatorSet: Command = {
  path: 'operator set',
  summary: 'set a control lever and apply it immediately',
  usage: 'usage: mars operator set <lever> <value>',
  run: async (args, deps) => {
    const positional = args.positional.filter((a) => !a.startsWith('--'))
    const lever = positional[0]
    const value = positional[1]
    if (!lever || !value) {
      deps.err('usage: mars operator set <lever> <value>')
      return { code: 2 }
    }
    try {
      if (lever === 'budget-window') {
        writeBudgetConfig({ windowMs: parseDurationToMs(value) })
        deps.out(`budget-window: ${value}`)
        return { code: 0 }
      }
      if (lever === 'budget-window-tokens') {
        writeBudgetConfig({ windowTokens: parsePositiveInt(value, 'budget-window-tokens') })
        deps.out(`budget-window-tokens: ${value}`)
        return { code: 0 }
      }
      if (lever === 'budget-arc-tokens') {
        writeBudgetConfig({ arcTokens: parsePositiveInt(value, 'budget-arc-tokens') })
        deps.out(`budget-arc-tokens: ${value}`)
        return { code: 0 }
      }
    } catch (err) {
      deps.err(`mars operator set: ${errorMessage(err)}`)
      return { code: 2 }
    }
    const validLevers = ['recovery', 'scoring'] as const
    type LeverName = (typeof validLevers)[number]
    if (!validLevers.includes(lever as LeverName)) {
      deps.err(
        `mars operator set: unknown lever '${lever}'; valid levers: ${validLevers.join(', ')}`,
      )
      return { code: 2 }
    }
    if (value !== 'on' && value !== 'off') {
      deps.err(`mars operator set: value must be 'on' or 'off'; got '${value}'`)
      return { code: 2 }
    }
    const leverName = lever as LeverName
    writeControlLever(leverName, value)
    try {
      await deps.daemon.sendRequest({ op: 'apply-lever', name: leverName, value })
    } catch (err) {
      const msg = errorMessage(err)
      if (!isDaemonDownError(msg)) {
        deps.err(`warning: lever written but live apply failed: ${msg}`)
      }
    }
    deps.out(`${leverName}: ${value}`)
    return { code: 0 }
  },
}

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
  usage: 'usage: mars operator <status|set|name-set|name-show>',
  run: (_args, deps) => {
    deps.err('usage: mars operator <status|set|name-set|name-show>')
    return { code: 2 }
  },
}

/** All `mars operator` leaf commands registered by the CLI index. */
export const operatorCommands: readonly Command[] = [
  operatorStatus,
  operatorSet,
  operatorNameSet,
  operatorNameShow,
  operatorGroup,
]
