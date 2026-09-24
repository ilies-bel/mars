/**
 * Proposal yield metrics — the single definition of "action rate".
 *
 * A proposal counts as *actioned* when it left the draft pile in a productive
 * direction. Every reader (CLI, detector, notice) goes through this module so
 * the number cannot drift between surfaces.
 */

import type { DbClient } from './db.js'
import { VALID_SOURCES, type ProposalSource } from '../proposals.js'

export const ACTIONED_PROPOSAL_STATUSES = ['sliced', 'taken', 'prd-ready'] as const

export interface SourceYieldRow {
  source: ProposalSource
  total: number
  sliced: number
  prdReady: number
  actionedPct: number
}

export interface MonthVolumeRow {
  month: string
  created: number
  actioned: number
  ratePct: number
}

export interface ActionRateWindow {
  created: number
  actioned: number
  ratePct: number
}

const ACTIONED_PLACEHOLDERS = ACTIONED_PROPOSAL_STATUSES.map(() => '?').join(', ')

const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 100)

export const computeYieldBySource = async (
  c: DbClient,
  opts: { sinceMs?: number } = {},
): Promise<SourceYieldRow[]> => {
  const result = await c.execute({
    sql: `SELECT source,
                 COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE status = 'sliced') AS sliced,
                 COUNT(*) FILTER (WHERE status = 'prd-ready') AS prd_ready,
                 COUNT(*) FILTER (WHERE status IN (${ACTIONED_PLACEHOLDERS})) AS actioned
            FROM proposals
           WHERE created_at >= ?
           GROUP BY source`,
    args: [...ACTIONED_PROPOSAL_STATUSES, opts.sinceMs ?? 0],
  })
  const bySource = new Map(
    (result.rows as unknown as Array<Record<string, unknown>>).map((r) => [String(r.source), r]),
  )
  return VALID_SOURCES.map((source) => {
    const row = bySource.get(source)
    const total = Number(row?.total ?? 0)
    return {
      source,
      total,
      sliced: Number(row?.sliced ?? 0),
      prdReady: Number(row?.prd_ready ?? 0),
      actionedPct: pct(Number(row?.actioned ?? 0), total),
    }
  })
}

export const computeVolumeByMonth = async (
  c: DbClient,
  opts: { monthsBack?: number; now?: () => number } = {},
): Promise<MonthVolumeRow[]> => {
  const monthsBack = opts.monthsBack ?? 6
  const now = new Date((opts.now ?? Date.now)())
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1)

  const result = await c.execute({
    sql: `SELECT to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
                 COUNT(*) AS created,
                 COUNT(*) FILTER (WHERE status IN (${ACTIONED_PLACEHOLDERS})) AS actioned
            FROM proposals
           WHERE created_at >= ?
           GROUP BY month`,
    args: [...ACTIONED_PROPOSAL_STATUSES, startMs],
  })
  const byMonth = new Map(
    (result.rows as unknown as Array<Record<string, unknown>>).map((r) => [String(r.month), r]),
  )

  const rows: MonthVolumeRow[] = []
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1) + i, 1))
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const row = byMonth.get(month)
    const created = Number(row?.created ?? 0)
    const actioned = Number(row?.actioned ?? 0)
    rows.push({ month, created, actioned, ratePct: pct(actioned, created) })
  }
  return rows
}

export const computeActionRate = async (
  c: DbClient,
  window: { fromMs: number; toMs: number },
): Promise<ActionRateWindow> => {
  const result = await c.execute({
    sql: `SELECT COUNT(*) AS created,
                 COUNT(*) FILTER (WHERE status IN (${ACTIONED_PLACEHOLDERS})) AS actioned
            FROM proposals
           WHERE created_at >= ? AND created_at < ?`,
    args: [...ACTIONED_PROPOSAL_STATUSES, window.fromMs, window.toMs],
  })
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined
  const created = Number(row?.created ?? 0)
  const actioned = Number(row?.actioned ?? 0)
  return { created, actioned, ratePct: pct(actioned, created) }
}
