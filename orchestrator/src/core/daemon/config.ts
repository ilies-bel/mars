import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

export interface DaemonConfig {
  caps: DaemonCaps
  selfEvolve: SelfEvolveConfig
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

  let fileCaps: Partial<DaemonCaps> = {}
  let fileAutoTrigger: boolean | undefined
  let fileDriftPct: number | undefined
  let fileConfThreshold: number | undefined
  let fileAutoApprovePlans: boolean | undefined

  try {
    const raw = readFileSync(daemonConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as {
      caps?: Record<string, unknown>
      selfEvolve?: Record<string, unknown>
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
    autoApprovePlans: fileAutoApprovePlans ?? envAutoApprovePlans,
  }
}
