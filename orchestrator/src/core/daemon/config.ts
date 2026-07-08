import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveContext } from '../context'

export interface DaemonCaps {
  implement: number
  triage: number
  refine: number
  structuredWrite: number
  /** Maximum concurrent worktree dependency installs (MARS_MAX_SETUP_INSTALL). Default 2. */
  setupInstall: number
}

export interface SelfEvolveConfig {
  autoTrigger: boolean
  driftThresholdPct: number
  /**
   * Minimum confidence (0..1) for a 'mechanical' suggestion to be
   * auto-enqueued as a Task when autoTrigger is true. Default 0.8.
   * 'architectural' suggestions are never auto-enqueued regardless of this value.
   */
  taskConfidenceThreshold: number
}

/**
 * Scorer optimization fold-in (PRD 6cf85bc9). Only the low-trend trigger is
 * configurable; scoring itself is controlled by the in-memory
 * `set-flag scoring` kill-switch and MARS_REFLECT_DISABLED.
 */
export interface ScoringConfig {
  /**
   * When true, a sustained low score trend (rolling median below
   * `lowTrendThreshold` across `lowTrendWindow` scored instances of one
   * workflow) raises ONE draft proposal (source='reflection') proposing a
   * revision of that pipeline. OFF by default — same explicit operator
   * opt-in posture as ADR-0038's KPI-regression trigger. The resulting
   * draft surfaces as an ordinary draft-proposal action-queue row (pure
   * projection, ADR-0048); the framework never rewrites a pipeline itself.
   */
  autoTrigger: boolean
  /** Rolling-median floor below which the trigger fires. Default 0.5. */
  lowTrendThreshold: number
  /** Number of consecutive scored instances the median is computed over. Default 5. */
  lowTrendWindow: number
}

export interface DaemonConfig {
  caps: DaemonCaps
  selfEvolve: SelfEvolveConfig
  scoring: ScoringConfig
  /**
   * When true, sliced plans are enqueued immediately without operator review
   * (restores the pre-plan-approval-gate behaviour). Default false.
   * Override via MARS_AUTO_APPROVE_PLANS=1 or daemon.json `autoApprovePlans: true`.
   */
  autoApprovePlans: boolean
}

const DEFAULTS: DaemonCaps = {
  implement: 12,
  triage: 8,
  refine: 6,
  structuredWrite: 1,
  setupInstall: 2,
}

const DEFAULT_SELF_EVOLVE: SelfEvolveConfig = {
  autoTrigger: false,
  driftThresholdPct: 10,
  taskConfidenceThreshold: 0.8,
}

const DEFAULT_SCORING: ScoringConfig = {
  autoTrigger: false,
  lowTrendThreshold: 0.5,
  lowTrendWindow: 5,
}

const DEFAULT_AUTO_APPROVE_PLANS = false

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const envBool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  return fallback
}

const positiveInt = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number') return fallback
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fallback
  }
  return value
}

export const daemonConfigPath = (): string =>
  resolve(resolveContext().stateDir, 'daemon.json')

/**
 * Persist a selfEvolve patch to the daemon config file (daemon.json).
 * Merges the patch into the existing file content, creating or overwriting
 * the file. Any fields not mentioned in `patch` are preserved.
 *
 * Used by the `enable-auto-reflect` action to set `autoTrigger=true` without
 * losing other configured values. Safe to call from the daemon process.
 */
export const persistSelfEvolveAutoTrigger = (autoTrigger: boolean): void => {
  const path = daemonConfigPath()
  let existing: Record<string, unknown> = {}
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {
    // File absent or invalid — start fresh.
  }
  const existingSe =
    existing.selfEvolve !== null &&
    typeof existing.selfEvolve === 'object' &&
    !Array.isArray(existing.selfEvolve)
      ? (existing.selfEvolve as Record<string, unknown>)
      : {}
  writeFileSync(
    path,
    JSON.stringify({ ...existing, selfEvolve: { ...existingSe, autoTrigger } }, null, 2),
    'utf8',
  )
}

/**
 * Read the raw daemon.json object without applying any env/default
 * resolution. Missing file, unreadable file, or non-object JSON all
 * degrade to `{}` — callers merge-patch on top and write back.
 */
export const readDaemonConfigFile = (): Record<string, unknown> => {
  try {
    const raw = readFileSync(daemonConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Merge-patch write helper for `.mars/daemon.json`: shallow-merges `patch`
 * into the existing top-level object and writes the result back, preserving
 * every key the patch does not name (caps, selfEvolve, budget, …). A `null`
 * value in `patch` removes that top-level key. Creates the state dir / file
 * when absent. Consumers that poll the file (e.g. the spend sweep) pick the
 * change up on their next read — no daemon restart required.
 */
export const patchDaemonConfigFile = (
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const current = readDaemonConfigFile()
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key]
    } else {
      next[key] = value
    }
  }
  const path = daemonConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

// Resolution order per field: config file > env var > built-in default.
// The file is optional; a missing/invalid file silently falls back to env+defaults
// so the daemon never refuses to start because of a malformed config.
export const loadDaemonConfig = (): DaemonConfig => {
  const envCaps: DaemonCaps = {
    implement: envInt('MARS_MAX_IMPLEMENT', DEFAULTS.implement),
    triage: envInt('MARS_MAX_TRIAGE', DEFAULTS.triage),
    refine: envInt('MARS_MAX_REFINE', DEFAULTS.refine),
    structuredWrite: envInt('MARS_MAX_STRUCTURED_WRITE', DEFAULTS.structuredWrite),
    setupInstall: envInt('MARS_MAX_SETUP_INSTALL', DEFAULTS.setupInstall),
  }

  const envAutoTrigger = envBool(
    'MARS_SELF_EVOLVE_AUTO_TRIGGER',
    DEFAULT_SELF_EVOLVE.autoTrigger,
  )
  const rawDrift = process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD']
  const envDriftNum = rawDrift !== undefined && rawDrift !== '' ? Number(rawDrift) : NaN
  const envDriftPct =
    Number.isFinite(envDriftNum) && envDriftNum > 0
      ? envDriftNum
      : DEFAULT_SELF_EVOLVE.driftThresholdPct
  const rawConf = process.env['MARS_SELF_EVOLVE_TASK_CONFIDENCE_THRESHOLD']
  const envConfNum = rawConf !== undefined && rawConf !== '' ? Number(rawConf) : NaN
  const envConfThreshold =
    Number.isFinite(envConfNum) && envConfNum >= 0 && envConfNum <= 1
      ? envConfNum
      : DEFAULT_SELF_EVOLVE.taskConfidenceThreshold

  const envAutoApprovePlans = envBool('MARS_AUTO_APPROVE_PLANS', DEFAULT_AUTO_APPROVE_PLANS)

  const envScoringAutoTrigger = envBool(
    'MARS_SCORING_AUTO_TRIGGER',
    DEFAULT_SCORING.autoTrigger,
  )
  const rawScoringThreshold = process.env['MARS_SCORING_LOW_TREND_THRESHOLD']
  const envScoringThresholdNum =
    rawScoringThreshold !== undefined && rawScoringThreshold !== ''
      ? Number(rawScoringThreshold)
      : NaN
  const envScoringThreshold =
    Number.isFinite(envScoringThresholdNum) &&
    envScoringThresholdNum >= 0 &&
    envScoringThresholdNum <= 1
      ? envScoringThresholdNum
      : DEFAULT_SCORING.lowTrendThreshold
  const envScoringWindow = envInt(
    'MARS_SCORING_LOW_TREND_WINDOW',
    DEFAULT_SCORING.lowTrendWindow,
  )

  let fileCaps: Partial<DaemonCaps> = {}
  let fileAutoTrigger: boolean | undefined
  let fileDriftPct: number | undefined
  let fileConfThreshold: number | undefined
  let fileAutoApprovePlans: boolean | undefined
  let fileScoringAutoTrigger: boolean | undefined
  let fileScoringThreshold: number | undefined
  let fileScoringWindow: number | undefined

  try {
    const raw = readFileSync(daemonConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as {
      caps?: Record<string, unknown>
      selfEvolve?: Record<string, unknown>
      scoring?: Record<string, unknown>
    }
    const c = parsed.caps ?? {}
    fileCaps = {
      implement: positiveInt(c.implement, envCaps.implement),
      triage: positiveInt(c.triage, envCaps.triage),
      refine: positiveInt(c.refine, envCaps.refine),
      structuredWrite: positiveInt(
        c.structuredWrite ?? c['structured-write'],
        envCaps.structuredWrite,
      ),
      setupInstall: positiveInt(
        c.setupInstall ?? c['setup-install'],
        envCaps.setupInstall,
      ),
    }
    const se = parsed.selfEvolve ?? {}
    if (typeof se.autoTrigger === 'boolean') {
      fileAutoTrigger = se.autoTrigger
    }
    const seThreshold = se.driftThresholdPct
    if (typeof seThreshold === 'number' && Number.isFinite(seThreshold) && seThreshold > 0) {
      fileDriftPct = seThreshold
    }
    const seConfThreshold = se.taskConfidenceThreshold
    if (
      typeof seConfThreshold === 'number' &&
      Number.isFinite(seConfThreshold) &&
      seConfThreshold >= 0 &&
      seConfThreshold <= 1
    ) {
      fileConfThreshold = seConfThreshold
    }
    if (typeof (parsed as Record<string, unknown>).autoApprovePlans === 'boolean') {
      fileAutoApprovePlans = (parsed as Record<string, unknown>).autoApprovePlans as boolean
    }
    const sc = parsed.scoring ?? {}
    if (typeof sc.autoTrigger === 'boolean') {
      fileScoringAutoTrigger = sc.autoTrigger
    }
    const scThreshold = sc.lowTrendThreshold
    if (
      typeof scThreshold === 'number' &&
      Number.isFinite(scThreshold) &&
      scThreshold >= 0 &&
      scThreshold <= 1
    ) {
      fileScoringThreshold = scThreshold
    }
    fileScoringWindow = positiveInt(sc.lowTrendWindow, envScoringWindow)
  } catch {
    // No file, unreadable, or invalid JSON — fall back to env+defaults.
  }

  return {
    caps: {
      implement: fileCaps.implement ?? envCaps.implement,
      triage: fileCaps.triage ?? envCaps.triage,
      refine: fileCaps.refine ?? envCaps.refine,
      structuredWrite: fileCaps.structuredWrite ?? envCaps.structuredWrite,
      setupInstall: fileCaps.setupInstall ?? envCaps.setupInstall,
    },
    selfEvolve: {
      autoTrigger: fileAutoTrigger ?? envAutoTrigger,
      driftThresholdPct: fileDriftPct ?? envDriftPct,
      taskConfidenceThreshold: fileConfThreshold ?? envConfThreshold,
    },
    scoring: {
      autoTrigger: fileScoringAutoTrigger ?? envScoringAutoTrigger,
      lowTrendThreshold: fileScoringThreshold ?? envScoringThreshold,
      lowTrendWindow: fileScoringWindow ?? envScoringWindow,
    },
    autoApprovePlans: fileAutoApprovePlans ?? envAutoApprovePlans,
  }
}
