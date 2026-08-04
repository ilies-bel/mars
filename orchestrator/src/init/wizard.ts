/**
 * Single declarative source of truth for `mars init`'s interactive wizard
 * AND its non-interactive parity surface (ADR-0058).
 *
 * `mars init` has exactly ONE entry point. On a TTY it runs a short wizard;
 * with `--yes` or no TTY it runs fully non-interactively from flags + defaults.
 * Parity between the two paths is not aspirational — it is enforced by a
 * build-guard test (`__tests__/wizard-parity.test.ts`) that iterates this
 * very table.
 *
 * The invariant (ADR-0011 precedent): every wizard prompt MUST be reachable
 * non-interactively. Concretely, each {@link WizardPrompt} carries BOTH:
 *   - a `flag` declared in cli/args.ts (`BOOLEAN_FLAGS` for boolean prompts,
 *     `FLAGS_WITH_VALUES` for string/enum prompts), and
 *   - a `configKey` (kept for schema compatibility).
 *
 * A choice with no non-interactive path is therefore EXCLUDED from the wizard
 * (e.g. plugin activation, which stays automatic and is not a prompt). If you
 * add a prompt here without wiring its flag and configKey, the parity test
 * fails the build.
 */

import type { VerifyGateInput } from '../core/verify-gates'

/** The shape of a single wizard prompt — the parity contract. */
export interface WizardPrompt {
  /** Stable identifier; also the key under which the answer lands in WizardChoices. */
  id: keyof WizardChoices
  /** Human-facing question shown on a TTY. */
  question: string
  /** The non-interactive CLI flag. MUST exist in cli/args.ts flag sets. */
  flag: string
  /** The non-interactive TOML config key. MUST be accepted by loadInitConfig. */
  configKey: string
  /** Answer shape. */
  type: 'boolean' | 'string' | 'enum'
  /** Allowed values when `type === 'enum'`. */
  choices?: readonly string[]
  /** Fallback used non-interactively and on TTY when the user just hits enter. */
  default: unknown
  /**
   * When true the prompt is only ever surfaced on a TTY; non-interactive runs
   * silently take the default. (No prompt in the shipped table uses this — it
   * exists so a purely-cosmetic confirmation could be added without breaking
   * parity, since the flag/config still exist.)
   */
  interactiveOnly?: boolean
}

/**
 * The structured result of running the wizard, threaded into the init
 * workflow via `RunInitOptions.wizardChoices`. Every field is resolved (no
 * `undefined`): the controller always applies a default.
 */
export interface WizardChoices {
  /** Register this repo in the global project registry (~/.mars/projects.json). */
  registerProject: boolean
  /** Verify gates detected before a non-interactive init reaches the daemon. */
  verifyGates: VerifyGateInput[]
}

/** Resolved-everywhere defaults; also the non-TTY / error fallback. */
export const WIZARD_DEFAULTS: WizardChoices = {
  registerProject: true,
  verifyGates: [],
}

/**
 * THE table. One row per wizard prompt; the single source of truth the parity
 * test iterates. Order here is the order prompts are shown on a TTY.
 */
export const WIZARD_PROMPTS: readonly WizardPrompt[] = [
  {
    id: 'registerProject',
    question:
      'Register this repo in the global Mars project registry so the UI lists it?',
    flag: '--register-project',
    configKey: 'registerProject',
    type: 'boolean',
    default: true,
  },
]
