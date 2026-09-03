/**
 * `kpi breakdown` command — failure-rate drill-down by signature family.
 *
 * Reads the same window as the latest persisted KPI snapshot (falling back to
 * the trailing 7 days when no snapshot exists yet) and groups the failed arcs
 * in that window by their failure-signature family, producing a ranked table
 * that reveals which error classes are driving the failure_rate regression.
 *
 * Usage:
 *   mars kpi breakdown           — pretty table
 *   mars kpi breakdown --json    — machine-readable JSON
 *
 * Table columns:
 *   family           — `<gate>/<error-class>` (failureSignatureFamily output)
 *   count            — number of failed arcs in this family
 *   pct-of-failed    — count / totalFailed * 100, one decimal
 *   example-task-id  — originTaskId of the first arc seen for this family
 *
 * Footer:  `N passed  M failed`
 *
 * When totalFailed === 0 prints `no failed arcs in window` and exits 0.
 */

import type { Command } from '../command'

// ── Column widths (matching kpi-compare.ts aesthetic) ─────────────────────────

const COL_FAMILY = 42
const COL_COUNT = 8
const COL_PCT = 15
const COL_EXAMPLE = 20

// ── Command ───────────────────────────────────────────────────────────────────

const kpiBreakdown: Command = {
  path: 'kpi breakdown',
  summary: 'break down failure rate by signature family',
  usage: 'mars kpi breakdown [--json]',
  helpBody: [
    'mars kpi breakdown [--json]',
    '',
    'Group the failed arcs in the current KPI window by their failure-signature',
    'family and print a table ranked by count. Reveals which error classes are',
    'driving a failure_rate regression.',
    '',
    'The window is taken from the latest persisted KPI snapshot (same as',
    '`mars kpi compare`). When no snapshot exists yet it falls back to the',
    'trailing 7 days.',
    '',
    'Columns:',
    '  family          — <gate>/<error-class> (failureSignatureFamily)',
    '  count           — number of failed arcs in this family',
    '  pct-of-failed   — share of total failed arcs (%)',
    '  example-task-id — one representative arc origin task id',
    '',
    'Options:',
    '  --json   emit machine-readable JSON instead of the table',
    '',
    'JSON schema:',
    '  { window: { windowStart, windowEnd },',
    '    totalPassed, totalFailed,',
    '    families: [{ family, count, pct, exampleTaskId }] }',
    '',
    'Examples:',
    '  mars kpi breakdown',
    '  mars kpi breakdown --json | jq .families',
  ].join('\n'),
  flags: [{ syntax: '--json', description: 'emit machine-readable JSON' }],

  run: async (args, deps) => {
    const store = deps.store
    const jsonMode = args.flags['--json'] !== undefined
    const now = new Date().toISOString()

    // ── Resolve the KPI window ──────────────────────────────────────────────

    const { readKpiWindowComparison } = await import('../../core/lib/kpi-snapshots.js')
    const { listFailureRateArcs } = await import('../../core/lib/kpi-compute.js')
    const { failureSignatureFamily } = await import('../../core/lib/failure-signature.js')

    const { current } = await readKpiWindowComparison({ now, store })
    const window =
      current !== null
        ? { windowStart: current.window_start, windowEnd: current.window_end }
        : {
            windowStart: new Date(
              new Date(now).getTime() - 7 * 24 * 60 * 60 * 1000,
            ).toISOString(),
            windowEnd: now,
          }

    // ── Fetch arcs and partition ────────────────────────────────────────────

    const arcs = await listFailureRateArcs(store, window)
    const failedArcs = arcs.filter((a) => !a.passed)
    const totalPassed = arcs.length - failedArcs.length
    const totalFailed = failedArcs.length

    if (totalFailed === 0) {
      deps.out('no failed arcs in window')
      return { code: 0 }
    }

    // ── Fetch failure_signature for each failed origin task ─────────────────
    //
    // Build a single IN-list query so we pay one round-trip regardless of arc count.

    const originIds = failedArcs.map((a) => a.originTaskId)
    const placeholders = originIds.map(() => '?').join(', ')
    const sigResult = await store.query({
      sql: `SELECT id, failure_signature FROM tasks WHERE id IN (${placeholders})`,
      args: originIds,
    })

    const sigMap = new Map<string, string | null>()
    for (const raw of sigResult.rows) {
      const row = raw as unknown as { id: string; failure_signature: string | null }
      sigMap.set(row.id, row.failure_signature ?? null)
    }

    // ── Group by family ─────────────────────────────────────────────────────

    const familyMap = new Map<string, { count: number; exampleTaskId: string }>()
    for (const arc of failedArcs) {
      const sig = sigMap.get(arc.originTaskId) ?? null
      const family = sig !== null ? failureSignatureFamily(sig) : '(unknown)'
      const entry = familyMap.get(family)
      if (entry !== undefined) {
        entry.count++
      } else {
        familyMap.set(family, { count: 1, exampleTaskId: arc.originTaskId })
      }
    }

    const families = [...familyMap.entries()]
      .map(([family, { count, exampleTaskId }]) => ({
        family,
        count,
        pct: (count / totalFailed) * 100,
        exampleTaskId,
      }))
      .sort((a, b) => b.count - a.count)

    // ── Emit ────────────────────────────────────────────────────────────────

    if (jsonMode) {
      deps.out(
        JSON.stringify({ window, totalPassed, totalFailed, families }),
      )
      return { code: 0 }
    }

    const sep = '─'.repeat(COL_FAMILY + COL_COUNT + COL_PCT + COL_EXAMPLE)

    deps.out(
      'family'.padEnd(COL_FAMILY) +
        'count'.padEnd(COL_COUNT) +
        'pct-of-failed'.padEnd(COL_PCT) +
        'example-task-id'.padEnd(COL_EXAMPLE),
    )
    deps.out(sep)

    for (const e of families) {
      deps.out(
        e.family.padEnd(COL_FAMILY) +
          String(e.count).padEnd(COL_COUNT) +
          `${e.pct.toFixed(1)}%`.padEnd(COL_PCT) +
          e.exampleTaskId.padEnd(COL_EXAMPLE),
      )
    }

    deps.out(sep)
    deps.out(`${totalPassed} passed  ${totalFailed} failed`)

    return { code: 0 }
  },
}

export const kpiBreakdownCommands: readonly Command[] = [kpiBreakdown]
