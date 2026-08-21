/**
 * One config loader for every `MARS_*`-overridable `daemon.json` field.
 *
 * `loadConfig()` composes, in override order (later wins):
 *
 *   built-in defaults  ←  daemon.json (`readDaemonConfigFile()`)  ←  env (`ENV_KNOBS`)
 *
 * into a single frozen `MarsConfig` object. This is intentionally a
 * *separate*, additive entry point from `../daemon/config.ts`'s
 * `loadDaemonConfig()` — that function has a long-standing, differently
 * ordered contract (file > env, documented and tested in
 * `daemon/__tests__/config-caps.test.ts`) that existing callers depend on.
 * `loadConfig()` here is the new typed layer described by this slice; wiring
 * existing call sites onto it is later work in this PRD ("do not pre-build
 * for them" — see the slice brief), not this change.
 *
 * See `./env-registry.ts` for why the registry module is named
 * `env-registry.ts` rather than the `registry.ts` the slice brief named (that
 * path is already the unrelated Port registry).
 */
import { readDaemonConfigFile, type DaemonConfigFile } from '../daemon/config'
import type { ProviderName } from '../workers/provider-types'
import { ENV_KNOBS, type EnvKnob } from './env-registry'

export interface MarsConfig {
  caps: {
    implement: number
    triage: number
    refine: number
    setupInstall: number
    verify: number
  }
  selfEvolve: {
    autoEnqueue: boolean
    driftThresholdPct: number
    taskConfidenceThreshold: number
  }
  scoring: {
    autoTrigger: boolean
    lowTrendThreshold: number
    lowTrendWindow: number
  }
  defaultProvider: ProviderName
}

/**
 * Thrown by `loadConfig()` when a `MARS_*` env var is present but its value
 * fails the declaring `EnvKnob`'s schema (e.g. `MARS_MAX_IMPLEMENT=banana`).
 * A named error (rather than letting the underlying zod `ZodError` surface)
 * so callers and tests can distinguish "bad env value" from any other
 * failure mode without inspecting the message.
 */
export class InvalidEnvValueError extends Error {
  constructor(
    public readonly varName: string,
    public readonly rawValue: string,
    reason: string,
  ) {
    super(`invalid value for ${varName}=${JSON.stringify(rawValue)}: ${reason}`)
    this.name = 'InvalidEnvValueError'
  }
}

const getPath = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)

const setPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const keys = path.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string
    const next = cur[key]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {}
    }
    cur = cur[key] as Record<string, unknown>
  }
  cur[keys[keys.length - 1] as string] = value
}

/** Recursively `Object.freeze`s `value` and every nested plain object. */
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v)
    }
    Object.freeze(value)
  }
  return value
}

/** Reads the first present value among `knob.path` + `knob.fileAliases` from `file`. */
const fileValueFor = (file: DaemonConfigFile, knob: EnvKnob): unknown => {
  const paths = knob.fileAliases ?? [knob.path]
  for (const path of paths) {
    const value = getPath(file, path)
    if (value !== undefined) return value
  }
  return undefined
}

export interface LoadConfigOptions {
  /** Defaults to `process.env`. Injectable for hermetic tests. */
  env?: NodeJS.ProcessEnv
  /**
   * Defaults to `readDaemonConfigFile()`. Injectable so tests can supply a
   * file value without touching the filesystem/`.mars` context.
   */
  fileConfig?: DaemonConfigFile
}

/**
 * Composes defaults ← daemon.json ← env into one frozen `MarsConfig`.
 *
 * Throws `InvalidEnvValueError` when a present `MARS_*` env var fails its
 * knob's schema — never silently falls back to the default the way the
 * legacy `env*` helpers in `daemon/config.ts` do, so a typo'd operator value
 * (e.g. `MARS_MAX_IMPLEMENT=banana`) is reported instead of quietly ignored.
 */
export const loadConfig = (opts: LoadConfigOptions = {}): Readonly<MarsConfig> => {
  const env = opts.env ?? process.env
  const fileConfig = opts.fileConfig ?? readDaemonConfigFile()

  const result: Record<string, unknown> = {
    caps: {},
    selfEvolve: {},
    scoring: {},
  }

  for (const knob of ENV_KNOBS) {
    setPath(result, knob.path, knob.default)

    const fileValue = fileValueFor(fileConfig, knob)
    if (fileValue !== undefined) {
      setPath(result, knob.path, fileValue)
    }

    const raw = env[knob.name]
    if (raw !== undefined && raw !== '') {
      const parsed = knob.schema.safeParse(raw)
      if (!parsed.success) {
        const reason = parsed.error.issues[0]?.message ?? 'invalid value'
        throw new InvalidEnvValueError(knob.name, raw, reason)
      }
      setPath(result, knob.path, parsed.data)
    }
  }

  return deepFreeze(result) as unknown as MarsConfig
}
