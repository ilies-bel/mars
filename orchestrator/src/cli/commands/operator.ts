/**
 * `operator` command group: `status`, `set`, `name-set`, and `name-show`.
 *
 * `operator status` — print the current value of every control lever, read
 *   directly from .mars/daemon.json (no daemon required). The one exception is
 *   `dispatch`, which is read from the RUNNING daemon when it is up: a 'storm'
 *   or 'quota' pause never touches disk, so daemon.json alone would report
 *   `dispatch: on` while `mars daemon status` reported `⏸ PAUSED`.
 * `operator set <lever> <on|off>` — persist a lever to daemon.json and, if
 *   the daemon is up, apply it immediately via the `apply-lever` RPC so
 *   the running daemon picks up the change without a restart.
 *
 * `dispatch` is the queue's on/off switch and the operator's way out of a
 * storm or quota pause: `off` suspends dispatch (in-flight tasks continue),
 * `on` resumes and clears whichever cause held the pause, including the
 * durable signature-storm breaker flag. It persists to the top-level `paused`
 * key rather than the `controlLevers` map (ADR-0058) and applies live via the
 * `set-dispatch` RPC.
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
import {
  loadDaemonConfig,
  persistPaused,
  readPersistedPaused,
  writeControlLever,
} from '../../core/daemon/config'
import { isDaemonAlive } from '../../core/daemon/paths'
import { describePauseState } from '../../core/daemon/pause-state'
import type { DispatchPauseState } from '../../core/daemon/pause-state'
import {
  computeBudgetStatus,
  parseDurationToMs,
  parsePositiveInt,
  writeBudgetConfig,
} from '../../core/lib/spend-meter'
import { errorMessage, isDaemonDownError } from './shared'

const operatorStatus: Command = {
  path: 'operator status',
  summary: 'print current operator control lever values',
  usage: 'usage: mars operator status',
  run: async (_args, deps) => {
    const liveness = await isDaemonAlive()
    const cfg = loadDaemonConfig()
    const levers = cfg.controlLevers
    deps.out(`recovery: ${levers.recovery}`)
    deps.out(`scoring: ${levers.scoring}`)
    deps.out(`auto-reflect: ${levers.autoReflect}`)
    deps.out(`auto-trigger: ${cfg.selfEvolve.autoTrigger ? 'on' : 'off'}`)
    if (!liveness.alive) {
      deps.out(
        `dispatch: ${readPersistedPaused() ? 'paused' : 'on'}  in-flight: unavailable (daemon down)`,
      )
    } else {
      // Report the daemon's LIVE pause state, not the persisted operator flag.
      // Only an 'operator' pause is on disk; a 'storm' or 'quota' pause exists
      // solely in the running process, so reading daemon.json here used to
      // print `dispatch: on` while `mars daemon status` printed `⏸ PAUSED` —
      // two surfaces, two half-truths. Both now render the same
      // DispatchPauseState through describePauseState.
      const status = (await deps.daemon.sendRequest({ op: 'status' })) as {
        inFlight: ReadonlyArray<unknown>
        pause: DispatchPauseState
      }
      const pauseLine = describePauseState(status.pause)
      deps.out(
        `dispatch: ${pauseLine === null ? 'on' : `paused (${pauseLine})`}  in-flight: ${status.inFlight.length}`,
      )
      if (pauseLine !== null) {
        deps.out("resume with 'mars operator set dispatch on'")
      }
    }
    const budget = await computeBudgetStatus(deps.store)
    if (!budget.configured) {
      deps.out('spend meter: not configured')
      deps.out("set thresholds with 'mars operator set budget-window <duration>', 'mars operator set budget-window-tokens <N>', and 'mars operator set budget-arc-tokens <N>'")
    } else {
      if (budget.window === null) {
        deps.out('window:  not configured (needs both budget-window and budget-window-tokens)')
      } else {
        const window = budget.window
        const tokens = (value: number): string => value >= 1_000_000
          ? `${(value / 1_000_000).toFixed(1)}M`
          : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(Math.round(value))
        const duration = (milliseconds: number): string => milliseconds % 3_600_000 === 0
          ? `${milliseconds / 3_600_000}h`
          : milliseconds % 60_000 === 0 ? `${milliseconds / 60_000}m`
            : milliseconds % 1_000 === 0 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`
        deps.out(`window:  ${tokens(window.spendTokens)} / ${tokens(window.thresholdTokens)} weighted tokens over ${duration(window.windowMs)} (${(window.ratio * 100).toFixed(1)}% — ${window.band})`)
        if (window.topArcs.length > 0) {
          deps.out('  top contributing arcs:')
          window.topArcs.forEach((arc) => deps.out(`    ${arc.arcId}  ${tokens(arc.spendTokens)}`))
        }
      }
      if (budget.arcs === null) {
        deps.out('per-arc ceiling: not configured (needs budget-arc-tokens)')
      } else {
        const arcs = budget.arcs
        const tokens = (value: number): string => value >= 1_000_000
          ? `${(value / 1_000_000).toFixed(1)}M`
          : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(Math.round(value))
        deps.out(`per-arc ceiling: ${tokens(arcs.ceilingTokens)} weighted tokens`)
        if (arcs.liveArcs.length === 0) deps.out('  no live arcs with recorded spend')
        else {
          deps.out('  top live arcs by lifetime spend:')
          arcs.liveArcs.forEach((arc) => deps.out(`    ${arc.arcId}  ${tokens(arc.spendTokens)} (${(arc.ratio * 100).toFixed(1)}%)${arc.overCeiling ? '  ⚠ OVER CEILING' : ''}`))
        }
      }
      if (budget.openRows.length === 0) deps.out('open budget rows: none')
      else {
        deps.out('open budget rows:')
        budget.openRows.forEach((row) => deps.out(`  [${row.kind}] ${row.id}  seen×${row.seenCount}  ${row.title}`))
      }
    }
    return { code: 0 }
  },
}

const operatorSet: Command = {
  path: 'operator set',
  summary: 'set a control lever and apply it immediately',
  usage:
    'usage: mars operator set <dispatch|recovery|scoring|auto-reflect> <on|off>\n' +
    '       mars operator set <budget-window|budget-window-tokens|budget-arc-tokens> <value>',
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
    const validLevers = ['dispatch', 'recovery', 'scoring', 'auto-reflect'] as const
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
    // `dispatch` is the queue's on/off switch, not an env-var kill-switch, so
    // it does not go through writeControlLever/apply-lever. Its persisted home
    // is the top-level `paused` key in daemon.json (ADR-0058: the intent must
    // survive an auto-respawn, or a restarted daemon resumes dispatch against
    // uncommitted operator work). Write the file FIRST, then apply live —
    // the same order as every other lever.
    if (lever === 'dispatch') {
      const paused = value === 'off'
      persistPaused(paused)
      try {
        await deps.daemon.sendRequest({ op: 'set-dispatch', value })
        deps.out(
          paused
            ? 'dispatch: off (paused — in-flight tasks continue; no new work dispatched)'
            : 'dispatch: on (resumed; signature-storm breaker cleared)',
        )
      } catch (err) {
        const msg = errorMessage(err)
        if (!isDaemonDownError(msg)) {
          deps.err(`mars operator set: dispatch written but live apply failed: ${msg}`)
          return { code: 1 }
        }
        // Daemon down: the persisted flag decides what the next start does, so
        // the operator's intent is not lost. The signature-storm `tripped` flag
        // lives in the DB the daemon provisions, so it can only be cleared
        // against a running daemon — say so rather than implying `dispatch on`
        // fully took effect. Re-running this once the daemon is up clears it.
        deps.out(`dispatch: ${value} (persisted; daemon down — applies at next start)`)
        if (!paused) {
          deps.out(
            "note: a signature-storm trip can still re-pause dispatch at startup; re-run 'mars operator set dispatch on' once the daemon is up to clear it",
          )
        }
      }
      return { code: 0 }
    }
    // `dispatch` returned above; the rest are env-var kill-switches living in
    // the `controlLevers` map.
    const leverName = lever as Exclude<LeverName, 'dispatch'>
    const configLeverName =
      leverName === 'auto-reflect' ? 'autoReflect' : leverName
    writeControlLever(configLeverName, value)
    if (configLeverName !== 'autoReflect') {
      try {
        await deps.daemon.sendRequest({ op: 'apply-lever', name: configLeverName, value })
      } catch (err) {
        const msg = errorMessage(err)
        if (!isDaemonDownError(msg)) {
          deps.err(`warning: lever written but live apply failed: ${msg}`)
        }
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
