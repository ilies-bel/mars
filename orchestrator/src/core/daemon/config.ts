import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
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
  /**
   * Gates whether a merge may sweep the operator's dirty edits on the
   * integration checkout into a `wip(operator)` commit so it can land
   * (ADR-0100). Read by the merge worker, which passes the answer to
   * `mergeBranch` as `autoCommitOperatorDirt`; when 'off' the merge falls
   * back to preserving the edits on a checkpoint ref. Default 'on'. No env
   * override.
   * Gesture: `mars operator set operator-auto-commit <on|off>`.
   */
  operatorAutoCommit: ControlLeverValue
}

export interface DaemonCaps {
  implement: number
  triage: number
  refine: number
  /** Maximum concurrent worktree dependency installs (MARS_MAX_SETUP_INSTALL). Default 2. */
  setupInstall: number
  /**
   * Maximum concurrent verify steps (MARS_MAX_VERIFY). Default 1.
   *
   * The verify step (npm test / typecheck) is CPU-intensive and uses
   * process-global resources (embedded-PG ports, snapshot directories, tmp
   * paths) that cannot safely be shared between concurrent test suites. Two
   * parallel verifies reliably produce cross-suite interference: env-var
   * mutations in one vitest worker bleed into another, embedded-PG instances
   * collide on fixed ports, and snapshot writes race — observed as 232+
   * failures when two tasks verified at the same time (mars-caae60e2 /
   * mars-191c9ef5). A cap of 1 serialises verify runs so at most one full
   * test suite runs at a time, eliminating the interference at the cost of
   * queuing (wall-clock is dominated by one run anyway, so no throughput is
   * lost when two would otherwise thrash each other).
   *
   * Raise MARS_MAX_VERIFY (or `mars set-cap verify N`) only for test suites
   * that are explicitly verified as parallel-safe. The cap is deadlock-safe:
   * a task waiting on this semaphore releases its implement slot first so
   * other tasks can continue coding while verify is queued.
   */
  verify: number
}

/**
 * Maps every DaemonCaps property key (camelCase) to the CLI cap name (kebab-case).
 * Typed as `Record<keyof DaemonCaps, string>` — TypeScript errors here if a
 * DaemonCaps key is missing, so the compile step acts as the drift gate.
 * Never edit one without updating the other.
 */
const CAP_JSON_TO_CLI: Record<keyof DaemonCaps, string> = {
  implement: 'implement',
  triage: 'triage',
  refine: 'refine',
  setupInstall: 'setup-install',
  verify: 'verify',
}

/**
 * Maps CLI cap names (kebab-case, as typed by the operator) to DaemonCaps
 * property keys (camelCase, as stored in daemon.json). Derived from
 * CAP_JSON_TO_CLI so the two cannot drift — use this in `set-cap` to validate
 * and translate user input.
 */
export const CAP_CLI_TO_JSON: Readonly<Record<string, keyof DaemonCaps>> =
  Object.fromEntries(
    Object.entries(CAP_JSON_TO_CLI).map(([json, cli]) => [cli, json as keyof DaemonCaps]),
  )

/**
 * Maximum allowed concurrency cap per worker kind.
 *
 * Derived from the machine's CPU count so it scales with hardware but stays
 * bounded. A fat-fingered value like 9999 is refused at `set-cap` time with an
 * error that names this ceiling. Formula: `max(64, cpus * 2)` — 64 already
 * exceeds the largest default cap (implement=12), and on server-class hardware
 * with many cores the ceiling scales naturally without operator intervention.
 */
export const MAX_CONCURRENCY_CAP: number = Math.max(64, cpus().length * 2)

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
  /**
   * Number of days after an operator resolves a reflect-recommended
   * action-queue item before the detector is allowed to raise a new one.
   * Prevents the operator's explicit dismissal from being undone by the
   * next detector sweep. Default 7. Set to 0 to disable the cooldown.
   */
  reflectCooldownDays: number
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

/**
 * Zod schema for the raw `.mars/daemon.json` file on disk (before env/default
 * resolution). Every field is optional/partial because daemon.json is a
 * merge-patched, hand-editable file — a field that is entirely absent must
 * degrade to the built-in default, never throw.
 *
 * Mirrors every field currently read ad hoc across this file, including the
 * legacy aliases (`selfEvolve.autoTrigger`, `levers`, `caps['setup-install']`)
 * so `readDaemonConfigFile` keeps accepting existing daemon.json files.
 *
 * `.passthrough()` deliberately preserves top-level keys this schema does not
 * model (`budget`, `qaStepList`, `health`, …) — several call sites
 * (`spend-meter.ts`, `qa-step-list-flag.ts`, `server.ts`'s health scheduler)
 * read those directly off `readDaemonConfigFile()`'s result and merge-preserve
 * them on write; stripping them here would silently corrupt those flows.
 *
 * `readDaemonConfigFile` parses every read through this schema
 * (`daemonConfigSchema.safeParse`) and throws a descriptive, field-naming
 * error — instead of an untyped `JSON.parse(...) as {...}` cast that would
 * explode later somewhere unrelated — when a *present* field has the wrong
 * shape. A missing/unreadable file or unparseable JSON still degrades to `{}`
 * (there is no config to validate in that case).
 */
export const daemonConfigSchema = z
  .object({
    caps: z
      .object({
        implement: z.number().optional(),
        triage: z.number().optional(),
        refine: z.number().optional(),
        setupInstall: z.number().optional(),
        'setup-install': z.number().optional(),
        verify: z.number().optional(),
      })
      .partial()
      .optional(),
    selfEvolve: z
      .object({
        autoEnqueue: z.boolean().optional(),
        /** Legacy alias for `autoEnqueue`, accepted for migration. */
        autoTrigger: z.boolean().optional(),
        driftThresholdPct: z.number().optional(),
        taskConfidenceThreshold: z.number().optional(),
        reflectCooldownDays: z.number().optional(),
      })
      .partial()
      .optional(),
    scoring: z
      .object({
        autoTrigger: z.boolean().optional(),
        lowTrendThreshold: z.number().optional(),
        lowTrendWindow: z.number().optional(),
      })
      .partial()
      .optional(),
    defaultProvider: z.string().optional(),
    controlLevers: z
      .object({
        recovery: z.enum(['on', 'off']).optional(),
        scoring: z.enum(['on', 'off']).optional(),
        memoryCapture: z.enum(['on', 'off']).optional(),
        /** Legacy alias for `memoryCapture`, accepted for migration. */
        autoReflect: z.enum(['on', 'off']).optional(),
        autoRunReflect: z.enum(['on', 'off']).optional(),
        operatorAutoCommit: z.enum(['on', 'off']).optional(),
      })
      .partial()
      .optional(),
    producerLevers: z.record(z.string(), z.unknown()).optional(),
    /** Legacy alias for `producerLevers`, accepted for migration. */
    levers: z.record(z.string(), z.unknown()).optional(),
    workerPrompts: z.record(z.string(), z.string()).optional(),
    steward: z
      .object({
        autotuneMaxImplement: z.number().optional(),
      })
      .partial()
      .optional(),
    paused: z.boolean().optional(),
    lastReflectRanAt: z.string().optional(),
    proposalExpiryDays: z.number().optional(),
  })
  .partial()
  .passthrough()

/** Inferred TS type for the raw persisted daemon.json shape. */
export type DaemonConfigFile = z.infer<typeof daemonConfigSchema>

/**
 * Typed view of every env var `loadDaemonConfig` currently reads ad hoc via
 * `envInt`/`envBool`/manual `process.env[...]` lookups, resolved and clamped
 * to the same defaults it already falls back to. This is the shared contract
 * for the "Typed env-override layer inside one config loader" slice: replace
 * the scattered `envInt('MARS_MAX_IMPLEMENT', ...)`-style calls sprinkled
 * through `loadDaemonConfig` with one `resolveEnvOverrides()` call.
 *
 * Every field is always present (never `undefined`) because each already
 * degrades to a built-in default when its env var is absent or invalid —
 * callers merge `fileValue ?? envOverrides.<field>` exactly as today.
 */
export interface DaemonEnvOverrides {
  caps: DaemonCaps
  selfEvolve: Pick<SelfEvolveConfig, 'autoEnqueue' | 'driftThresholdPct' | 'taskConfidenceThreshold'>
  scoring: Pick<ScoringConfig, 'autoTrigger' | 'lowTrendThreshold' | 'lowTrendWindow'>
}

/**
 * Resolve every daemon.json env-var override from `env` (defaults to
 * `process.env`) into one typed object. Pure function — takes the env map as
 * a parameter instead of reading `process.env` internally, so it is testable
 * without mutating global state and so the eventual "Inject config instead of
 * laundering levers through process.env" work has a template to follow for
 * the rest of this module.
 */
export const resolveEnvOverrides = (
  env: NodeJS.ProcessEnv = process.env,
): DaemonEnvOverrides => {
  const int = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    if (raw === '1' || raw === 'true') return true
    if (raw === '0' || raw === 'false') return false
    return fallback
  }
  const float01 = (name: string, fallback: number): number => {
    const raw = env[name]
    const n = raw !== undefined && raw !== '' ? Number(raw) : NaN
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback
  }
  const positive = (name: string, fallback: number): number => {
    const raw = env[name]
    const n = raw !== undefined && raw !== '' ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  return {
    caps: {
      implement: int('MARS_MAX_IMPLEMENT', DEFAULTS.implement),
      triage: int('MARS_MAX_TRIAGE', DEFAULTS.triage),
      refine: int('MARS_MAX_REFINE', DEFAULTS.refine),
      setupInstall: int('MARS_MAX_SETUP_INSTALL', DEFAULTS.setupInstall),
      verify: int('MARS_MAX_VERIFY', DEFAULTS.verify),
    },
    selfEvolve: {
      autoEnqueue: bool('MARS_SELF_EVOLVE_AUTO_TRIGGER', DEFAULT_SELF_EVOLVE.autoEnqueue),
      driftThresholdPct: positive(
        'MARS_SELF_EVOLVE_DRIFT_THRESHOLD',
        DEFAULT_SELF_EVOLVE.driftThresholdPct,
      ),
      taskConfidenceThreshold: float01(
        'MARS_SELF_EVOLVE_TASK_CONFIDENCE_THRESHOLD',
        DEFAULT_SELF_EVOLVE.taskConfidenceThreshold,
      ),
    },
    scoring: {
      autoTrigger: bool('MARS_SCORING_AUTO_TRIGGER', DEFAULT_SCORING.autoTrigger),
      lowTrendThreshold: float01(
        'MARS_SCORING_LOW_TREND_THRESHOLD',
        DEFAULT_SCORING.lowTrendThreshold,
      ),
      lowTrendWindow: int('MARS_SCORING_LOW_TREND_WINDOW', DEFAULT_SCORING.lowTrendWindow),
    },
  }
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
   * Operator control levers. Written by `mars operator set` and read back out
   * of `daemon.json` by every consumer, so a hold set before a restart
   * persists across it with no re-application step. Consumers receive the
   * resolved value from `src/core/config/levers.ts`'s
   * `resolveControlLevers()` as a parameter — they never read a lever out of
   * `process.env` themselves.
   */
  controlLevers: ControlLevers
  /**
   * ISO-8601 timestamp of when the reflection pipeline last completed.
   * Written by `persistLastReflectRanAt` when `runReflect` finishes.
   * Absent until at least one reflection has run.
   */
  lastReflectRanAt?: string
  /**
   * Number of days after last update before an auto-generated (agent-authored)
   * draft proposal is moved to 'expired'. The sweep runs at daemon boot and
   * daily. Operator-created proposals (author_kind = 'human') are never
   * auto-expired. Set via daemon.json key `proposalExpiryDays`. Default 14.
   */
  proposalExpiryDays: number
}

/**
 * Exported (not just module-private) so `src/core/config/registry.ts` can
 * declare its `MARS_MAX_*` knob defaults from this single source of truth
 * instead of duplicating the literals — see that module for the typed
 * env-registry this JSDoc has been foreshadowing.
 */
export const DEFAULTS: DaemonCaps = {
  implement: 12,
  triage: 8,
  refine: 6,
  setupInstall: 2,
  // Serialise verify runs by default — parallel suites share ports and
  // snapshot dirs, which produces cross-suite failures (see DaemonCaps.verify
  // JSDoc). Raise MARS_MAX_VERIFY only for explicitly parallel-safe suites.
  verify: 1,
}

/** Exported for `src/core/config/registry.ts` — see {@link DEFAULTS}. */
export const DEFAULT_SELF_EVOLVE: SelfEvolveConfig = {
  autoEnqueue: false,
  driftThresholdPct: 10,
  taskConfidenceThreshold: 0.8,
  reflectCooldownDays: 7,
}

/** Exported for `src/core/config/registry.ts` — see {@link DEFAULTS}. */
export const DEFAULT_SCORING: ScoringConfig = {
  autoTrigger: false,
  lowTrendThreshold: 0.5,
  lowTrendWindow: 5,
}

/** Exported for `src/core/config/registry.ts` — see {@link DEFAULTS}. */
export const DEFAULT_PROVIDER: ProviderName = 'codex'

const DEFAULT_PROPOSAL_EXPIRY_DAYS = 14

const DEFAULT_CONTROL_LEVERS: ControlLevers = {
  recovery: 'on',
  scoring: 'on',
  memoryCapture: 'on',
  autoRunReflect: 'off',
  operatorAutoCommit: 'on',
}

/** Exported for `src/core/config/registry.ts` — see {@link DEFAULTS}. */
export const VALID_PROVIDER_NAMES = new Set<string>(['claude', 'gemini', 'codex'])

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
  const existing = readDaemonConfigFileLenient()
  const existingSe =
    existing.selfEvolve !== null &&
    typeof existing.selfEvolve === 'object' &&
    !Array.isArray(existing.selfEvolve)
      ? (existing.selfEvolve as Record<string, unknown>)
      : {}
  patchDaemonConfigFile({ selfEvolve: { ...existingSe, autoEnqueue } })
}

/**
 * Persist a selfEvolve patch to daemon.json, merging into the existing block.
 * Any fields not in `patch` are preserved. Used by `operator set` for
 * selfEvolve knobs other than `autoEnqueue`.
 */
export const persistSelfEvolvePatch = (patch: Partial<SelfEvolveConfig>): void => {
  const existing = readDaemonConfigFileLenient()
  const existingSe =
    existing.selfEvolve !== null &&
    typeof existing.selfEvolve === 'object' &&
    !Array.isArray(existing.selfEvolve)
      ? (existing.selfEvolve as Record<string, unknown>)
      : {}
  patchDaemonConfigFile({ selfEvolve: { ...existingSe, ...patch } })
}

/**
 * Persist a scoring patch to daemon.json, merging into the existing block.
 * Any fields not in `patch` are preserved. Used by `operator set` for
 * scoring knobs.
 */
export const persistScoringPatch = (patch: Partial<ScoringConfig>): void => {
  const existing = readDaemonConfigFileLenient()
  const existingSc =
    existing.scoring !== null &&
    typeof existing.scoring === 'object' &&
    !Array.isArray(existing.scoring)
      ? (existing.scoring as Record<string, unknown>)
      : {}
  patchDaemonConfigFile({ scoring: { ...existingSc, ...patch } })
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
 *
 * A *present* object is parsed through `daemonConfigSchema`. A field that
 * fails validation throws a descriptive error naming the offending field
 * path and the file path, instead of an untyped cast that would explode
 * later somewhere unrelated. There is no config to validate for a
 * missing/unreadable file or unparseable JSON, so those cases still
 * degrade to `{}` rather than throw.
 */
export const readDaemonConfigFile = (): Record<string, unknown> => {
  let raw: string
  try {
    raw = readFileSync(daemonConfigPath(), 'utf8')
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  const result = daemonConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const fieldPath = issue !== undefined && issue.path.length > 0 ? issue.path.join('.') : '(root)'
    const message = issue?.message ?? result.error.message
    throw new Error(
      `daemon.json at '${daemonConfigPath()}' has an invalid field '${fieldPath}': ${message}`,
    )
  }
  return result.data
}

/**
 * Lenient wrapper around `readDaemonConfigFile`: degrades to `{}` for a
 * present-but-invalid field exactly like it already does for a missing file
 * or unparseable JSON. Every other helper in this module reads/merge-patches
 * one small slice of daemon.json (`paused`, `steward`, `producerLevers`,
 * `workerPrompts`, `selfEvolve`, `scoring`, …) and has a long-standing "return
 * a safe default / preserve what you can, never refuse to operate" contract —
 * a validation failure in some unrelated field must not brick those call
 * sites. Only direct callers that want the strict, field-naming failure (e.g.
 * an operator-facing `daemon.json` linter) should call `readDaemonConfigFile`
 * itself.
 */
const readDaemonConfigFileLenient = (): Record<string, unknown> => {
  try {
    return readDaemonConfigFile()
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
  const current = readDaemonConfigFileLenient()
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
  const raw = readDaemonConfigFileLenient()
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
 * Read the persisted `steward.autotuneMaxImplement` ceiling from daemon.json.
 * Returns `null` when the lever is absent (autotune defaults to 2× the
 * baseline cap in that case). Only positive integers are accepted; anything
 * else is treated as absent.
 */
export const readAutotuneMaxImplement = (): number | null => {
  const raw = readDaemonConfigFileLenient()
  const steward = raw.steward
  if (steward === null || typeof steward !== 'object' || Array.isArray(steward)) return null
  const val = (steward as Record<string, unknown>).autotuneMaxImplement
  if (
    typeof val !== 'number' ||
    !Number.isFinite(val) ||
    !Number.isInteger(val) ||
    val < 1
  )
    return null
  return val
}

/**
 * Persist the `steward.autotuneMaxImplement` ceiling to daemon.json. Pass
 * `null` to remove the ceiling (restores the default 2× baseline behaviour).
 * Preserves all other keys via `patchDaemonConfigFile`.
 */
export const persistAutotuneMaxImplement = (n: number | null): void => {
  const current = readDaemonConfigFileLenient()
  const existing =
    current.steward !== null &&
    typeof current.steward === 'object' &&
    !Array.isArray(current.steward)
      ? (current.steward as Record<string, unknown>)
      : {}
  if (n === null) {
    const { autotuneMaxImplement: _removed, ...rest } = existing
    patchDaemonConfigFile({ steward: Object.keys(rest).length > 0 ? rest : null })
  } else {
    patchDaemonConfigFile({ steward: { ...existing, autotuneMaxImplement: n } })
  }
}

/**
 * Read the autonomy_level for `name` from daemon.json's `producerLevers` map.
 * Returns the default level when the lever is absent. A persisted invalid or
 * retired value is rejected explicitly so an operator's autonomy choice is
 * never silently changed to the default.
 *
 * Migration: falls back to the legacy `levers` key when `producerLevers` is
 * absent, so existing daemon.json files continue to work until the key is
 * rewritten by `persistLeverAutonomyLevel`.
 */
export const readLeverAutonomyLevel = (name: string): AutonomyLevel => {
  const raw = readDaemonConfigFileLenient()
  // Prefer `producerLevers`; fall back to the legacy `levers` key.
  const leversRaw = raw.producerLevers ?? raw.levers
  if (leversRaw === null || typeof leversRaw !== 'object' || Array.isArray(leversRaw)) {
    return defaultLevelFor(name)
  }
  const leverData = (leversRaw as Record<string, unknown>)[name]
  if (leverData === null || typeof leverData !== 'object' || Array.isArray(leverData)) {
    return defaultLevelFor(name)
  }
  const autonomyLevel = (leverData as Record<string, unknown>).autonomy_level
  if (autonomyLevel !== undefined && !AUTONOMY_LEVELS.includes(autonomyLevel as AutonomyLevel)) {
    const kind = autonomyLevel === 'silent' ? 'retired' : 'invalid'
    throw new Error(
      `daemon.json producerLevers '${name}' has ${kind} autonomy level '${String(autonomyLevel)}'; valid levels are 'off', 'ask', or 'tell'`,
    )
  }
  const parsed = leverSchema.safeParse(leverData)
  if (!parsed.success) {
    throw new Error(
      `daemon.json producerLevers '${name}' is invalid; autonomy must be 'off', 'ask', or 'tell'`,
    )
  }
  return parsed.data.autonomy_level
}

/** Read an operator-/Steward-managed standing Worker prompt block, if any. */
export const readWorkerPromptOverride = (block: WorkerPromptBlockId): string | null => {
  const workerPrompts = readDaemonConfigFileLenient().workerPrompts
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
  const current = readDaemonConfigFileLenient()
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
 * Persist an autonomy_level for `name` into daemon.json's `producerLevers` map.
 * Merge-patches so other lever fields and top-level keys are preserved.
 *
 * Always writes to `producerLevers` (the canonical key). Existing entries in
 * the legacy `levers` key are merged in on first write so no data is lost
 * during the migration.
 */
export const persistLeverAutonomyLevel = (name: string, level: AutonomyLevel): void => {
  const current = readDaemonConfigFileLenient()
  // Merge legacy `levers` entries into `producerLevers` on first write.
  const legacyLevers =
    current.levers !== null &&
    typeof current.levers === 'object' &&
    !Array.isArray(current.levers)
      ? (current.levers as Record<string, unknown>)
      : {}
  const existingLevers =
    current.producerLevers !== null &&
    typeof current.producerLevers === 'object' &&
    !Array.isArray(current.producerLevers)
      ? (current.producerLevers as Record<string, unknown>)
      : legacyLevers
  const existingLever =
    existingLevers[name] !== null &&
    typeof existingLevers[name] === 'object' &&
    !Array.isArray(existingLevers[name])
      ? (existingLevers[name] as Record<string, unknown>)
      : {}
  const patch: Record<string, unknown> = {
    producerLevers: { ...existingLevers, [name]: { ...existingLever, autonomy_level: level } },
  }
  // Remove the legacy key when migrating; null removes the top-level key.
  if (current.levers !== undefined) patch.levers = null
  patchDaemonConfigFile(patch)
}

/**
 * Read the persisted `controlLevers` from daemon.json, returning defaults for
 * any absent or invalid fields. This is the file half of lever resolution;
 * `src/core/config/levers.ts`'s `resolveControlLevers()` layers the
 * `MARS_*_DISABLED` env overrides on top and is what consumers should call.
 *
 * Migrates on read: the old `autoReflect` key is accepted as `memoryCapture`
 * so existing daemon.json files from before the rename continue to work.
 *
 * Uses `readDaemonConfigFileLenient` (not `readDaemonConfigFile` directly):
 * `readControlLevers` is one of `loadDaemonConfig`'s building blocks, and
 * `loadDaemonConfig` has a long-standing contract — "the file is optional; a
 * missing/invalid file silently falls back to env+defaults so the daemon
 * never refuses to start because of a malformed config" — so a validation
 * failure caused by some other, unrelated field (e.g. a malformed
 * `selfEvolve` block) must degrade to the defaults here too, exactly like an
 * absent file, rather than propagate.
 */
export const readControlLevers = (): ControlLevers => {
  const file = readDaemonConfigFileLenient()
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
    if (record.operatorAutoCommit === 'on' || record.operatorAutoCommit === 'off') {
      result.operatorAutoCommit = record.operatorAutoCommit
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
  let fileReflectCooldownDays: number | undefined
  let fileScoringAutoTrigger: boolean | undefined
  let fileScoringThreshold: number | undefined
  let fileScoringWindow: number | undefined
  let fileDefaultProvider: ProviderName | undefined
  let fileLastReflectRanAt: string | undefined
  let fileProposalExpiryDays: number | undefined

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
    const seCooldown = se.reflectCooldownDays
    if (
      typeof seCooldown === 'number' &&
      Number.isFinite(seCooldown) &&
      Number.isInteger(seCooldown) &&
      seCooldown >= 0
    ) {
      fileReflectCooldownDays = seCooldown
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
    const rawExpiryDays = (parsed as Record<string, unknown>).proposalExpiryDays
    if (
      typeof rawExpiryDays === 'number' &&
      Number.isFinite(rawExpiryDays) &&
      Number.isInteger(rawExpiryDays) &&
      rawExpiryDays > 0
    ) {
      fileProposalExpiryDays = rawExpiryDays
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
      reflectCooldownDays: fileReflectCooldownDays ?? DEFAULT_SELF_EVOLVE.reflectCooldownDays,
    },
    scoring: {
      autoTrigger: fileScoringAutoTrigger ?? envScoringAutoTrigger,
      lowTrendThreshold: fileScoringThreshold ?? envScoringThreshold,
      lowTrendWindow: fileScoringWindow ?? envScoringWindow,
    },
    defaultProvider: fileDefaultProvider ?? DEFAULT_PROVIDER,
    controlLevers: readControlLevers(),
    lastReflectRanAt: fileLastReflectRanAt,
    proposalExpiryDays: fileProposalExpiryDays ?? DEFAULT_PROPOSAL_EXPIRY_DAYS,
  }
}
