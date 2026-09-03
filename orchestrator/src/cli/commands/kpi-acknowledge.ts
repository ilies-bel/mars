/**
 * `mars kpi acknowledge` — persist or clear a KPI drift baseline.
 *
 * When the operator acknowledges a known KPI regression, the current snapshot
 * value is stored in `kpi_acknowledged_baselines`. Subsequent self-evolve
 * drift checks compare against the acknowledged value instead of the
 * prior-window snapshot, so the same known regression is not re-raised as a
 * proposal after the cooldown expires.
 *
 * Usage:
 *   mars kpi acknowledge <key> [--reason <text>]   — upsert the current snapshot value
 *   mars kpi acknowledge --clear <key>             — remove the baseline for <key>
 *   mars kpi acknowledge --list                    — list all acknowledged baselines
 *
 * Accepted <key> values match the KPI column names in kpi_snapshots:
 *   failure_rate, cost_per_arc_p50, cost_per_arc_p90,
 *   autonomous_completion_rate, recovery_success_rate
 */

import { hasFlag } from '../args'
import type { Command } from '../command'

/** KPI column names that can be acknowledged (must match kpi_snapshots columns). */
const KPI_ACKNOWLEDGE_KEYS = [
  'failure_rate',
  'cost_per_arc_p50',
  'cost_per_arc_p90',
  'autonomous_completion_rate',
  'recovery_success_rate',
] as const

type KpiAcknowledgeKey = (typeof KPI_ACKNOWLEDGE_KEYS)[number]

const isKpiAcknowledgeKey = (k: string | undefined): k is KpiAcknowledgeKey =>
  k !== undefined && (KPI_ACKNOWLEDGE_KEYS as readonly string[]).includes(k)

const USAGE =
  `usage: mars kpi acknowledge <${KPI_ACKNOWLEDGE_KEYS.join('|')}> [--reason <text>]\n` +
  `       mars kpi acknowledge --clear <key>\n` +
  `       mars kpi acknowledge --list`

const kpiAcknowledgeCmd: Command = {
  path: 'kpi acknowledge',
  summary: 'acknowledge the current KPI drift level as the new baseline',
  usage: USAGE,
  flags: [
    {
      syntax: '--reason <text>',
      description: 'note explaining why this drift level is expected',
    },
    {
      syntax: '--clear',
      description: 'remove the acknowledged baseline for <key>',
    },
    {
      syntax: '--list',
      description: 'list all acknowledged baselines',
    },
  ],
  run: async (args, deps) => {
    const { acknowledgeKpiBaseline, clearKpiBaseline, listKpiBaselines } =
      await import('../../core/lib/kpi-baseline.js')

    const listMode = hasFlag(args, '--list')
    const clearMode = hasFlag(args, '--clear')

    // ── --list ────────────────────────────────────────────────────────────────
    if (listMode) {
      const baselines = await listKpiBaselines(deps.store)
      if (baselines.length === 0) {
        deps.out('no acknowledged baselines')
        return { code: 0 }
      }
      for (const b of baselines) {
        const reasonSuffix = b.reason ? `  reason=${b.reason}` : ''
        deps.out(
          `${b.kpi_key}  value=${b.value}  at=${b.acknowledged_at}${reasonSuffix}`,
        )
      }
      return { code: 0 }
    }

    // For --clear and the default acknowledge path, a valid <key> is required.
    const kpiKey = args.positional[0]
    if (!isKpiAcknowledgeKey(kpiKey)) {
      deps.err(
        `mars kpi acknowledge: missing or unknown key '${kpiKey ?? ''}'\n${USAGE}`,
      )
      return { code: 1 }
    }

    // ── --clear ───────────────────────────────────────────────────────────────
    if (clearMode) {
      await clearKpiBaseline(deps.store, kpiKey)
      deps.out(`cleared acknowledged baseline for ${kpiKey}`)
      return { code: 0 }
    }

    // ── acknowledge (upsert current snapshot value) ───────────────────────────
    const { readLatestKpiSnapshot } = await import('../../core/lib/kpi-snapshots.js')
    const snapshot = await readLatestKpiSnapshot(deps.store)
    if (snapshot === null) {
      deps.err(
        'mars kpi acknowledge: no KPI snapshot found — run `mars kpi snapshot` first',
      )
      return { code: 1 }
    }

    const value = (snapshot as unknown as Record<string, number | null>)[kpiKey]
    if (value === null || value === undefined) {
      deps.err(
        `mars kpi acknowledge: no value for '${kpiKey}' in the latest snapshot ` +
          '(low confidence or no samples)',
      )
      return { code: 1 }
    }

    const reason = args.flags['--reason']
    await acknowledgeKpiBaseline(deps.store, kpiKey, value, reason)
    deps.out(`acknowledged ${kpiKey} = ${value} as the drift baseline`)
    return { code: 0 }
  },
}

export const kpiAcknowledgeCommands: readonly Command[] = [kpiAcknowledgeCmd]
