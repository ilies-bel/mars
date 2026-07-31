import type { Command } from '../command'
import {
  computeBudgetStatus,
  parseDurationToMs,
  parsePositiveInt,
  writeBudgetConfig,
  type BudgetConfigInput,
  type BudgetStatus,
} from '../../core/lib/spend-meter'

const SET_USAGE =
  'usage: mars budget set [--window <dur e.g. 4h>] [--window-tokens <N>] [--arc-tokens <N>]'

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

const formatDuration = (milliseconds: number): string => {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`
  return `${milliseconds}ms`
}

export const renderBudgetStatus = (status: BudgetStatus, out: (line: string) => void): void => {
  if (!status.configured) {
    out('spend meter: not configured')
    out("set thresholds with 'mars budget set --window 4h --window-tokens 5000000 --arc-tokens 750000'")
    return
  }

  if (status.window === null) {
    out('window:  not configured (needs both --window and --window-tokens)')
  } else {
    const window = status.window
    out(
      `window:  ${formatTokens(window.spendTokens)} / ${formatTokens(window.thresholdTokens)} weighted tokens over ${formatDuration(window.windowMs)} (${(window.ratio * 100).toFixed(1)}% — ${window.band})`,
    )
    if (window.topArcs.length > 0) {
      out('  top contributing arcs:')
      window.topArcs.forEach((arc) => out(`    ${arc.arcId}  ${formatTokens(arc.spendTokens)}`))
    }
  }

  if (status.arcs === null) {
    out('per-arc ceiling: not configured (needs --arc-tokens)')
  } else {
    const arcs = status.arcs
    out(`per-arc ceiling: ${formatTokens(arcs.ceilingTokens)} weighted tokens`)
    if (arcs.liveArcs.length === 0) {
      out('  no live arcs with recorded spend')
    } else {
      out('  top live arcs by lifetime spend:')
      arcs.liveArcs.forEach((arc) =>
        out(
          `    ${arc.arcId}  ${formatTokens(arc.spendTokens)} (${(arc.ratio * 100).toFixed(1)}%)${arc.overCeiling ? '  ⚠ OVER CEILING' : ''}`,
        ),
      )
    }
  }

  if (status.openRows.length === 0) {
    out('open budget rows: none')
  } else {
    out('open budget rows:')
    status.openRows.forEach((row) => out(`  [${row.kind}] ${row.id}  seen×${row.seenCount}  ${row.title}`))
  }
}

const budgetSet: Command = {
  path: 'budget set',
  summary: 'set spend-meter thresholds',
  usage: SET_USAGE,
  run: (args, deps) => {
    const window = args.flags['--window']
    const windowTokens = args.flags['--window-tokens']
    const arcTokens = args.flags['--arc-tokens']
    if (window === undefined && windowTokens === undefined && arcTokens === undefined) {
      deps.err(SET_USAGE)
      return { code: 2 }
    }

    const patch: BudgetConfigInput = {}
    try {
      if (window !== undefined) patch.windowMs = parseDurationToMs(window)
      if (windowTokens !== undefined) patch.windowTokens = parsePositiveInt(windowTokens, '--window-tokens')
      if (arcTokens !== undefined) patch.arcTokens = parsePositiveInt(arcTokens, '--arc-tokens')
    } catch (error) {
      deps.err(`budget set: ${error instanceof Error ? error.message : String(error)}`)
      return { code: 2 }
    }
    writeBudgetConfig(patch)
    deps.out('budget thresholds saved to .mars/daemon.json')
    return { code: 0 }
  },
}

const budgetStatus: Command = {
  path: 'budget status',
  summary: 'show spend-meter thresholds and current burn',
  usage: 'usage: mars budget status [--json]',
  run: async (args, deps) => {
    const status = await computeBudgetStatus(deps.store)
    if (args.positional.includes('--json')) {
      deps.out(JSON.stringify(status, null, 2))
    } else {
      renderBudgetStatus(status, deps.out)
    }
    return { code: 0, value: status }
  },
}

const budgetGroup: Command = {
  path: 'budget',
  summary: 'spend-meter subcommands',
  usage: 'usage: mars budget <set|status> [flags]',
  run: (_args, deps) => {
    deps.err('usage: mars budget <set|status> [flags]')
    return { code: 2 }
  },
}

export const budgetCommands: readonly Command[] = [budgetSet, budgetStatus, budgetGroup]
