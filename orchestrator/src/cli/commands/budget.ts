/**
 * `budget` command group: `set` and `status` — the operator surface of the
 * Spend meter (observe-and-warn token-budget alerting; lib/spend-meter.ts).
 *
 * `budget set` merge-patches the `budget` key in `.mars/daemon.json` via the
 * daemon-config merge-patch helper; the daemon's spend sweep re-reads the
 * file every tick (default 30 s), so thresholds take effect without a
 * restart. `budget status` computes the live status straight off the DB —
 * it works whether or not the daemon is running.
 *
 * The meter never pauses dispatch and never suppresses recoveries; both
 * verbs are pure config/read surfaces.
 */

import type { Command } from '../command'
import {
  computeBudgetStatus,
  parseDurationToMs,
  writeBudgetConfig,
  type BudgetConfigInput,
  type BudgetStatus,
} from '../../core/lib/spend-meter'

const SET_USAGE =
  'usage: mars budget set [--window <dur e.g. 4h>] [--window-tokens <N>] [--arc-tokens <N>]'

const parsePositiveInt = (raw: string, flag: string): number => {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer; got '${raw}'`)
  }
  return n
}

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

const formatDuration = (ms: number): string => {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}

const budgetSet: Command = {
  path: 'budget set',
  summary: 'set spend-meter thresholds (any subset; persists to .mars/daemon.json)',
  usage: SET_USAGE,
  run: (args, deps) => {
    const windowRaw = args.flags['--window']
    const windowTokensRaw = args.flags['--window-tokens']
    const arcTokensRaw = args.flags['--arc-tokens']

    if (
      windowRaw === undefined &&
      windowTokensRaw === undefined &&
      arcTokensRaw === undefined
    ) {
      deps.err(SET_USAGE)
      deps.err('budget set: pass at least one of --window / --window-tokens / --arc-tokens')
      return { code: 2 }
    }

    const patch: BudgetConfigInput = {}
    try {
      if (windowRaw !== undefined) patch.windowMs = parseDurationToMs(windowRaw)
      if (windowTokensRaw !== undefined) {
        patch.windowTokens = parsePositiveInt(windowTokensRaw, '--window-tokens')
      }
      if (arcTokensRaw !== undefined) {
        patch.arcTokens = parsePositiveInt(arcTokensRaw, '--arc-tokens')
      }
    } catch (err) {
      deps.err(`budget set: ${err instanceof Error ? err.message : String(err)}`)
      return { code: 2 }
    }

    // Pin the resolved --repo context before the config helper resolves
    // `.mars/daemon.json` from the ambient context.
    void deps.ctx
    const next = writeBudgetConfig(patch)
    if (next === null) {
      deps.out('budget: no thresholds configured (meter disabled)')
      return { code: 0 }
    }
    deps.out('budget thresholds saved to .mars/daemon.json:')
    deps.out(
      `  window:        ${next.windowMs !== null ? formatDuration(next.windowMs) : '(unset)'}`,
    )
    deps.out(
      `  window-tokens: ${next.windowTokens !== null ? formatTokens(next.windowTokens) : '(unset)'}`,
    )
    deps.out(
      `  arc-tokens:    ${next.arcTokens !== null ? formatTokens(next.arcTokens) : '(unset)'}`,
    )
    deps.out('the daemon spend sweep picks this up on its next tick (~30s); no restart needed')
    return { code: 0 }
  },
}

const renderStatus = (status: BudgetStatus, out: (s: string) => void): void => {
  if (!status.configured) {
    out('spend meter: not configured')
    out("set thresholds with 'mars budget set --window 4h --window-tokens 5000000 --arc-tokens 750000'")
    return
  }

  if (status.window !== null) {
    const w = status.window
    const pct = (w.ratio * 100).toFixed(1)
    out(
      `window:  ${formatTokens(w.spendTokens)} / ${formatTokens(w.thresholdTokens)} weighted tokens over ${formatDuration(w.windowMs)} (${pct}% — ${w.band})`,
    )
    if (w.topArcs.length > 0) {
      out('  top contributing arcs:')
      for (const arc of w.topArcs) {
        out(`    ${arc.arcId}  ${formatTokens(arc.spendTokens)}`)
      }
    }
  } else {
    out('window:  not configured (needs both --window and --window-tokens)')
  }

  if (status.arcs !== null) {
    const a = status.arcs
    out(`per-arc ceiling: ${formatTokens(a.ceilingTokens)} weighted tokens`)
    if (a.liveArcs.length === 0) {
      out('  no live arcs with recorded spend')
    } else {
      out('  top live arcs by lifetime spend:')
      for (const arc of a.liveArcs) {
        const marker = arc.overCeiling ? '  ⚠ OVER CEILING' : ''
        out(
          `    ${arc.arcId}  ${formatTokens(arc.spendTokens)} (${(arc.ratio * 100).toFixed(1)}%)${marker}`,
        )
      }
    }
  } else {
    out('per-arc ceiling: not configured (needs --arc-tokens)')
  }

  if (status.openRows.length === 0) {
    out('open budget rows: none')
  } else {
    out('open budget rows:')
    for (const row of status.openRows) {
      out(
        `  [${row.kind}] ${row.id}  seen×${row.seenCount}  ${row.title}`,
      )
    }
  }
}

const budgetStatus: Command = {
  path: 'budget status',
  summary: 'show spend-meter thresholds, current burn, and open budget rows',
  usage: 'usage: mars budget status [--json]',
  run: async (args, deps) => {
    void deps.ctx
    const status = await computeBudgetStatus(deps.store)
    // `--json` is a boolean flag; parseArgs leaves it in positional.
    if (args.positional.includes('--json')) {
      deps.out(JSON.stringify(status, null, 2))
      return { code: 0, value: status }
    }
    renderStatus(status, deps.out)
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

export const budgetCommands: readonly Command[] = [
  budgetSet,
  budgetStatus,
  budgetGroup,
]
