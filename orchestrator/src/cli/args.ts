/**
 * Shared CLI argument parsing — pure, side-effect-free helpers (ADR-0023 §5).
 *
 * `parseArgs` turns raw argv into a {@link ParsedArgs} (the same shape the old
 * inline parser produced). Per-flag helpers (`parsePriority`, `parseTaskType`,
 * `parseTaskSpec`, …) validate a single flag and return either a typed value
 * or a structured error, so every Command validates flags identically and the
 * registry-iterating "every leaf rejects unknown flags" test has a single
 * source of truth for the allowed flag surface.
 *
 * Nothing here touches `console` or `process.exit`; callers turn a returned
 * error into a `deps.err(...)` + `CommandResult{code}`.
 */

import { readFileSync } from 'node:fs'

export interface ParsedArgs {
  repo?: string
  flags: Record<string, string>
  multiFlags: Record<string, string[]>
  positional: string[]
}

/** Value-bearing flags: `--flag value` or `--flag=value`. */
export const FLAGS_WITH_VALUES: ReadonlySet<string> = new Set([
  '--repo',
  '--functional',
  '--func',
  '--technical',
  '--tech',
  '--functional-file',
  '--technical-file',
  '--since',
  '--limit',
  '--out',
  '--author',
  '--note',
  '--root-cause',
  '--avoid',
  '--blocked-by',
  '--source',
  '--status',
  '--from',
  '--kind',
  '--port',
  '--host',
  '--priority',
  '--tag',
  '--files',
  '--verify',
  '--done',
  '--type',
  '--wrapper',
  '--session',
  '--model',
  '--effort',
  '--permission-mode',
  '--max-messages',
  '--name',
  '--path',
  '--config',
  '--intent',
  // mars init wizard non-interactive parity (ADR-0058). One value flag per
  // string/enum WizardPrompt in src/init/wizard.ts; the parity build-guard
  // (init/__tests__/wizard-parity.test.ts) fails if a prompt lacks its flag.
  '--supervisors',
  '--scaffold-mode',
])

/**
 * Boolean flags accepted by one or more leaves. Combined with
 * {@link FLAGS_WITH_VALUES} this is the full set of flags any leaf may legally
 * see; the registry-iterating test rejects anything outside the union.
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--force',
  '--dry-run',
  '--verbose',
  '--dev',
  '--foreground',
  '--detach',
  '--stop',
  '--json',
  '--lean',
  '--with-transcript-only',
  '--force-orphans',
  '--yes',
  '-y',
  // mars init single-entry wizard routing (ADR-0058). `--wizard` forces the
  // wizard even on a non-TTY; `--wizard-off` skips it on a TTY. Boolean
  // WizardPrompts (e.g. project registration) also live here.
  '--wizard',
  '--wizard-off',
  '--register-project',
  '--help',
  '-h',
  '--version',
  '-v',
])

// Short aliases for value-bearing flags, normalised to their long form before
// the FLAGS_WITH_VALUES lookup. `-f` is `mars init`'s declarative-config flag.
export const SHORT_FLAG_ALIASES: Readonly<Record<string, string>> = {
  '-f': '--config',
}

export const REPEATABLE_FLAGS: ReadonlySet<string> = new Set([
  '--blocked-by',
  '--files',
  '--done',
  '--tag',
])

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const multiFlags: Record<string, string[]> = {}
  let repo: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue

    const eq = a.indexOf('=')
    const rawKey = eq === -1 ? a : a.slice(0, eq)
    const key = SHORT_FLAG_ALIASES[rawKey] ?? rawKey
    const inlineValue = eq === -1 ? undefined : a.slice(eq + 1)

    if (key === '--repo') {
      repo = inlineValue ?? argv[++i]
      continue
    }
    if (FLAGS_WITH_VALUES.has(key)) {
      const value = inlineValue ?? argv[++i]
      if (value === undefined) throw new Error(`flag ${key} requires a value`)
      if (REPEATABLE_FLAGS.has(key)) {
        const list = multiFlags[key] ?? []
        list.push(value)
        multiFlags[key] = list
      } else {
        flags[key] = value
      }
      continue
    }
    positional.push(a)
  }
  return { repo, flags, multiFlags, positional }
}

/**
 * Resolve a `@path` reference to its file contents, else return the literal.
 * Used by plan/body args that accept inline text or `@file`.
 */
export const readMaybeFile = (raw: string): string => {
  if (raw.startsWith('@')) {
    return readFileSync(raw.slice(1), 'utf8')
  }
  return raw
}

/**
 * Resolve plan text from inline keys (e.g. `--functional`/`--func`) or a
 * file-key fallback (`--functional-file`). Inline values honour `@path`.
 */
export const resolvePlanText = (
  flags: Record<string, string>,
  inlineKeys: readonly string[],
  fileKey: string,
): string | undefined => {
  for (const key of inlineKeys) {
    const v = flags[key]
    if (v !== undefined) return readMaybeFile(v)
  }
  const filePath = flags[fileKey]
  if (filePath !== undefined) return readFileSync(filePath, 'utf8')
  return undefined
}

// ── Per-flag validators ─────────────────────────────────────────────────────
//
// Each returns a discriminated result: `{ ok: true, value }` or
// `{ ok: false, message }`. The caller emits the message via `deps.err` and
// returns a `CommandResult{code}` — no helper ever exits or prints.

export type FlagResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

/** `--priority` / positional priority: integer in 0..3. */
export const parsePriority = (raw: string): FlagResult<number> => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    return { ok: false, message: `priority must be an integer in 0..3; got '${raw}'` }
  }
  return { ok: true, value: n }
}

/** `--type`: one of auto|checkpoint (the only valid task types). */
export const parseTaskType = (
  raw: string,
): FlagResult<'auto' | 'checkpoint'> => {
  if (raw !== 'auto' && raw !== 'checkpoint') {
    return { ok: false, message: `type must be one of auto, checkpoint; got '${raw}'` }
  }
  return { ok: true, value: raw }
}

export interface TaskSpec {
  files: readonly string[]
  verifyCmd: string | null
  doneCriteria: readonly string[]
  taskType: 'auto' | 'checkpoint'
}

/**
 * Build a structured-task spec from the `--files`/`--verify`/`--done`/`--type`
 * flags. Returns `{ ok: true, value: undefined }` when none are present (the
 * row keeps the legacy free-prose shape). Validates `--type` when present.
 */
export const parseTaskSpec = (
  args: Pick<ParsedArgs, 'flags' | 'multiFlags'>,
): FlagResult<TaskSpec | undefined> => {
  const filesList = args.multiFlags['--files'] ?? []
  const doneList = args.multiFlags['--done'] ?? []
  const verifyRaw = args.flags['--verify']
  const typeRaw = args.flags['--type']
  const anySpec =
    filesList.length > 0 ||
    doneList.length > 0 ||
    verifyRaw !== undefined ||
    typeRaw !== undefined
  if (!anySpec) return { ok: true, value: undefined }

  let taskType: 'auto' | 'checkpoint' = 'auto'
  if (typeRaw !== undefined) {
    const parsed = parseTaskType(typeRaw)
    if (!parsed.ok) return parsed
    taskType = parsed.value
  }
  return {
    ok: true,
    value: {
      files: filesList,
      verifyCmd: verifyRaw ?? null,
      doneCriteria: doneList,
      taskType,
    },
  }
}

/** `--blocked-by`: the repeatable blocker-id list (possibly empty). */
export const parseBlockedBy = (
  args: Pick<ParsedArgs, 'multiFlags'>,
): readonly string[] => args.multiFlags['--blocked-by'] ?? []

/** `--tag`: the repeatable tag list, or undefined when none were passed. */
export const parseTags = (
  args: Pick<ParsedArgs, 'multiFlags'>,
): string[] | undefined => {
  const tags = args.multiFlags['--tag']
  return tags && tags.length > 0 ? tags : undefined
}
