/**
 * Programmatic lever application — same persistence path as the CLI commands.
 *
 * The daemon's POST /lever-apply endpoint calls `applyLeverValue()` here.
 * The CLI commands (lever.ts, operator.ts, daemon.ts) call the same underlying
 * config.ts functions directly, so both paths write through the same atomic
 * `patchDaemonConfigFile` writer and cannot drift.
 *
 * History is appended to .mars/lever-apply-history.jsonl on every successful
 * apply, then served by GET /lever-apply-history for the UI to display on
 * each lever's card.
 */

import {
  patchDaemonConfigFile,
  readDaemonConfigFile,
  CAP_CLI_TO_JSON,
  MAX_CONCURRENCY_CAP,
  persistLeverAutonomyLevel,
  persistAutotuneMaxImplement,
  persistPaused,
  writeControlLever,
  persistSelfEvolvePatch,
  persistScoringPatch,
  persistVerifyStepPatch,
  persistCodeStepPatch,
  persistCodeParamsPatch,
  type ControlLeverValue,
} from '../daemon/config'
import { writeBudgetConfig, parseDurationToMs } from './spend-meter'
import { loadLeverRegistry } from './lever-registry'
import { STEWARD_RUNTIME_TUNE_LEVER } from './conversation-copy'
import { resolveContext } from '../context'
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApplyLeverResult {
  leverId: string
  fromValue: string | null
  appliedValue: string
  requiresRestart: boolean
}

export interface LeverApplyHistoryEntry {
  appliedAt: string
  leverId: string
  fromValue: string | null
  toValue: string
  findingId?: string
}

export class LeverApplyError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'NOT_SETTABLE' | 'INVALID_VALUE',
  ) {
    super(message)
    this.name = 'LeverApplyError'
  }
}

// ─── History ──────────────────────────────────────────────────────────────────

function historyFilePath(): string {
  return resolve(resolveContext().stateDir, 'lever-apply-history.jsonl')
}

/**
 * Append one apply event to the lever history JSONL file.
 * Each line is a `LeverApplyHistoryEntry` JSON object.
 * Silently no-ops when the state dir cannot be created.
 */
export const appendLeverApplyHistory = (entry: LeverApplyHistoryEntry): void => {
  try {
    const path = historyFilePath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // history is best-effort — never fail an apply because the log write failed
  }
}

/**
 * Read all history entries, optionally filtered to a specific lever id.
 * Returns an empty array when the history file does not exist or is malformed.
 */
export const readLeverApplyHistory = (leverId?: string): LeverApplyHistoryEntry[] => {
  let raw: string
  try {
    raw = readFileSync(historyFilePath(), 'utf8')
  } catch {
    return []
  }
  const entries: LeverApplyHistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as LeverApplyHistoryEntry
      if (!leverId || e.leverId === leverId) entries.push(e)
    } catch {
      // skip malformed lines
    }
  }
  return entries
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/**
 * Apply a lever value using the same persistence path as the CLI commands.
 *
 * Throws `LeverApplyError` when:
 * - the lever id is unknown
 * - the lever has no gesture (documented gap — cannot be applied programmatically)
 * - the value fails the registry's allowedValues validation
 *
 * On success, the returned `appliedValue` is the value as read back from the
 * config after the write — not the raw `value` argument.
 */
export const applyLeverValue = (id: string, value: string): ApplyLeverResult => {
  const registry = loadLeverRegistry()
  const entry = registry.find((e) => e.id === id)
  if (!entry) {
    throw new LeverApplyError(`unknown lever '${id}'`, 'NOT_FOUND')
  }
  if (!entry.gesture) {
    throw new LeverApplyError(
      `lever '${id}' has no gesture — no CLI command exists to apply it`,
      'NOT_SETTABLE',
    )
  }

  // ── Validate against the registry's allowedValues (mirrors lever CLI) ────
  const { allowedValues } = entry
  if (allowedValues.type === 'enum') {
    if (!allowedValues.values.includes(value)) {
      throw new LeverApplyError(
        `invalid value '${value}' for '${id}'; allowed: ${allowedValues.values.join(' | ')}`,
        'INVALID_VALUE',
      )
    }
  } else if (allowedValues.type === 'range') {
    const n = Number(value)
    if (!Number.isFinite(n)) {
      throw new LeverApplyError(`'${id}' requires a number; got '${value}'`, 'INVALID_VALUE')
    }
    const bound =
      allowedValues.max !== undefined
        ? `${allowedValues.min}–${allowedValues.max}`
        : `>= ${allowedValues.min}`
    if (n < allowedValues.min) {
      throw new LeverApplyError(`'${id}' must be ${bound}; got '${value}'`, 'INVALID_VALUE')
    }
    if (allowedValues.max !== undefined && n > allowedValues.max) {
      throw new LeverApplyError(`'${id}' must be ${bound}; got '${value}'`, 'INVALID_VALUE')
    }
  }
  // freeform: no validation

  const fromValue = entry.readCurrent()

  // ── Persist via same path as the matching CLI command ────────────────────
  if (id.startsWith('caps.')) {
    // caps.implement → 'implement'; caps.setup-install → 'setup-install'
    const capName = id.slice('caps.'.length)
    const capKey = CAP_CLI_TO_JSON[capName]
    if (capKey === undefined) {
      throw new LeverApplyError(`unknown cap '${capName}'`, 'NOT_SETTABLE')
    }
    const n = Number(value)
    if (!Number.isInteger(n) || n <= 0) {
      throw new LeverApplyError(
        `cap '${id}' must be a positive integer; got '${value}'`,
        'INVALID_VALUE',
      )
    }
    if (n > MAX_CONCURRENCY_CAP) {
      throw new LeverApplyError(
        `cap '${id}' must be <= ${MAX_CONCURRENCY_CAP}; got '${value}'`,
        'INVALID_VALUE',
      )
    }
    const current = readDaemonConfigFile()
    const rawCaps =
      current.caps !== null &&
      typeof current.caps === 'object' &&
      !Array.isArray(current.caps)
        ? (current.caps as Record<string, unknown>)
        : {}
    const knownJsonKeys = new Set<string>(Object.values(CAP_CLI_TO_JSON))
    const cleanedCaps = Object.fromEntries(
      Object.entries(rawCaps).filter(([k]) => knownJsonKeys.has(k)),
    )
    patchDaemonConfigFile({ caps: { ...cleanedCaps, [capKey]: n } })
  } else if (id === 'provider.default') {
    patchDaemonConfigFile({ defaultProvider: value })
  } else if (id === 'operator.dispatch') {
    persistPaused(value === 'off')
  } else if (
    id === 'operator.recovery' ||
    id === 'operator.scoring' ||
    id === 'operator.memory-capture' ||
    id === 'operator.auto-run-reflect'
  ) {
    const leverName = id.slice('operator.'.length)
    const configLeverName: 'recovery' | 'scoring' | 'memoryCapture' | 'autoRunReflect' =
      leverName === 'memory-capture'
        ? 'memoryCapture'
        : leverName === 'auto-run-reflect'
          ? 'autoRunReflect'
          : (leverName as 'recovery' | 'scoring')
    writeControlLever(configLeverName, value as ControlLeverValue)
  } else if (id === 'steward.autotune') {
    // on → 'tell' (the autonomous default); off → 'off'
    persistLeverAutonomyLevel(STEWARD_RUNTIME_TUNE_LEVER, value === 'off' ? 'off' : 'tell')
  } else if (id === 'steward.autotune-max-implement') {
    persistAutotuneMaxImplement(Number(value))
  } else if (id.startsWith('scoring.')) {
    const field =
      id === 'scoring.auto-trigger'
        ? 'autoTrigger'
        : id === 'scoring.low-trend-threshold'
          ? 'lowTrendThreshold'
          : 'lowTrendWindow'
    // scoring.auto-trigger is a boolean stored as 'true'/'false' strings in the registry
    const typed: boolean | number = id === 'scoring.auto-trigger' ? value === 'true' : Number(value)
    persistScoringPatch({ [field]: typed } as Parameters<typeof persistScoringPatch>[0])
  } else if (id.startsWith('self-evolve.')) {
    // Only self-evolve.drift-threshold-pct is settable; unknown sub-levers fall through to NOT_SETTABLE.
    if (id !== 'self-evolve.drift-threshold-pct') {
      throw new LeverApplyError(
        `lever '${id}' cannot be applied via this endpoint; use: ${entry.gesture}`,
        'NOT_SETTABLE',
      )
    }
    persistSelfEvolvePatch({ driftThresholdPct: Number(value) })
  } else if (id === 'budget.window') {
    writeBudgetConfig({ windowMs: parseDurationToMs(value) })
  } else if (id === 'budget.window-tokens') {
    writeBudgetConfig({ windowTokens: Number(value) })
  } else if (id === 'budget.arc-tokens') {
    writeBudgetConfig({ arcTokens: Number(value) })
  } else if (id === 'verify.retry-budget' || id === 'verify.timeout-min') {
    // Verify-step config levers. Note: `verify.add-*` recipe entries share
    // the same family but are NOT handled here — they fall through to the
    // NOT_SETTABLE throw below. Only daemon.json-backed levers are listed
    // explicitly here to avoid accidentally catching recipe entries.
    persistVerifyStepPatch(
      id === 'verify.retry-budget'
        ? { retryBudget: Number(value) }
        : { timeoutMin: Number(value) },
    )
  } else if (id.startsWith('code.')) {
    // Code-step config levers. All code.* levers are daemon.json-backed;
    // no recipe-style code entries exist, so startsWith is safe here.
    if (id === 'code.checkpoint-interval-ms') {
      persistCodeStepPatch({ checkpointIntervalMs: Number(value) })
    } else if (id === 'code.context-strategy') {
      persistCodeParamsPatch({ contextStrategy: value as 'full' | 'filtered' | 'minimal' })
    } else if (id === 'code.tool-exposure') {
      persistCodeParamsPatch({ toolExposure: value })
    } else if (id === 'code.prompt-prefix') {
      persistCodeParamsPatch({ promptPrefix: value })
    } else {
      throw new LeverApplyError(
        `lever '${id}' cannot be applied via this endpoint; use: ${entry.gesture}`,
        'NOT_SETTABLE',
      )
    }
  } else {
    throw new LeverApplyError(
      `lever '${id}' cannot be applied via this endpoint; use: ${entry.gesture}`,
      'NOT_SETTABLE',
    )
  }

  const appliedValue = entry.readCurrent() ?? value
  return {
    leverId: id,
    fromValue,
    appliedValue,
    requiresRestart: !entry.appliesWithoutRestart,
  }
}
