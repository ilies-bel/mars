import { z } from 'zod'
import { readDaemonConfigFile, patchDaemonConfigFile } from '../daemon/config'
import type { DomainTaskStore } from '../store/task-store'

export const budgetConfigSchema = z.object({
  windowMs: z.number().int().positive().nullish(),
  windowTokens: z.number().int().positive().nullish(),
  arcTokens: z.number().int().positive().nullish(),
})

export type BudgetConfigInput = z.infer<typeof budgetConfigSchema>

export interface BudgetConfig {
  windowMs: number | null
  windowTokens: number | null
  arcTokens: number | null
}

export interface ArcSpend {
  arcId: string
  spendTokens: number
}

export type SpendBand = 'good' | 'warn' | 'bad'

export interface BudgetStatus {
  configured: boolean
  config: BudgetConfig | null
  window: {
    windowMs: number
    thresholdTokens: number
    spendTokens: number
    ratio: number
    band: SpendBand
    topArcs: ArcSpend[]
  } | null
  arcs: {
    ceilingTokens: number
    liveArcs: Array<ArcSpend & { ratio: number; overCeiling: boolean }>
  } | null
  openRows: Array<{
    id: string
    kind: 'budget-window' | 'budget-arc'
    signature: string | null
    title: string
    raisedAt: string
    lastSeenAt: string
    seenCount: number
  }>
}

export const readBudgetConfig = (): BudgetConfig | null => {
  const parsed = budgetConfigSchema.safeParse(readDaemonConfigFile().budget)
  if (!parsed.success) return null
  const config = {
    windowMs: parsed.data.windowMs ?? null,
    windowTokens: parsed.data.windowTokens ?? null,
    arcTokens: parsed.data.arcTokens ?? null,
  }
  return Object.values(config).some((value) => value !== null) ? config : null
}

export const writeBudgetConfig = (patch: BudgetConfigInput): BudgetConfig | null => {
  const validated = budgetConfigSchema.parse(patch)
  const current = budgetConfigSchema.safeParse(readDaemonConfigFile().budget)
  const merged = { ...(current.success ? current.data : {}), ...validated }
  const budget = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => typeof value === 'number'),
  )
  patchDaemonConfigFile({ budget: Object.keys(budget).length > 0 ? budget : null })
  return readBudgetConfig()
}

export const parseDurationToMs = (raw: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim())
  if (!match) {
    throw new Error(`invalid duration '${raw}' — expected e.g. 4h, 30m, 90s, 500ms`)
  }
  const multiplier =
    match[2] === 'd'
      ? 86_400_000
      : match[2] === 'h'
        ? 3_600_000
        : match[2] === 'm'
          ? 60_000
          : match[2] === 's'
            ? 1_000
            : 1
  const milliseconds = Math.round(Number(match[1]) * multiplier)
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error(`invalid duration '${raw}' — must be positive`)
  }
  return milliseconds
}

export const parsePositiveInt = (raw: string, name: string): number => {
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; got '${raw}'`)
  }
  return value
}

const weightedTokens = `
  CAST(te.payload::jsonb #>> '{usageSignals,inputTokens}' AS double precision) +
  CAST(te.payload::jsonb #>> '{usageSignals,outputTokens}' AS double precision) +
  CAST(te.payload::jsonb #>> '{usageSignals,cacheCreateTokens}' AS double precision) +
  CAST(te.payload::jsonb #>> '{usageSignals,cacheReadTokens}' AS double precision) * 0.1
`

export const computeBudgetStatus = async (
  store: DomainTaskStore,
  now: Date = new Date(),
): Promise<BudgetStatus> => {
  const config = readBudgetConfig()
  if (config === null) {
    return { configured: false, config: null, window: null, arcs: null, openRows: [] }
  }

  const window =
    config.windowMs !== null && config.windowTokens !== null
      ? await (async () => {
          const sinceIso = new Date(now.getTime() - config.windowMs!).toISOString()
          const spendResult = await store.query({
            sql: `SELECT COALESCE(SUM(${weightedTokens}), 0) AS weighted_tokens
                  FROM trace_events te
                  WHERE te.kind = 'step_ended'
                    AND te.timestamp >= ?
                    AND te.payload::jsonb ->> 'usageSignals' IS NOT NULL`,
            args: [sinceIso],
          })
          const spendTokens = Number(
            (spendResult.rows[0] as { weighted_tokens?: number } | undefined)?.weighted_tokens ?? 0,
          )
          const ratio = spendTokens / config.windowTokens!
          const band: SpendBand = ratio >= 1 ? 'bad' : ratio >= 0.7 ? 'warn' : 'good'
          const topArcsResult = await store.query({
            sql: `SELECT COALESCE(te.origin_id, te.task_id) AS arc_id,
                         SUM(${weightedTokens}) AS weighted_tokens
                  FROM trace_events te
                  WHERE te.kind = 'step_ended'
                    AND te.timestamp >= ?
                    AND te.payload::jsonb ->> 'usageSignals' IS NOT NULL
                    AND COALESCE(te.origin_id, te.task_id) IS NOT NULL
                  GROUP BY COALESCE(te.origin_id, te.task_id)
                  ORDER BY weighted_tokens DESC
                  LIMIT 5`,
            args: [sinceIso],
          })
          return {
            windowMs: config.windowMs!,
            thresholdTokens: config.windowTokens!,
            spendTokens,
            ratio,
            band,
            topArcs: topArcsResult.rows.map((row) => {
              const value = row as { arc_id: string; weighted_tokens: number }
              return { arcId: value.arc_id, spendTokens: Number(value.weighted_tokens) }
            }),
          }
        })()
      : null
  const arcs = config.arcTokens === null ? null : await (async () => {
    const liveArcsResult = await store.query({
      sql: `WITH live_arcs AS (
              SELECT arc_id FROM (
                SELECT COALESCE(origin_id, id) AS arc_id,
                       MAX(CASE WHEN status NOT IN ('done', 'failed', 'dropped') THEN 1 ELSE 0 END) AS is_live
                FROM tasks
                GROUP BY COALESCE(origin_id, id)
              ) arcs WHERE is_live = 1
            )
            SELECT la.arc_id, SUM(${weightedTokens}) AS weighted_tokens
            FROM live_arcs la
            JOIN tasks t ON COALESCE(t.origin_id, t.id) = la.arc_id
            JOIN trace_events te ON te.task_id = t.id
              AND te.kind = 'step_ended'
              AND te.payload::jsonb ->> 'usageSignals' IS NOT NULL
            GROUP BY la.arc_id
            ORDER BY weighted_tokens DESC
            LIMIT 10`,
      args: [],
    })
    return {
      ceilingTokens: config.arcTokens!,
      liveArcs: liveArcsResult.rows.map((row) => {
        const value = row as { arc_id: string; weighted_tokens: number }
        const spendTokens = Number(value.weighted_tokens)
        return {
          arcId: value.arc_id,
          spendTokens,
          ratio: spendTokens / config.arcTokens!,
          overCeiling: spendTokens >= config.arcTokens!,
        }
      }),
    }
  })()
  const openRowsResult = await store.query({
    sql: `SELECT id, kind, signature, title, raised_at, last_seen_at, seen_count
          FROM action_queue_items
          WHERE state = 'open' AND kind IN ('budget-window', 'budget-arc')
          ORDER BY raised_at DESC`,
    args: [],
  })
  const openRows = openRowsResult.rows.map((row) => {
    const value = row as {
      id: string
      kind: 'budget-window' | 'budget-arc'
      signature: string | null
      title: string
      raised_at: string
      last_seen_at: string
      seen_count: number
    }
    return {
      id: value.id,
      kind: value.kind,
      signature: value.signature,
      title: value.title,
      raisedAt: value.raised_at,
      lastSeenAt: value.last_seen_at,
      seenCount: Number(value.seen_count),
    }
  })

  return { configured: true, config, window, arcs, openRows }
}
