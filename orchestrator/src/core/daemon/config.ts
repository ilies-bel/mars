import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { resolveContext } from '../context'
import type { ProviderName } from '../workers/provider-types'

/** Three-position autonomy axis for each operator lever. */
export const AUTONOMY_LEVELS = ['off', 'ask', 'tell'] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

/**
 * The shared autonomous position. Keep this derived from the type source of
 * truth: mars-8b5c09ce is settling the tell/silent glossary divergence.
 */
export const AUTONOMOUS_AUTONOMY_LEVEL: AutonomyLevel = AUTONOMY_LEVELS[2]

export const STEWARD_PROMPT_OPTIMIZER_LEVER = 'steward_prompt_optimizer' as const

/**
 * Levers that are autonomous until the operator says otherwise.
 *
 * `'ask'` is the right default for a lever with somewhere to ask — a queue
 * item, a chip. These have none: they govern behaviour that runs
 * unsupervised and reports afterwards, so defaulting them to `'ask'` would
 * silently disable them instead of prompting anyone.
 */
const AUTONOMOUS_BY_DEFAULT_LEVERS: ReadonlySet<string> = new Set([
  STEWARD_PROMPT_OPTIMIZER_LEVER,
  'steward_runtime_tune',
])

const defaultLevelFor = (name: string): AutonomyLevel =>
  AUTONOMOUS_BY_DEFAULT_LEVERS.has(name) ? AUTONOMOUS_AUTONOMY_LEVEL : 'ask'

export type WorkerPromptBlockId = 'Coder.system' | 'COMMIT_FOOTER'

/**
 * Zod schema for a single lever entry in daemon.json's `levers` map.
 * The `autonomy_level` field defaults to `'ask'` when omitted.
 */
export const leverSchema = z.object({
  autonomy_level: z.enum(AUTONOMY_LEVELS).default('ask'),
})

export type LeverEntry = z.infer<typeof leverSchema>

export type ControlLeverValue = 'on' | 'off'

export interface ControlLevers {
  recovery: ControlLeverValue
  scoring: ControlLeverValue
  /**
   * Gates memory-packet insertion after reflection suggestions are persisted.
   * When 'off', suggestions are still saved as proposals but NOT inserted into
   * the memory store. Has no bearing on whether reflection runs at all.
   * Gesture: `mars operator set memory-capture <on|off>`.
   */
  memoryCapture: ControlLeverValue
  /**
   * Gates whether reflection runs automatically when the recommend condition is
   * met, versus waiting for an explicit operator action on the
   * reflect-recommended action-queue row.
   * When 'off' (default), the operator must act on the row to trigger a run.
   * When 'on', the detector auto-runs the reflect pipeline and closes the row.
   * Gesture: `mars operator set auto-run-reflect <on|off>`.
   */
  autoRunReflect: ControlLeverValue
}

export interface DaemonCaps {
  implement: number
  triage: number
  refine: number
  /** Maximum concurrent worktree dependency installs (MARS_MAX_SETUP_INSTALL). Default 2. */
  setupInstall: number
  /**
   * Maximum concurrent verify steps (MARS_MAX_VERIFY). Default 2.
   *
   * The verify step (npm test / typecheck) is CPU-intensive. Without a cap,
   * every in-flight implement slot can run a full test suite simultaneously,
   * multiplying load beyond what the host can sustain. This semaphore limits
   * how many verify steps run at once, independently of the implement cap.
   *
   * A task waiting on this semaphore releases its implement slot first so
   * other tasks can continue coding while verify is queued. There is no
   * circular dependency (coding never waits on verify), so the cap is deadlock-safe.
   */
  verify: number
}

export interface SelfEvolveConfig {
  /**
   * When true, a high-confidence mechanical reflection suggestion is
   * automatically enqueued as a Task (rather than left as a draft proposal).
   * Controls only the routing of suggestion outputs — not whether reflection
   * runs. Default false.
   */
  autoEnqueue: boolean
  driftThresholdPct: number
  /**
   * Minimum confidence (0..1) for a 'mechanical' suggestion to be
   * auto-enqueued as a Task when autoEnqueue is true. Default 0.8.
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
   * The default agent provider for every Worker in this daemon. Persisted by
   * `mars init --provider <name>` and resolved before headless or PTY workers
   * are imported. An explicit MARS_WORKER_PROVIDER env value overrides it for
   * one daemon process. Default: 'codex'.
   */
  defaultProvider: ProviderName
  /**
   * Operator control levers. Written by `mars operator set` and re-applied on
   * each daemon startup so a hold set before a restart persists across it.
   * `recovery: 'off'` sets MARS_RECOVERY_DISABLED=1 in the daemon process env;
   * `recovery: 'on'` (the default) clears it.
   */
  controlLevers: ControlLevers
  /**
   * ISO-8601 timestamp of when the reflection pipeline last completed.
   * Written by `persistLastReflectRanAt` when `runReflect` finishes.
   * Absent until at least one reflection has run.
   */
  lastReflectRanAt?: string
}

const DEFAULTS: DaemonCaps = {
  implement: 12,
  triage: 8,
  refine: 6,
  setupInstall: 2,
  verify: 2,
}

const DEFAULT_SELF_EVOLVE: SelfEvolveConfig = {
  autoEnqueue: false,
  driftThresholdPct: 10,
  taskConfidenceThreshold: 0.8,
}

const DEFAULT_SCORING: ScoringConfig = {
  autoTrigger: false,
  lowTrendThreshold: 0.5,
  lowTrendWindow: 5,
}

const DEFAULT_PROVIDER: ProviderName = 'codex'

const DEFAULT_CONTROL_LEVERS: ControlLevers = {
  recovery: 'on',
  scoring: 'on',
  memoryCapture: 'on',
  autoRunReflect: 'off',
}

const VALID_PROVIDER_NAMES = new Set<string>(['claude', 'gemini', 'codex'])

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
 * Used by the `enable-auto-reflect` action to set `autoEnqueue=true` without
 * losing other configured values. Safe to call from the daemon process.
 */
export const persistSelfEvolveAutoEnqueue = (autoEnqueue: boolean): void => {
  const existing = readDaemonConfigFile()
  const existingSe =
    existing.selfEvolve !== null &&
    typeof existing.selfEvolve === 'object' &&
    !Array.isArray(existing.selfEvolve)
      ? (existing.selfEvolve as Record<string, unknown>)
      : {}
  patchDaemonConfigFile({ selfEvolve: { ...existingSe, autoEnqueue } })
}

/**
 * Persist the timestamp when reflection last ran to daemon.json.
 * Read back in `loadDaemonConfig().lastReflectRanAt` for operator status.
 */
export const persistLastReflectRanAt = (isoTimestamp: string): void => {
  patchDaemonConfigFile({ lastReflectRanAt: isoTimestamp })
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
 * into the existing top-level object and writes the result back atomically, preserving
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
  // A pause is an incident-control boundary: do not truncate daemon.json in
  // place. A SIGKILL between truncate and write used to leave the next daemon
  // with unreadable config, which looks exactly like an absent `paused` key.
  // Flush the replacement before atomically publishing it, then flush the
  // directory entry so a fast respawn sees the committed file.
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  const tmpFd = openSync(tmpPath, 'r')
  try {
    fsyncSync(tmpFd)
  } finally {
    closeSync(tmpFd)
  }
  renameSync(tmpPath, path)
  const dirFd = openSync(dirname(path), 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
  return next
}

/**
 * Read the persisted `paused` flag from daemon.json.
 *
 * Returns `true` when a dispatch pause was persisted before the daemon exited
 * before the daemon exited. Returns `false` (the safe default) when the field
 * is absent, non-boolean, or the file is missing or invalid.
 *
 * The flag is intentionally persisted so that an operator who pauses the daemon
 * to work directly in the primary checkout does not lose that intent across an
 * auto-respawn (which used to silently un-pause and could trigger a hard-reset
 * of uncommitted operator work — ADR-0058).
 */
export const readPersistedPaused = (): boolean => {
  const raw = readDaemonConfigFile()
  return raw.paused === true
}

/**
 * Persist the `paused` flag to `daemon.json` so it survives a daemon restart.
 *
 * When `value` is `false`, the key is removed from the file (equivalent to
 * absent / default-false) rather than written as `false`, keeping the file
 * minimal. Uses `patchDaemonConfigFile` so all other keys are preserved.
 */
export const persistPaused = (value: boolean): void => {
  if (value) {
    patchDaemonConfigFile({ paused: true })
  } else {
    patchDaemonConfigFile({ paused: null })
  }
}

/**
 * Read the autonomy_level for `name` from daemon.json's `levers` map.
 * Returns `'ask'` when the lever is absent. A persisted invalid or retired
 * value is rejected explicitly so an operator's autonomy choice is never
 * silently changed to the default.
 */
export const readLeverAutonomyLevel = (name: string): AutonomyLevel => {
  const raw = readDaemonConfigFile()
  const levers = raw.levers
  if (levers === null || typeof levers !== 'object' || Array.isArray(levers)) {
    return defaultLevelFor(name)
  }
  const leverData = (levers as Record<string, unknown>)[name]
  if (leverData === null || typeof leverData !== 'object' || Array.isArray(leverData)) {
    return defaultLevelFor(name)
  }
  const autonomyLevel = (leverData as Record<string, unknown>).autonomy_level
  if (autonomyLevel !== undefined && !AUTONOMY_LEVELS.includes(autonomyLevel as AutonomyLevel)) {
    const kind = autonomyLevel === 'silent' ? 'retired' : 'invalid'
    throw new Error(
      `daemon.json lever '${name}' has ${kind} autonomy level '${String(autonomyLevel)}'; valid levels are 'off', 'ask', or 'tell'`,
    )
  }
  const parsed = leverSchema.safeParse(leverData)
  if (!parsed.success) {
    throw new Error(
      `daemon.json lever '${name}' is invalid; autonomy must be 'off', 'ask', or 'tell'`,
    )
  }
  return parsed.data.autonomy_level
}

/** Read an operator-/Steward-managed standing Worker prompt block, if any. */
export const readWorkerPromptOverride = (block: WorkerPromptBlockId): string | null => {
  const workerPrompts = readDaemonConfigFile().workerPrompts
  if (workerPrompts === null || typeof workerPrompts !== 'object' || Array.isArray(workerPrompts)) {
    return null
  }
  const value = (workerPrompts as Record<string, unknown>)[block]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * Persist an override for a Mars-owned standing Worker prompt block. Operator
 * task prompts never pass through this map.
 */
export const persistWorkerPromptOverride = (
  block: WorkerPromptBlockId,
  text: string | null,
): void => {
  const current = readDaemonConfigFile()
  const existing =
    current.workerPrompts !== null &&
    typeof current.workerPrompts === 'object' &&
    !Array.isArray(current.workerPrompts)
      ? (current.workerPrompts as Record<string, unknown>)
      : {}
  const next = { ...existing }
  if (text === null) delete next[block]
  else next[block] = text
  patchDaemonConfigFile({ workerPrompts: next })
}

/**
 * Persist an autonomy_level for `name` into daemon.json's `levers` map.
 * Merge-patches so other lever fields and top-level keys are preserved.
 */
export const persistLeverAutonomyLevel = (name: string, level: AutonomyLevel): void => {
  const current = readDaemonConfigFile()
  const existingLevers =
    current.levers !== null &&
    typeof current.levers === 'object' &&
    !Array.isArray(current.levers)
      ? (current.levers as Record<string, unknown>)
      : {}
  const existingLever =
    existingLevers[name] !== null &&
    typeof existingLevers[name] === 'object' &&
    !Array.isArray(existingLevers[name])
      ? (existingLevers[name] as Record<string, unknown>)
      : {}
  patchDaemonConfigFile({
    levers: { ...existingLevers, [name]: { ...existingLever, autonomy_level: level } },
  })
}

/**
 * Read the persisted `controlLevers` from daemon.json, returning defaults for
 * any absent or invalid fields. Does not apply the levers to process.env —
 * call `applyControlLevers` to do that.
 *
 * Migrates on read: the old `autoReflect` key is accepted as `memoryCapture`
 * so existing daemon.json files from before the rename continue to work.
 */
export const readControlLevers = (): ControlLevers => {
  const file = readDaemonConfigFile()
  const cl = file.controlLevers
  const result = { ...DEFAULT_CONTROL_LEVERS }
  if (cl !== null && typeof cl === 'object' && !Array.isArray(cl)) {
    const record = cl as Record<string, unknown>
    if (record.recovery === 'on' || record.recovery === 'off') {
      result.recovery = record.recovery
    }
    if (record.scoring === 'on' || record.scoring === 'off') {
      result.scoring = record.scoring
    }
    // Accept new key first, fall back to old key for migration.
    if (record.memoryCapture === 'on' || record.memoryCapture === 'off') {
      result.memoryCapture = record.memoryCapture
    } else if (record.autoReflect === 'on' || record.autoReflect === 'off') {
      result.memoryCapture = record.autoReflect as ControlLeverValue
    }
    if (record.autoRunReflect === 'on' || record.autoRunReflect === 'off') {
      result.autoRunReflect = record.autoRunReflect
    }
  }
  return result
}

/**
 * Persist a single control lever to daemon.json via `patchDaemonConfigFile`.
 * Preserves all other control levers and all other daemon.json fields.
 */
export const writeControlLever = (name: keyof ControlLevers, value: ControlLeverValue): void => {
  const current = readControlLevers()
  patchDaemonConfigFile({ controlLevers: { ...current, [name]: value } })
}

/**
 * Apply `levers` to `process.env` so the running process reflects the
 * persisted operator choices. Called at daemon startup (before dispatch starts)
 * and by the `apply-lever` RPC (for immediate live effect without restart).
 *
 *   recovery='off' → process.env.MARS_RECOVERY_DISABLED = '1'
 *   recovery='on'  → delete process.env.MARS_RECOVERY_DISABLED
 */
export const applyControlLevers = (levers: ControlLevers): void => {
  if (levers.recovery === 'off') {
    process.env.MARS_RECOVERY_DISABLED = '1'
  } else {
    delete process.env.MARS_RECOVERY_DISABLED
  }
  if (levers.scoring === 'off') {
    process.env.MARS_SCORING_DISABLED = '1'
  } else {
    delete process.env.MARS_SCORING_DISABLED
  }
}

// Resolution order per field: config file > env var > built-in default.
// The file is optional; a missing/invalid file silently falls back to env+defaults
// so the daemon never refuses to start because of a malformed config.
export const loadDaemonConfig = (): DaemonConfig => {
  const envCaps: DaemonCaps = {
    implement: envInt('MARS_MAX_IMPLEMENT', DEFAULTS.implement),
    triage: envInt('MARS_MAX_TRIAGE', DEFAULTS.triage),
    refine: envInt('MARS_MAX_REFINE', DEFAULTS.refine),
    setupInstall: envInt('MARS_MAX_SETUP_INSTALL', DEFAULTS.setupInstall),
    verify: envInt('MARS_MAX_VERIFY', DEFAULTS.verify),
  }

  const envAutoEnqueue = envBool(
    'MARS_SELF_EVOLVE_AUTO_TRIGGER',
    DEFAULT_SELF_EVOLVE.autoEnqueue,
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
  let fileAutoEnqueue: boolean | undefined
  let fileDriftPct: number | undefined
  let fileConfThreshold: number | undefined
  let fileScoringAutoTrigger: boolean | undefined
  let fileScoringThreshold: number | undefined
  let fileScoringWindow: number | undefined
  let fileDefaultProvider: ProviderName | undefined
  let fileLastReflectRanAt: string | undefined

  try {
    const raw = readFileSync(daemonConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as {
      caps?: Record<string, unknown>
      selfEvolve?: Record<string, unknown>
      scoring?: Record<string, unknown>
      lastReflectRanAt?: unknown
    }
    const c = parsed.caps ?? {}
    fileCaps = {
      implement: positiveInt(c.implement, envCaps.implement),
      triage: positiveInt(c.triage, envCaps.triage),
      refine: positiveInt(c.refine, envCaps.refine),
      setupInstall: positiveInt(
        c.setupInstall ?? c['setup-install'],
        envCaps.setupInstall,
      ),
      verify: positiveInt(c.verify, envCaps.verify),
    }
    const se = parsed.selfEvolve ?? {}
    // Accept new key first, fall back to old key for migration.
    if (typeof se.autoEnqueue === 'boolean') {
      fileAutoEnqueue = se.autoEnqueue
    } else if (typeof se.autoTrigger === 'boolean') {
      fileAutoEnqueue = se.autoTrigger
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
    const rawProvider = (parsed as Record<string, unknown>).defaultProvider
    if (typeof rawProvider === 'string' && VALID_PROVIDER_NAMES.has(rawProvider)) {
      fileDefaultProvider = rawProvider as ProviderName
    }
    if (typeof parsed.lastReflectRanAt === 'string' && parsed.lastReflectRanAt.length > 0) {
      fileLastReflectRanAt = parsed.lastReflectRanAt
    }
  } catch {
    // No file, unreadable, or invalid JSON — fall back to env+defaults.
  }

  return {
    caps: {
      implement: fileCaps.implement ?? envCaps.implement,
      triage: fileCaps.triage ?? envCaps.triage,
      refine: fileCaps.refine ?? envCaps.refine,
      setupInstall: fileCaps.setupInstall ?? envCaps.setupInstall,
      verify: fileCaps.verify ?? envCaps.verify,
    },
    selfEvolve: {
      autoEnqueue: fileAutoEnqueue ?? envAutoEnqueue,
      driftThresholdPct: fileDriftPct ?? envDriftPct,
      taskConfidenceThreshold: fileConfThreshold ?? envConfThreshold,
    },
    scoring: {
      autoTrigger: fileScoringAutoTrigger ?? envScoringAutoTrigger,
      lowTrendThreshold: fileScoringThreshold ?? envScoringThreshold,
      lowTrendWindow: fileScoringWindow ?? envScoringWindow,
    },
    defaultProvider: fileDefaultProvider ?? DEFAULT_PROVIDER,
    controlLevers: readControlLevers(),
    lastReflectRanAt: fileLastReflectRanAt,
  }
}
