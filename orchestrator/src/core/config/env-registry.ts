/**
 * The registry of every `MARS_*` environment variable that overrides a
 * `daemon.json` config field: name, the zod schema its raw string value must
 * parse against, and the dot-path into {@link MarsConfig} (see `./load.ts`)
 * it targets.
 *
 * Naming note: the slice brief for this file asked for
 * `src/core/config/registry.ts`, but that path is already occupied by the
 * unrelated **Port registry** (ADR-0097, `feat(config): add Port registry
 * shared contract`) — a catalog of swappable service implementations
 * (verifier/codeIndex/vcs), not typed config-value overrides. The two
 * registries model different things (a Port's `envVar` selects one of a
 * fixed set of *implementation kinds*; an env knob here parses a *typed
 * value* into a `MarsConfig` field) and conflating them into one file would
 * blur that distinction, so this module lives at `env-registry.ts` instead.
 *
 * Scope (tracer-bullet slice): this registry currently declares the knobs
 * `loadConfig()` (`./load.ts`) actually composes — the ones already
 * formalized in `../daemon/config.ts`'s `resolveEnvOverrides` /
 * `loadDaemonConfig` (caps, selfEvolve, scoring, defaultProvider). The wider
 * tree has many more ad hoc `MARS_*` reads (worker env passthrough, binary
 * resolution, timers, …) that are NOT `daemon.json`-backed config fields and
 * so are out of scope here; a later slice in this PRD migrates more modules
 * onto this registry rather than reading `process.env` directly.
 */
import { z } from 'zod'
import {
  DEFAULT_PROVIDER,
  DEFAULT_SCORING,
  DEFAULT_SELF_EVOLVE,
  DEFAULTS,
  VALID_PROVIDER_NAMES,
} from '../daemon/config'

/**
 * A dot-path into `MarsConfig`, e.g. `'caps.implement'`. Not exported: it's
 * only used to type fields within this file's own `EnvKnob` declarations.
 */
type MarsConfigPath = string

/**
 * One declared `MARS_*` knob. `schema` parses the *raw string* env value
 * (via `String.prototype` coercion inside the schema, e.g. `z.coerce.number()`)
 * into the typed value written to `path`. `default` is the value used when
 * neither `daemon.json` nor the env var supplies one.
 */
export interface EnvKnob {
  /** The `MARS_*` variable name, exactly as read from `process.env`. */
  name: string
  /**
   * Validates + coerces the raw env-var string into the target type.
   * Typed as `z.ZodTypeAny` (not a stricter `ZodType<unknown, string>`)
   * because zod v4's `z.coerce.*` schemas declare their Input as `unknown`
   * (they accept anything and coerce it), which cannot satisfy a narrower
   * `Input = string` constraint even though every schema here is in fact
   * always called with a string via `.safeParse(raw)` below.
   */
  schema: z.ZodTypeAny
  /** Dot-path into `MarsConfig` this knob overrides. */
  path: MarsConfigPath
  /** Value used when the knob is absent from both daemon.json and env. */
  default: unknown
  /**
   * Legacy/alternate dot-paths to also check when reading `daemon.json`
   * (checked in order, first match wins), for fields `daemonConfigSchema`
   * accepts under more than one key — e.g. `caps.setupInstall` vs the
   * kebab-case `caps.setup-install`, or `selfEvolve.autoEnqueue` vs the
   * legacy `selfEvolve.autoTrigger`. Defaults to `[path]` when omitted.
   */
  fileAliases?: readonly MarsConfigPath[]
}

/** Parses `'0' | '1' | 'true' | 'false'`; any other string is invalid. */
const boolFromEnv = z.string().transform((raw, ctx) => {
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `must be one of: 0, 1, true, false (got ${JSON.stringify(raw)})`,
  })
  return z.NEVER
})

const positiveIntFromEnv = z.coerce.number().int().positive()
const positiveNumberFromEnv = z.coerce.number().positive()
const unitIntervalFromEnv = z.coerce.number().min(0).max(1)

const providerFromEnv = z.string().refine(
  (raw: string) => VALID_PROVIDER_NAMES.has(raw),
  { message: `must be one of: ${[...VALID_PROVIDER_NAMES].join(', ')}` },
)

/**
 * The single source of truth for every `MARS_*` → `MarsConfig` override.
 * `loadConfig()` in `./load.ts` iterates this list; nothing else in that
 * module reads `process.env` directly.
 */
export const ENV_KNOBS: readonly EnvKnob[] = [
  {
    name: 'MARS_MAX_IMPLEMENT',
    schema: positiveIntFromEnv,
    path: 'caps.implement',
    default: DEFAULTS.implement,
  },
  {
    name: 'MARS_MAX_TRIAGE',
    schema: positiveIntFromEnv,
    path: 'caps.triage',
    default: DEFAULTS.triage,
  },
  {
    name: 'MARS_MAX_REFINE',
    schema: positiveIntFromEnv,
    path: 'caps.refine',
    default: DEFAULTS.refine,
  },
  {
    name: 'MARS_MAX_SETUP_INSTALL',
    schema: positiveIntFromEnv,
    path: 'caps.setupInstall',
    default: DEFAULTS.setupInstall,
    fileAliases: ['caps.setupInstall', 'caps.setup-install'],
  },
  {
    name: 'MARS_MAX_VERIFY',
    schema: positiveIntFromEnv,
    path: 'caps.verify',
    default: DEFAULTS.verify,
  },
  {
    name: 'MARS_SELF_EVOLVE_AUTO_TRIGGER',
    schema: boolFromEnv,
    path: 'selfEvolve.autoEnqueue',
    default: DEFAULT_SELF_EVOLVE.autoEnqueue,
    fileAliases: ['selfEvolve.autoEnqueue', 'selfEvolve.autoTrigger'],
  },
  {
    name: 'MARS_SELF_EVOLVE_DRIFT_THRESHOLD',
    schema: positiveNumberFromEnv,
    path: 'selfEvolve.driftThresholdPct',
    default: DEFAULT_SELF_EVOLVE.driftThresholdPct,
  },
  {
    name: 'MARS_SELF_EVOLVE_TASK_CONFIDENCE_THRESHOLD',
    schema: unitIntervalFromEnv,
    path: 'selfEvolve.taskConfidenceThreshold',
    default: DEFAULT_SELF_EVOLVE.taskConfidenceThreshold,
  },
  {
    name: 'MARS_SCORING_AUTO_TRIGGER',
    schema: boolFromEnv,
    path: 'scoring.autoTrigger',
    default: DEFAULT_SCORING.autoTrigger,
  },
  {
    name: 'MARS_SCORING_LOW_TREND_THRESHOLD',
    schema: unitIntervalFromEnv,
    path: 'scoring.lowTrendThreshold',
    default: DEFAULT_SCORING.lowTrendThreshold,
  },
  {
    name: 'MARS_SCORING_LOW_TREND_WINDOW',
    schema: positiveIntFromEnv,
    path: 'scoring.lowTrendWindow',
    default: DEFAULT_SCORING.lowTrendWindow,
  },
  {
    name: 'MARS_WORKER_PROVIDER',
    schema: providerFromEnv,
    path: 'defaultProvider',
    default: DEFAULT_PROVIDER,
  },
]
