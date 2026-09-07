/**
 * `mars kpi drill <key>` — per-arc cost breakdown for a KPI key.
 *
 * Prints a table of arcs sorted descending by total weighted tokens, with
 * per-phase columns (code, verify, setup, other).  A footer shows the median
 * and p90 of the displayed arcs.
 *
 * Currently only `cost_per_arc` is supported; additional keys will be added
 * in later slices.
 */

import type { Command } from '../command'

/** KPI metric keys accepted by `kpi drill`. */
const DRILL_KEYS = ['cost_per_arc'] as const
type DrillKey = (typeof DRILL_KEYS)[number]
const isDrillKey = (k: string | undefined): k is DrillKey =>
  k !== undefined && (DRILL_KEYS as readonly string[]).includes(k)

const DEFAULT_LIMIT = 20

// ── Table layout ──────────────────────────────────────────────────────────────

const COL_ARC = 14
const COL_TITLE = 36
const COL_TOTAL = 14
const COL_PHASE = 12

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + '…'
}

function fmtN(n: number | undefined): string {
  if (n === undefined || n === 0) return '0'
  return Math.round(n).toString()
}

/** Linear-interpolation percentile on a pre-sorted array. */
function pct(sorted: readonly number[], p: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const i = p * (n - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (i - lo) * (sorted[hi]! - sorted[lo]!)
}

// ── Command ───────────────────────────────────────────────────────────────────

export const kpiDrillCommand: Command = {
  path: 'kpi drill',
  summary: 'show per-arc cost breakdown ranked by total weighted tokens',
  usage: `usage: mars kpi drill <${DRILL_KEYS.join('|')}> [--limit <n>] [--tail]`,
  flags: [
    {
      syntax: '--limit <n>',
      description: `max arcs to display (default: ${DEFAULT_LIMIT})`,
    },
    {
      syntax: '--tail',
      description: 'show only arcs above the p90 cost threshold',
    },
  ],
  run: async (args, deps) => {
    const key = args.positional[0]
    if (!isDrillKey(key)) {
      deps.err(
        `mars kpi drill: unknown key '${key ?? ''}'\n` +
          `usage: mars kpi drill <${DRILL_KEYS.join('|')}> [--limit <n>]`,
      )
      return { code: 1 }
    }

    const limitRaw = args.flags['--limit']
    const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_LIMIT
    if (!Number.isFinite(limit) || limit < 1) {
      deps.err(
        `mars kpi drill: --limit must be a positive integer\n` +
          `usage: mars kpi drill <${DRILL_KEYS.join('|')}> [--limit <n>]`,
      )
      return { code: 1 }
    }

    const { listKpiArcs } = await import('../../core/daemon/kpi-store.js')
    const result = await listKpiArcs(key, deps.store)

    // Sort descending by total weighted tokens, slice to limit.
    let rows = [...result.arcs]
      .sort((a, b) => (b.costTokens ?? 0) - (a.costTokens ?? 0))
      .slice(0, limit)

    const isTail = args.flags['--tail'] !== undefined
    let p90Cutoff = 0
    if (isTail) {
      const allCosts = result.arcs.map((a) => a.costTokens ?? 0).sort((a, b) => a - b)
      p90Cutoff = pct(allCosts, 0.9)
      rows = rows.filter((a) => (a.costTokens ?? 0) > p90Cutoff)
    }

    // ── Header ───────────────────────────────────────────────────────────────
    const header =
      'arc_id'.padEnd(COL_ARC) +
      'title'.padEnd(COL_TITLE) +
      'total'.padStart(COL_TOTAL) +
      'code'.padStart(COL_PHASE) +
      'verify'.padStart(COL_PHASE) +
      'setup'.padStart(COL_PHASE) +
      'other'.padStart(COL_PHASE)

    const sep = '─'.repeat(COL_ARC + COL_TITLE + COL_TOTAL + COL_PHASE * 4)

    deps.out(header)
    deps.out(sep)

    // ── Rows ──────────────────────────────────────────────────────────────────
    for (const arc of rows) {
      const bd = arc.phaseBreakdown ?? {}
      const code = bd['code'] ?? 0
      const verify = bd['verify'] ?? 0
      const setup = bd['setup'] ?? 0
      const other = Object.entries(bd)
        .filter(([k]) => k !== 'code' && k !== 'verify' && k !== 'setup')
        .reduce((sum, [, v]) => sum + v, 0)

      deps.out(
        truncate(arc.arcId, COL_ARC).padEnd(COL_ARC) +
          truncate(arc.title || '(no title)', COL_TITLE).padEnd(COL_TITLE) +
          fmtN(arc.costTokens).padStart(COL_TOTAL) +
          fmtN(code).padStart(COL_PHASE) +
          fmtN(verify).padStart(COL_PHASE) +
          fmtN(setup).padStart(COL_PHASE) +
          fmtN(other).padStart(COL_PHASE),
      )
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    deps.out('')
    if (rows.length === 0) {
      deps.out(isTail ? 'no arcs above p90 threshold' : 'no arcs in window')
    } else if (isTail) {
      deps.out(
        `p90 cutoff: ${fmtN(p90Cutoff)}  (${rows.length} arc${rows.length === 1 ? '' : 's'} above)`,
      )
    } else {
      const totals = rows.map((a) => a.costTokens ?? 0).sort((a, b) => a - b)
      const p50 = pct(totals, 0.5)
      const p90 = pct(totals, 0.9)
      deps.out(
        `median: ${fmtN(p50)}  p90: ${fmtN(p90)}  (${rows.length} arc${rows.length === 1 ? '' : 's'} shown)`,
      )
    }

    return { code: 0 }
  },
}
