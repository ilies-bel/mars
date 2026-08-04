/**
 * The wizard runner (ADR-0058). Turns the declarative {@link WIZARD_PROMPTS}
 * table plus supplied flags/config into a fully-resolved {@link WizardChoices}.
 *
 * Resolution precedence per prompt (first hit wins):
 *   1. an explicit CLI flag (`flags[prompt.flag]`),
 *   2. a config value (`config[prompt.configKey]`),
 *   3. an interactive answer (TTY only),
 *   4. the prompt's `default`.
 *
 * On a non-TTY, or when readline errors/closes, the controller never blocks:
 * it falls straight through to flags → config → defaults. Tests inject a fake
 * `readLine` so the suite never hangs on real stdin.
 */

import { createInterface } from 'node:readline'
import {
  WIZARD_DEFAULTS,
  WIZARD_PROMPTS,
  type WizardChoices,
  type WizardPrompt,
} from './wizard'

/** Async line reader; production wraps Node's readline, tests inject a fake. */
export type LineReader = (question: string) => Promise<string>

export interface RunWizardOptions {
  /** True when stdin is an interactive terminal. */
  isTTY: boolean
  /** Parsed CLI flags (string for value flags, boolean for boolean flags). */
  flags: Record<string, string | boolean>
  /**
   * Config-file values keyed by `WizardPrompt.configKey`. Typically the
   * wizard-choice block parsed by `loadInitConfig`.
   */
  config?: Partial<Record<string, unknown>>
  /** `--force`: present for parity with init; does not change prompt routing. */
  force: boolean
  /**
   * Line reader override. Defaults to a real readline-backed reader. Tests
   * pass a fake to drive (and bound) the prompts.
   */
  readLine?: LineReader
}

const parseBoolean = (raw: unknown, fallback: boolean): boolean => {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    if (s === '' ) return fallback
    if (s === 'y' || s === 'yes' || s === 'true' || s === '1') return true
    if (s === 'n' || s === 'no' || s === 'false' || s === '0') return false
  }
  return fallback
}

const parseStringList = (raw: unknown): readonly string[] => {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter((v) => v !== '')
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '')
  }
  return []
}

const parseEnum = (
  raw: unknown,
  choices: readonly string[],
  fallback: string,
): string => {
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (choices.includes(s)) return s
  }
  return fallback
}

/**
 * Coerce a raw answer (from flag / config / interactive input) into the typed
 * value for `prompt.id`, falling back to the prompt default when absent or
 * unparseable.
 */
const coerce = (prompt: WizardPrompt, raw: unknown): unknown => {
  switch (prompt.type) {
    case 'boolean':
      return parseBoolean(raw, prompt.default as boolean)
    case 'string':
      return parseStringList(raw)
    case 'enum':
      return parseEnum(raw, prompt.choices ?? [], prompt.default as string)
  }
}

/** Build the interactive question label, surfacing choices/defaults inline. */
const promptLabel = (prompt: WizardPrompt): string => {
  if (prompt.type === 'boolean') {
    const def = prompt.default ? 'Y/n' : 'y/N'
    return `${prompt.question} [${def}] `
  }
  if (prompt.type === 'enum') {
    const choices = (prompt.choices ?? []).join('/')
    return `${prompt.question} (${choices}) [${String(prompt.default)}] `
  }
  return `${prompt.question} `
}

const defaultReader = (): { readLine: LineReader; close: () => void } => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return {
    readLine: (question) =>
      new Promise<string>((resolveAnswer) => {
        rl.question(question, (answer) => resolveAnswer(answer))
      }),
    close: () => rl.close(),
  }
}

/**
 * Resolve every prompt into a {@link WizardChoices}. Pure-ish: only side effect
 * is reading lines on a TTY (and only for prompts not already pinned by a flag
 * or config value).
 */
export const runWizard = async (
  prompts: readonly WizardPrompt[],
  opts: RunWizardOptions,
): Promise<WizardChoices> => {
  const resolved: Record<string, unknown> = { ...WIZARD_DEFAULTS }

  const flagFor = (p: WizardPrompt): unknown => opts.flags[p.flag]
  const configFor = (p: WizardPrompt): unknown => opts.config?.[p.configKey]

  // Only open a reader when we're on a TTY AND at least one prompt is not
  // already answered by a flag or config value — otherwise there is nothing
  // to ask, and on a non-TTY we must never block on real stdin.
  const wantInteractive =
    opts.isTTY &&
    prompts.some(
      (p) => flagFor(p) === undefined && configFor(p) === undefined,
    )

  let reader: { readLine: LineReader; close: () => void } | null = null
  if (wantInteractive) {
    if (opts.readLine) {
      reader = { readLine: opts.readLine, close: () => {} }
    } else {
      try {
        reader = defaultReader()
      } catch {
        // Could not attach to the terminal — treat as non-interactive.
        reader = null
      }
    }
  }

  try {
    for (const prompt of prompts) {
      // 1) explicit flag
      const flagVal = flagFor(prompt)
      if (flagVal !== undefined) {
        resolved[prompt.id] = coerce(prompt, flagVal)
        continue
      }
      // 2) config value
      const cfgVal = configFor(prompt)
      if (cfgVal !== undefined) {
        resolved[prompt.id] = coerce(prompt, cfgVal)
        continue
      }
      // 3) interactive (TTY only; interactiveOnly prompts still honour this
      //    path, but on a non-TTY they silently take their default below).
      if (reader && !(prompt.interactiveOnly && !opts.isTTY)) {
        try {
          const answer = await reader.readLine(promptLabel(prompt))
          resolved[prompt.id] = coerce(
            prompt,
            answer.trim() === '' ? prompt.default : answer,
          )
          continue
        } catch {
          // readline error mid-stream — fall through to defaults for this and
          // every remaining prompt.
          reader.close()
          reader = null
        }
      }
      // 4) default
      resolved[prompt.id] = coerce(prompt, prompt.default)
    }
  } finally {
    reader?.close()
  }

  return {
    registerProject: resolved.registerProject as boolean,
    verifyGates: WIZARD_DEFAULTS.verifyGates,
  }
}

/** Convenience wrapper over {@link runWizard} bound to the shipped table. */
export const runInitWizard = (opts: RunWizardOptions): Promise<WizardChoices> =>
  runWizard(WIZARD_PROMPTS, opts)
