import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveContext } from '../context'

export interface DaemonCaps {
  implement: number
  triage: number
  refine: number
  structuredWrite: number
}

export interface DaemonConfig {
  caps: DaemonCaps
}

const DEFAULTS: DaemonCaps = {
  implement: 12,
  triage: 8,
  refine: 6,
  structuredWrite: 1,
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
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

// Resolution order per field: config file > env var > built-in default.
// The file is optional; a missing/invalid file silently falls back to env+defaults
// so the daemon never refuses to start because of a malformed config.
export const loadDaemonConfig = (): DaemonConfig => {
  const envCaps: DaemonCaps = {
    implement: envInt('MARS_MAX_IMPLEMENT', DEFAULTS.implement),
    triage: envInt('MARS_MAX_TRIAGE', DEFAULTS.triage),
    refine: envInt('MARS_MAX_REFINE', DEFAULTS.refine),
    structuredWrite: envInt('MARS_MAX_STRUCTURED_WRITE', DEFAULTS.structuredWrite),
  }

  let fileCaps: Partial<DaemonCaps> = {}
  try {
    const raw = readFileSync(daemonConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as { caps?: Record<string, unknown> }
    const c = parsed.caps ?? {}
    fileCaps = {
      implement: positiveInt(c.implement, envCaps.implement),
      triage: positiveInt(c.triage, envCaps.triage),
      refine: positiveInt(c.refine, envCaps.refine),
      structuredWrite: positiveInt(
        c.structuredWrite ?? c['structured-write'],
        envCaps.structuredWrite,
      ),
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
    },
  }
}
