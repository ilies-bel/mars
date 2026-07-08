/**
 * Spend meter — observe-and-warn token-budget alerting.
 *
 * Two independent meters, each with its own threshold and its own
 * level-triggered action-queue row (ADR-0048 pure projection):
 *
 * 1. ROLLING-WINDOW METER — sums cache-weighted tokens across ALL arcs
 *    (including in-flight ones) over a configurable wall-clock window,
 *    straight off `trace_events` rows with kind='step_ended' and a
 *    `payload.usageSignals` object. Unlike cost_per_arc there is NO join to
 *    tasks and NO status filter — spend counts the moment each step lands.
 *    Backed by the partial index `idx_trace_events_step_ended_time`
 *    (see trace-events-store.ts) so each evaluation is an index range scan.
 * 2. PER-ARC CEILING METER — for each live (non-terminal) arc, sums the
 *    arc's LIFETIME weighted tokens using the same two trace_events join
 *    paths as computeCostPerArcDistribution (member-task + dangling-origin)
 *    minus the done-arcs filter.
 *
 * Weighting is the canonical {@link cacheWeightedTokens} semantics from
 * kpi-compute.ts (input + output + cacheCreate + cacheRead*0.1), pushed into
 * SQL exactly as cost_per_arc already does. A provider-rejected (429) call
 * produces no usageSignals, so a rate-limit storm adds ~nothing here — that
 * reactive path belongs to the provider-rate-limit proposal, not this meter.
 *
 * The meter NEVER pauses dispatch and NEVER suppresses recoveries. Its only
 * outputs are the two action-queue rows, `mars budget status`, the daemon's
 * GET /budget route, and the UI spend-meter tile. The operator is the only
 * actuator.
 */

import { z } from 'zod'
import type { DomainTaskStore as TaskStore } from '../store/task-store.js'
import {
  listActionQueueItems,
  patchActionQueuePayloadById,
  raiseActionQueueItem,
  setActionQueueState,
} from './action-queue.js'
import { readDaemonConfigFile, patchDaemonConfigFile } from '../daemon/config.js'
import { INDEX_STEP_ENDED_TIME } from './trace-events-store.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The `budget` key in `.mars/daemon.json`. Every field is optional — each
 * meter is independently enabled by its own fields being present:
 * the window meter needs `windowMs` + `windowTokens`; the arc meter needs
 * `arcTokens`. An absent/empty budget key means the whole meter is disabled
 * (the default: zero new rows until an operator opts in via
 * `mars budget set`).
 */
export const budgetConfigSchema = z.object({
  /** Rolling wall-clock window length in milliseconds. */
  windowMs: z.number().int().positive().nullish(),
  /** Cache-weighted token threshold for the rolling window. */
  windowTokens: z.number().int().positive().nullish(),
  /** Cache-weighted lifetime token ceiling for a single live arc. */
  arcTokens: z.number().int().positive().nullish(),
})

export type BudgetConfigInput = z.infer<typeof budgetConfigSchema>

/** Normalised budget config: every field present, `null` = unset. */
export interface BudgetConfig {
  windowMs: number | null
  windowTokens: number | null
  arcTokens: number | null
}

/**
 * Read the budget config from `.mars/daemon.json`. Returns `null` when the
 * `budget` key is absent, invalid, or names no thresholds at all — callers
 * treat `null` as "meter disabled". Re-read on every call so `mars budget
 * set` takes effect on the next sweep tick without a daemon restart.
 */
export const readBudgetConfig = (): BudgetConfig | null => {
  const file = readDaemonConfigFile()
  const parsed = budgetConfigSchema.safeParse(file.budget)
  if (!parsed.success) return null
  const cfg: BudgetConfig = {
    windowMs: parsed.data.windowMs ?? null,
    windowTokens: parsed.data.windowTokens ?? null,
    arcTokens: parsed.data.arcTokens ?? null,
  }
  if (cfg.windowMs === null && cfg.windowTokens === null && cfg.arcTokens === null) {
    return null
  }
  return cfg
}

/**
 * Merge-patch the budget config into `.mars/daemon.json` (any subset of
 * fields; unnamed fields are preserved). Values are validated as positive
 * integers via {@link budgetConfigSchema} — invalid input throws. Returns
 * the resulting normalised config (or `null` when the write cleared every
 * threshold).
 */
export const writeBudgetConfig = (
  patch: BudgetConfigInput,
): BudgetConfig | null => {
  const validated = budgetConfigSchema.parse(patch)
  const file = readDaemonConfigFile()
  const currentParsed = budgetConfigSchema.safeParse(file.budget)
  const current: BudgetConfigInput = currentParsed.success ? currentParsed.data : {}
  const merged: Record<string, number> = {}
  const pick = (key: keyof BudgetConfigInput): void => {
    const value = key in validated ? validated[key] : current[key]
    if (typeof value === 'number') merged[key] = value
  }
  pick('windowMs')
  pick('windowTokens')
  pick('arcTokens')
  patchDaemonConfigFile({
    budget: Object.keys(merged).length > 0 ? merged : null,
  })
  return readBudgetConfig()
}

/**
 * Parse a human duration ('4h', '30m', '90s', '2d', '500ms', or a bare
 * integer meaning milliseconds) into a positive integer of milliseconds.
 * Throws on anything else.
 */
export const parseDurationToMs = (raw: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim())
  if (!match) {
    throw new Error(
      `invalid duration '${raw}' — expected e.g. 4h, 30m, 90s, 500ms`,
    )
  }
  const value = Number(match[1])
  const unit = match[2] ?? 'ms'
  const multiplier =
    unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  const ms = Math.round(value * multiplier)
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`invalid duration '${raw}' — must be positive`)
  }
  return ms
}

// ---------------------------------------------------------------------------
// Banding
// ---------------------------------------------------------------------------

export type SpendBand = 'good' | 'warn' | 'bad'

/**
 * %-of-threshold banding for the spend meter (NOT a fifth KPI — the UI
 * reuses the KpiBand cue vocabulary for rendering only):
 * < 70% good, 70–100% warn, >= 100% bad.
 */
export const spendBand = (ratio: number): SpendBand => {
  if (ratio >= 1) return 'bad'
  if (ratio >= 0.7) return 'warn'
  return 'good'
}

/**
 * Anti-flap hysteresis for the window row: once raised, the row only
 * auto-resolves when a sweep measures spend BELOW this fraction of the
 * threshold (old events aged out of the window).
 */
export const WINDOW_HYSTERESIS_RATIO = 0.9

export const BUDGET_WINDOW_SIGNATURE = 'budget-window'
export const budgetArcSignature = (arcId: string): string => `budget-arc:${arcId}`

// ---------------------------------------------------------------------------
// SQL — the canonical cache-weighted expression, pushed into SQL exactly as
// computeCostPerArcDistribution does (single source of truth for the
// constants is cacheWeightedTokens() in kpi-compute.ts).
// ---------------------------------------------------------------------------

const WEIGHTED_TOKENS_EXPR = `
  CAST(json_extract(te.payload, '$.usageSignals.inputTokens')       AS REAL) +
  CAST(json_extract(te.payload, '$.usageSignals.outputTokens')      AS REAL) +
  CAST(json_extract(te.payload, '$.usageSignals.cacheCreateTokens') AS REAL) +
  CAST(json_extract(te.payload, '$.usageSignals.cacheReadTokens')   AS REAL) * 0.1
`

const TERMINAL_STATUSES_SQL = `('done', 'failed', 'dropped')`

/** One arc's cache-weighted token spend. */
export interface ArcSpend {
  arcId: string
  spendTokens: number
}

/**
 * Rolling-window fleet burn: SUM of cache-weighted tokens over ALL
 * step_ended events since `sinceIso`. KEY DIFFERENCE from cost_per_arc:
 * the predicate is `trace_events.timestamp >= sinceIso` with NO tasks join
 * and NO status filter — in-flight arcs count the moment each step lands.
 * Index range scan over `idx_trace_events_step_ended_time`.
 * Events without usageSignals (e.g. provider-rejected calls) contribute
 * nothing.
 */
export const computeWindowSpend = async (
  surface: TaskStore,
  opts: { sinceIso: string },
): Promise<number> => {
  const result = await surface.query({
    sql: `SELECT COALESCE(SUM(${WEIGHTED_TOKENS_EXPR}), 0) AS weighted_tokens
          FROM trace_events te
          WHERE te.kind = 'step_ended'
            AND te.timestamp >= ?
            AND json_extract(te.payload, '$.usageSignals') IS NOT NULL`,
    args: [opts.sinceIso],
  })
  const row = result.rows[0] as unknown as { weighted_tokens: number | null }
  return row?.weighted_tokens ?? 0
}

/**
 * Top contributing arcs inside the window, for the budget-window row's
 * payload. Arc identity is COALESCE(origin_id, task_id) on the trace event
 * envelope (the arc root when origin_id is set; the task's own id when the
 * task is its own arc root).
 */
export const computeWindowTopArcs = async (
  surface: TaskStore,
  opts: { sinceIso: string; limit?: number },
): Promise<ArcSpend[]> => {
  const result = await surface.query({
    sql: `SELECT COALESCE(te.origin_id, te.task_id) AS arc_id,
                 SUM(${WEIGHTED_TOKENS_EXPR}) AS weighted_tokens
          FROM trace_events te
          WHERE te.kind = 'step_ended'
            AND te.timestamp >= ?
            AND json_extract(te.payload, '$.usageSignals') IS NOT NULL
            AND COALESCE(te.origin_id, te.task_id) IS NOT NULL
          GROUP BY COALESCE(te.origin_id, te.task_id)
          ORDER BY weighted_tokens DESC
          LIMIT ?`,
    args: [opts.sinceIso, opts.limit ?? 5],
  })
  return result.rows.map((row) => {
    const r = row as unknown as { arc_id: string; weighted_tokens: number }
    return { arcId: r.arc_id, spendTokens: r.weighted_tokens }
  })
}

/** The set of live arc ids (arcs with at least one non-terminal task). */
export const listLiveArcIds = async (surface: TaskStore): Promise<Set<string>> => {
  const result = await surface.query({
    sql: `SELECT arc_id FROM (
            SELECT COALESCE(origin_id, id) AS arc_id,
                   MAX(CASE WHEN status NOT IN ${TERMINAL_STATUSES_SQL} THEN 1 ELSE 0 END) AS is_live
            FROM tasks
            GROUP BY COALESCE(origin_id, id)
          ) WHERE is_live = 1`,
    args: [],
  })
  return new Set(
    result.rows.map((row) => (row as unknown as { arc_id: string }).arc_id),
  )
}

/**
 * Lifetime cache-weighted spend per LIVE arc. Reuses the two trace_events
 * join paths from computeCostPerArcDistribution (member-task path via
 * idx_trace_events_task_time, dangling-origin path via
 * idx_trace_events_origin_time) WITHOUT the done-arcs filter — an arc is in
 * scope while ANY of its tasks is non-terminal.
 *
 * `touchedSinceIso` makes the evaluation incremental in the useful sense:
 * only arcs with a new step_ended row at/after that timestamp are re-summed
 * (the sweep merges results into its cached per-arc totals).
 */
export const computeLiveArcSpends = async (
  surface: TaskStore,
  opts: { touchedSinceIso?: string } = {},
): Promise<ArcSpend[]> => {
  const touchedFilter =
    opts.touchedSinceIso !== undefined
      ? `AND arc_id IN (
           SELECT DISTINCT COALESCE(te2.origin_id, te2.task_id)
           FROM trace_events te2
           WHERE te2.kind = 'step_ended' AND te2.timestamp >= ?
         )`
      : ''
  const args =
    opts.touchedSinceIso !== undefined ? [opts.touchedSinceIso] : []
  const result = await surface.query({
    sql: `WITH live_arcs AS (
            SELECT arc_id FROM (
              SELECT COALESCE(origin_id, id) AS arc_id,
                     MAX(CASE WHEN status NOT IN ${TERMINAL_STATUSES_SQL} THEN 1 ELSE 0 END) AS is_live
              FROM tasks
              GROUP BY COALESCE(origin_id, id)
            ) WHERE is_live = 1 ${touchedFilter}
          ),
          arc_te AS (
            -- Path 1: trace event keyed by a member task id (normal dispatch path)
            SELECT la.arc_id, te.id AS te_id, te.payload
            FROM live_arcs la
            JOIN tasks t ON COALESCE(t.origin_id, t.id) = la.arc_id
            JOIN trace_events te ON te.task_id = t.id
              AND te.kind = 'step_ended'
              AND json_extract(te.payload, '$.usageSignals') IS NOT NULL
            UNION
            -- Path 2: trace event keyed by the arc/origin id directly
            -- (dangling-origin pattern: no task row has id=arc_id)
            SELECT la.arc_id, te.id AS te_id, te.payload
            FROM live_arcs la
            JOIN trace_events te ON te.task_id = la.arc_id
              AND te.kind = 'step_ended'
              AND json_extract(te.payload, '$.usageSignals') IS NOT NULL
          )
          SELECT la.arc_id,
                 COALESCE(SUM(
                   CAST(json_extract(ate.payload, '$.usageSignals.inputTokens')       AS REAL) +
                   CAST(json_extract(ate.payload, '$.usageSignals.outputTokens')      AS REAL) +
                   CAST(json_extract(ate.payload, '$.usageSignals.cacheCreateTokens') AS REAL) +
                   CAST(json_extract(ate.payload, '$.usageSignals.cacheReadTokens')   AS REAL) * 0.1
                 ), 0) AS weighted_tokens
          FROM live_arcs la
          INNER JOIN arc_te ate ON ate.arc_id = la.arc_id
          GROUP BY la.arc_id
          ORDER BY weighted_tokens DESC`,
    args,
  })
  return result.rows.map((row) => {
    const r = row as unknown as { arc_id: string; weighted_tokens: number }
    return { arcId: r.arc_id, spendTokens: r.weighted_tokens }
  })
}

// ---------------------------------------------------------------------------
// The spend sweep — raiser AND resolver (the projection driver)
// ---------------------------------------------------------------------------

/**
 * Mutable cross-tick state the daemon holds for the sweep: the previous
 * tick's timestamp (drives the incremental per-arc re-sum) and the cached
 * per-arc lifetime totals. Self-healing: a daemon restart just re-sums every
 * live arc on the first tick.
 */
export interface SpendSweepState {
  lastSweepIso: string | null
  arcSpends: Map<string, number>
  indexEnsured: boolean
}

export const createSpendSweepState = (): SpendSweepState => ({
  lastSweepIso: null,
  arcSpends: new Map(),
  indexEnsured: false,
})

/** What one sweep tick did — for the daemon log line. */
export interface SpendSweepReport {
  windowEnabled: boolean
  arcEnabled: boolean
  windowSpendTokens: number | null
  raised: string[]
  resolved: string[]
}

const RAISED_BY = 'daemon:spend-sweep'

/** Resolve every OPEN row of `kind` whose signature passes `match`. */
const resolveOpenRows = async (
  kind: 'budget-window' | 'budget-arc',
  match: (signature: string | null) => boolean,
  note: string,
): Promise<string[]> => {
  const open = await listActionQueueItems('open', { kind })
  const resolved: string[] = []
  for (const item of open) {
    if (!match(item.signature)) continue
    await setActionQueueState(item.id, 'resolved', {
      resolution: 'auto-resolved',
      note,
      by: RAISED_BY,
    })
    resolved.push(item.id)
  }
  return resolved
}

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/**
 * One evaluation tick of the spend meter. Re-reads config, runs the two
 * queries, and reconciles the level-triggered rows (ADR-0048): it raises
 * rows whose level condition is true (re-detections bump seen_count via the
 * raiseActionQueueItem dedupe) and resolves rows whose condition is false —
 * the sweep is both raiser and resolver, mirroring the breaker-close
 * resolution pattern. OBSERVE-AND-WARN ONLY: this function never touches
 * dispatch, semaphores, or recovery spawning.
 */
export const runSpendSweep = async (opts: {
  surface: TaskStore
  state: SpendSweepState
  now?: Date
}): Promise<SpendSweepReport> => {
  const { surface, state } = opts
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const config = readBudgetConfig()

  const raised: string[] = []
  const resolved: string[] = []

  if (!state.indexEnsured) {
    // The daemon's task-store connection may predate the partial index
    // shipping in openTraceEventStore; CREATE INDEX IF NOT EXISTS is
    // idempotent and cheap once present.
    await surface.execute(INDEX_STEP_ENDED_TIME)
    state.indexEnsured = true
  }

  const windowEnabled =
    config !== null && config.windowMs !== null && config.windowTokens !== null
  const arcEnabled = config !== null && config.arcTokens !== null

  // ── Rolling-window meter ──────────────────────────────────────────────────
  let windowSpendTokens: number | null = null
  if (windowEnabled && config !== null) {
    const windowMs = config.windowMs as number
    const windowTokens = config.windowTokens as number
    const sinceIso = new Date(now.getTime() - windowMs).toISOString()
    windowSpendTokens = await computeWindowSpend(surface, { sinceIso })
    const ratio = windowSpendTokens / windowTokens

    if (windowSpendTokens >= windowTokens) {
      const topArcs = await computeWindowTopArcs(surface, { sinceIso, limit: 5 })
      const payload = {
        windowMs,
        windowTokens,
        spendTokens: windowSpendTokens,
        pctOfThreshold: Math.round(ratio * 100),
        topArcs,
        measuredAt: nowIso,
      }
      const id = await raiseActionQueueItem({
        kind: 'budget-window',
        category: 'daemon',
        priority: 'high',
        title: `Spend meter: window burn ${formatTokens(windowSpendTokens)} weighted tokens ≥ threshold ${formatTokens(windowTokens)}`,
        body:
          `The rolling ${Math.round(windowMs / 60_000)}min window's cache-weighted token spend ` +
          `(${formatTokens(windowSpendTokens)}) crossed the configured window-tokens threshold ` +
          `(${formatTokens(windowTokens)}). All arcs count, including in-flight ones. ` +
          `Observe-and-warn only — dispatch continues untouched; attach, abort, or throttle by hand ` +
          `if the burn is unintended. The row auto-resolves once spend drops below ` +
          `${Math.round(WINDOW_HYSTERESIS_RATIO * 100)}% of the threshold.`,
        payload,
        context: {},
        raisedBy: RAISED_BY,
        signature: BUDGET_WINDOW_SIGNATURE,
      })
      // raiseActionQueueItem leaves an existing row's payload stale — keep
      // the live spend numbers fresh on re-detection.
      await patchActionQueuePayloadById(id, payload)
      raised.push(id)
    } else if (windowSpendTokens < windowTokens * WINDOW_HYSTERESIS_RATIO) {
      resolved.push(
        ...(await resolveOpenRows(
          'budget-window',
          () => true,
          `window spend ${formatTokens(windowSpendTokens)} below ${Math.round(WINDOW_HYSTERESIS_RATIO * 100)}% of threshold ${formatTokens(windowTokens)}`,
        )),
      )
    }
    // Between 90% and 100% of threshold: hysteresis dead zone — leave any
    // open row open, raise nothing.
  } else {
    // Window meter disabled: the level condition is undefined, so no
    // budget-window row may exist.
    resolved.push(
      ...(await resolveOpenRows('budget-window', () => true, 'window meter disabled')),
    )
  }

  // ── Per-arc ceiling meter ─────────────────────────────────────────────────
  if (arcEnabled && config !== null) {
    const arcTokens = config.arcTokens as number
    const liveArcIds = await listLiveArcIds(surface)

    // Incremental re-sum: only arcs touched since the previous sweep (full
    // re-sum on the first tick after daemon start).
    const spends = await computeLiveArcSpends(
      surface,
      state.lastSweepIso === null ? {} : { touchedSinceIso: state.lastSweepIso },
    )
    for (const { arcId, spendTokens } of spends) {
      state.arcSpends.set(arcId, spendTokens)
    }
    for (const arcId of [...state.arcSpends.keys()]) {
      if (!liveArcIds.has(arcId)) state.arcSpends.delete(arcId)
    }

    for (const [arcId, spendTokens] of state.arcSpends) {
      if (spendTokens < arcTokens) continue
      const payload = {
        arcId,
        arcTokens,
        spendTokens,
        pctOfCeiling: Math.round((spendTokens / arcTokens) * 100),
        measuredAt: nowIso,
      }
      const id = await raiseActionQueueItem({
        kind: 'budget-arc',
        category: 'daemon',
        priority: 'high',
        title: `Spend meter: arc ${arcId} consumed ${formatTokens(spendTokens)} weighted tokens ≥ ceiling ${formatTokens(arcTokens)}`,
        body:
          `Live arc ${arcId} has consumed ${formatTokens(spendTokens)} cache-weighted tokens ` +
          `over its lifetime, at or above the configured per-arc ceiling of ${formatTokens(arcTokens)} ` +
          `— and it is still running. Observe-and-warn only: dispatch and recovery spawning are ` +
          `untouched. Inspect with \`mars ui\` or \`mars attach\`; the row auto-resolves when the ` +
          `arc reaches terminal status.`,
        payload,
        context: {},
        raisedBy: RAISED_BY,
        signature: budgetArcSignature(arcId),
      })
      await patchActionQueuePayloadById(id, payload)
      raised.push(id)
    }

    // Resolve rows whose level condition has falsified: the arc left the
    // live set (terminal) or the ceiling was raised above its spend.
    const open = await listActionQueueItems('open', { kind: 'budget-arc' })
    for (const item of open) {
      const sig = item.signature ?? ''
      const arcId = sig.startsWith('budget-arc:') ? sig.slice('budget-arc:'.length) : null
      if (arcId === null) continue
      const live = liveArcIds.has(arcId)
      const spend = state.arcSpends.get(arcId)
      const stillOver = live && spend !== undefined && spend >= arcTokens
      if (stillOver) continue
      await setActionQueueState(item.id, 'resolved', {
        resolution: 'auto-resolved',
        note: live
          ? `per-arc ceiling raised above the arc's spend`
          : `arc ${arcId} reached terminal status`,
        by: RAISED_BY,
      })
      resolved.push(item.id)
    }
  } else {
    state.arcSpends.clear()
    resolved.push(
      ...(await resolveOpenRows('budget-arc', () => true, 'per-arc meter disabled')),
    )
  }

  state.lastSweepIso = nowIso
  return { windowEnabled, arcEnabled, windowSpendTokens, raised, resolved }
}

// ---------------------------------------------------------------------------
// Status (CLI `mars budget status` + daemon GET /budget + UI tile)
// ---------------------------------------------------------------------------

/** One open budget-* action-queue row, as surfaced by status/route. */
export interface BudgetOpenRow {
  id: string
  kind: 'budget-window' | 'budget-arc'
  signature: string | null
  title: string
  raisedAt: string
  lastSeenAt: string
  seenCount: number
}

export interface BudgetWindowStatus {
  windowMs: number
  thresholdTokens: number
  spendTokens: number
  /** spend / threshold (1.0 = at threshold). */
  ratio: number
  band: SpendBand
  topArcs: ArcSpend[]
}

export interface BudgetArcStatusEntry extends ArcSpend {
  ratio: number
  overCeiling: boolean
}

export interface BudgetArcsStatus {
  ceilingTokens: number
  /** Top live arcs by lifetime spend, descending. */
  liveArcs: BudgetArcStatusEntry[]
}

/** Wire shape for `mars budget status --json` and GET /budget. */
export interface BudgetStatus {
  configured: boolean
  config: BudgetConfig | null
  window: BudgetWindowStatus | null
  arcs: BudgetArcsStatus | null
  openRows: BudgetOpenRow[]
}

/**
 * Compute the full spend-meter status on demand (no sweep-state cache):
 * configured thresholds, current window spend + band, top live arcs vs the
 * per-arc ceiling, and any open budget-* rows. An unconfigured meter returns
 * `configured: false` with null sections — never fake zeros.
 */
export const computeBudgetStatus = async (
  surface: TaskStore,
  now: Date = new Date(),
): Promise<BudgetStatus> => {
  const config = readBudgetConfig()
  if (config === null) {
    return { configured: false, config: null, window: null, arcs: null, openRows: [] }
  }

  let window: BudgetWindowStatus | null = null
  if (config.windowMs !== null && config.windowTokens !== null) {
    const sinceIso = new Date(now.getTime() - config.windowMs).toISOString()
    const spendTokens = await computeWindowSpend(surface, { sinceIso })
    const ratio = spendTokens / config.windowTokens
    window = {
      windowMs: config.windowMs,
      thresholdTokens: config.windowTokens,
      spendTokens,
      ratio,
      band: spendBand(ratio),
      topArcs: await computeWindowTopArcs(surface, { sinceIso, limit: 5 }),
    }
  }

  let arcs: BudgetArcsStatus | null = null
  if (config.arcTokens !== null) {
    const ceilingTokens = config.arcTokens
    const spends = await computeLiveArcSpends(surface)
    arcs = {
      ceilingTokens,
      liveArcs: spends.slice(0, 10).map((s) => ({
        ...s,
        ratio: s.spendTokens / ceilingTokens,
        overCeiling: s.spendTokens >= ceilingTokens,
      })),
    }
  }

  const openRows: BudgetOpenRow[] = []
  for (const kind of ['budget-window', 'budget-arc'] as const) {
    const items = await listActionQueueItems('open', { kind })
    for (const item of items) {
      openRows.push({
        id: item.id,
        kind,
        signature: item.signature,
        title: item.title,
        raisedAt: item.raisedAt,
        lastSeenAt: item.lastSeenAt,
        seenCount: item.seenCount,
      })
    }
  }

  return { configured: true, config, window, arcs, openRows }
}
