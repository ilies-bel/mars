import { readDaemonConfigFile } from '../daemon/config.js'
import type { ProposalSource } from '../proposals.js'
import type { DbClient } from './db.js'

/** Rolling window over which a source's proposals count against its ceiling. */
export const BUDGET_WINDOW_DAYS = 30

/**
 * Default per-source admission ceilings (proposals per rolling window).
 * `null` = unlimited: high-yield producers are never throttled.
 */
export const DEFAULT_SOURCE_CEILINGS: Record<ProposalSource, number | null> = {
  'failure-reflector': 30,
  'arc-verifier': 30,
  reflection: 60,
  human: null,
  planner: null,
  slicer: null,
  'skill-forge': null,
  growth: null,
}

export interface SourceBudgetVerdict {
  overBudget: boolean
  used: number
  /** `null` = unlimited. */
  ceiling: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `proposalBudgets` from daemon.json; `{}` when absent, unreadable or malformed. */
const readProposalBudgets = (): Partial<Record<ProposalSource, number | null>> => {
  try {
    const raw = readDaemonConfigFile().proposalBudgets
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Partial<Record<ProposalSource, number | null>> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key in DEFAULT_SOURCE_CEILINGS && (value === null || typeof value === 'number')) {
        out[key as ProposalSource] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Has `source` already spent its share of triage capacity in the rolling
 * window? Judgement only — nothing enforces it yet. Exactly at the ceiling is
 * not over; a `0` ceiling blocks the source outright.
 */
export const checkSourceBudget = async (
  c: DbClient,
  source: ProposalSource,
  opts: {
    now?: () => number
    windowDays?: number
    ceilings?: Partial<Record<ProposalSource, number | null>>
  } = {},
): Promise<SourceBudgetVerdict> => {
  const ceilings = { ...DEFAULT_SOURCE_CEILINGS, ...readProposalBudgets(), ...opts.ceilings }
  const ceiling = ceilings[source] ?? null
  const since = (opts.now ?? Date.now)() - (opts.windowDays ?? BUDGET_WINDOW_DAYS) * DAY_MS
  const r = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM proposals WHERE source = ? AND created_at >= ?`,
    args: [source, since],
  })
  const used = Number((r.rows[0] as { n?: unknown } | undefined)?.n ?? 0)
  return { overBudget: ceiling !== null && used > ceiling, used, ceiling }
}
